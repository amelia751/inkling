//go:build chaos

package chaos_test

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	osexec "os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/pipeline/internal/config"
	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/testenv"
)

// TestDatabaseContention (P§19 Stage 0 test 3, the §7 "shared Cloud SQL thresholds"):
// API-like transactions (a SKIP LOCKED job queue: enqueue, claim, complete) and
// versioning-like commits (a commit row, 50 entries, a CAS on the branch head) run against
// database "studio" for a phase without pipelines and a phase with high-frequency DBOS
// checkpoints in an engine database on the same instance. Reported: API and versioning
// p95 change, DBOS checkpoint p95, engine share of tuple writes, engine connections against
// the pool budget, engine database growth, and (with <envPrefix>PIPELINE_CHAOS_PG_CONTAINER
// naming the local Postgres container) the instance's CPU.
// <envPrefix>PIPELINE_CHAOS_PHASE_SECONDS sets each phase's length (default 20).
func TestDatabaseContention(t *testing.T) {
	phase := time.Duration(envInt("PIPELINE_CHAOS_PHASE_SECONDS", 20)) * time.Second
	const (
		apiWorkers   = 16
		vcsWorkers   = 4
		workflows    = 200 // concurrent pipeline workflows
		enginePool   = 20  // the pipeline's engine pool (part of the role's CONNECTION LIMIT)
		stepsPerFlow = 100000
	)
	ctx := context.Background()
	studioURL := newDB(t)
	engineURL := newDB(t)
	studio := pool(t, studioURL, apiWorkers+vcsWorkers+4)
	exec(t, studio, `
CREATE TABLE api_jobs (id bigserial PRIMARY KEY, workspace text NOT NULL, state text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ON api_jobs (state, created_at);
CREATE TABLE vcs_heads (repo text PRIMARY KEY, head bigint NOT NULL);
CREATE TABLE vcs_commits (id bigserial PRIMARY KEY, repo text NOT NULL, parent bigint NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE vcs_entries (commit_id bigint NOT NULL, path text NOT NULL, digest text NOT NULL, PRIMARY KEY (commit_id, path));`)
	for i := range vcsWorkers {
		exec(t, studio, `INSERT INTO vcs_heads VALUES ($1, 0)`, fmt.Sprintf("repo-%d", i))
	}

	type load struct{ api, vcs latencies }
	runLoad := func(stop <-chan struct{}, l *load) *sync.WaitGroup {
		var wg sync.WaitGroup
		for w := range apiWorkers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					t0 := time.Now()
					if err := apiTx(ctx, studio, fmt.Sprintf("ws-%d", w%4)); err == nil {
						l.api.add(time.Since(t0))
					}
					time.Sleep(5 * time.Millisecond)
				}
			}()
		}
		for w := range vcsWorkers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					t0 := time.Now()
					if err := commitTx(ctx, studio, fmt.Sprintf("repo-%d", w)); err == nil {
						l.vcs.add(time.Since(t0))
					}
					time.Sleep(20 * time.Millisecond)
				}
			}()
		}
		return &wg
	}
	cpu := newCPUSampler()

	// Phase 1: API and versioning load alone.
	var base load
	stop := make(chan struct{})
	cpu.start()
	wg := runLoad(stop, &base)
	time.Sleep(phase)
	close(stop)
	wg.Wait()
	cpuBase := cpu.stop()

	// Phase 2..n: the same load plus workflows checkpointing at a target rate, swept from
	// a realistic rate (each step is a kernel job lasting seconds) to unthrottled.
	e := testenv.Engine(t, engineURL, "wf-1", "pipeline-0", enginePool)
	var checkpoint atomic.Pointer[latencies]
	checkpoint.Store(&latencies{})
	var steps atomic.Int64
	var gap atomic.Int64 // per-workflow pause between steps, ns
	pipelineStop := make(chan struct{})
	if err := e.RegisterWorkflow("checkpoints", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
		for i := range stepsPerFlow {
			select {
			case <-pipelineStop:
				return nil, nil
			case <-time.After(jitter(time.Duration(gap.Load()))): // test-only pacing, not durable
			}
			var fnDone time.Time
			if _, err := ctx.Step(fmt.Sprintf("s%d", i), func(context.Context) (json.RawMessage, error) {
				fnDone = time.Now()
				return json.RawMessage(`{"uri":"blob://pipeline/run/step/0/out","sha256":"0f343b0931126a20f133d67c2b018a3b"}`), nil
			}); err != nil {
				return nil, err
			}
			checkpoint.Load().add(time.Since(fnDone)) // the step-completion write, end to end
			steps.Add(1)
		}
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = e.Shutdown(10 * time.Second) }()
	engineSizeBefore := dbSize(t, studio, engineURL)
	maxEngineConns := atomic.Int64{}
	connStop := make(chan struct{})
	go func() {
		for {
			select {
			case <-connStop:
				return
			case <-time.After(250 * time.Millisecond):
			}
			if n := connections(studio, engineURL); n > maxEngineConns.Load() {
				maxEngineConns.Store(n)
			}
		}
	}()
	rates := []int{100, 500, 0} // target checkpoints/s; 0 = unthrottled
	gap.Store(int64(time.Duration(workflows) * time.Second / time.Duration(rates[0])))
	for i := range workflows {
		if _, err := e.Start(ctx, engine.StartRequest{Workflow: "checkpoints", ID: fmt.Sprintf("cp-%03d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	pct := func(a, b time.Duration) float64 { return 100 * (b.Seconds() - a.Seconds()) / a.Seconds() }
	gate(t, "contention: phases of %s; api %d workers, versioning %d committers (50 entries/commit), %d workflows on a %d-connection engine pool",
		phase, apiWorkers, vcsWorkers, workflows, enginePool)
	gate(t, "contention: baseline before (no pipelines): api %s; versioning %s; instance CPU %s", &base.api, &base.vcs, cpuBase)
	totalSteps := int64(0)
	var sweep []struct {
		label    string
		api, vcs *latencies
	}
	for _, rate := range rates {
		if rate > 0 {
			gap.Store(int64(time.Duration(workflows) * time.Second / time.Duration(rate)))
		} else {
			gap.Store(0)
		}
		time.Sleep(time.Second) // let the new pace settle
		checkpoint.Store(&latencies{})
		steps.Store(0)
		engineWrites0 := tupleWritesOf(t, studio, engineURL)
		studioWrites0 := tupleWritesOf(t, studio, studioURL)
		var with load
		stop := make(chan struct{})
		cpu.start()
		wg := runLoad(stop, &with)
		time.Sleep(phase)
		close(stop)
		wg.Wait()
		cpuPipe := cpu.stop()
		engineWrites := tupleWritesOf(t, studio, engineURL) - engineWrites0
		studioWrites := tupleWritesOf(t, studio, studioURL) - studioWrites0
		share := float64(engineWrites) / float64(max(1, engineWrites+studioWrites))
		cp := checkpoint.Load()
		totalSteps += steps.Load()
		label := fmt.Sprintf("%d/s target", rate)
		if rate == 0 {
			label = "unthrottled"
		}
		gate(t, "contention [%s]: %.0f checkpoints/s, checkpoint latency %s (threshold p95 50ms)", label, float64(steps.Load())/phase.Seconds(), cp)
		gate(t, "contention [%s]: engine share of tuple writes %.0f%% (threshold 33%%); instance CPU %s (threshold 60%% of the instance)", label, 100*share, cpuPipe)
		sweep = append(sweep, struct {
			label    string
			api, vcs *latencies
		}{label, &with.api, &with.vcs})
	}
	close(pipelineStop)
	close(connStop)
	for i := range workflows {
		_, _ = e.Await(ctx, fmt.Sprintf("cp-%03d", i), time.Minute)
	}
	// A second baseline after the sweep brackets the host's noise; deltas use the lower one.
	var base2 load
	stop2 := make(chan struct{})
	cpu.start()
	wg2 := runLoad(stop2, &base2)
	time.Sleep(phase)
	close(stop2)
	wg2.Wait()
	cpuBase2 := cpu.stop()
	gate(t, "contention: baseline after (no pipelines): api %s; versioning %s; instance CPU %s", &base2.api, &base2.vcs, cpuBase2)
	apiRef, vcsRef := min(base.api.pct(.95), base2.api.pct(.95)), min(base.vcs.pct(.95), base2.vcs.pct(.95))
	for _, r := range sweep {
		gate(t, "contention [%s]: api p95 %s (%+.1f%% vs the lower baseline %s), versioning p95 %s (%+.1f%% vs %s) (threshold +10%%); api %s; versioning %s",
			r.label, round(r.api.pct(.95)), pct(apiRef, r.api.pct(.95)), round(apiRef), round(r.vcs.pct(.95)), pct(vcsRef, r.vcs.pct(.95)), round(vcsRef), r.api, r.vcs)
	}
	engineSizeAfter := dbSize(t, studio, engineURL)
	gate(t, "contention: engine connections max %d (pool budget %d); engine database grew %d MB for %d checkpoints (%.2f KB each; threshold 50 GB after retention)",
		maxEngineConns.Load(), enginePool, (engineSizeAfter-engineSizeBefore)>>20, totalSteps, float64(engineSizeAfter-engineSizeBefore)/1024/float64(max(1, totalSteps)))
	if maxEngineConns.Load() > enginePool+2 { // + DBOS's notification listener
		t.Errorf("engine used %d connections, budget %d", maxEngineConns.Load(), enginePool)
	}
}

// jitter spreads d over [0.5d, 1.5d) so paced workflows don't step in lockstep.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return d/2 + time.Duration(rand.Int64N(int64(d)))
}

func apiTx(ctx context.Context, p *pgxpool.Pool, ws string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `INSERT INTO api_jobs (workspace, state, payload) VALUES ($1, 'queued', '{"tool":"inspect"}')`, ws); err != nil {
		return err
	}
	var id int64
	if err := tx.QueryRow(ctx, `SELECT id FROM api_jobs WHERE state = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE api_jobs SET state = 'succeeded', updated_at = now() WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func commitTx(ctx context.Context, p *pgxpool.Pool, repo string) error {
	tx, err := p.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var head int64
	if err := tx.QueryRow(ctx, `SELECT head FROM vcs_heads WHERE repo = $1`, repo).Scan(&head); err != nil {
		return err
	}
	var id int64
	if err := tx.QueryRow(ctx, `INSERT INTO vcs_commits (repo, parent) VALUES ($1, $2) RETURNING id`, repo, head).Scan(&id); err != nil {
		return err
	}
	rows := make([][]any, 50)
	for i := range rows {
		rows[i] = []any{id, fmt.Sprintf("items/%06d.dcm", i), fmt.Sprintf("sha256:%064d", id*100+int64(i))}
	}
	if _, err := tx.CopyFrom(ctx, []string{"vcs_entries"}, []string{"commit_id", "path", "digest"}, pgx.CopyFromRows(rows)); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE vcs_heads SET head = $3 WHERE repo = $1 AND head = $2`, repo, head, id) // expected_head CAS
	if err != nil || tag.RowsAffected() != 1 {
		return fmt.Errorf("cas: %v", err)
	}
	return tx.Commit(ctx)
}

func dbName(url string) string {
	s := url[strings.LastIndex(url, "/")+1:]
	if i := strings.Index(s, "?"); i >= 0 {
		s = s[:i]
	}
	return s
}

func dbSize(t *testing.T, p *pgxpool.Pool, url string) int64 {
	t.Helper()
	var n int64
	if err := p.QueryRow(context.Background(), `SELECT pg_database_size($1)`, dbName(url)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func connections(p *pgxpool.Pool, url string) int64 {
	var n int64
	_ = p.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE datname = $1`, dbName(url)).Scan(&n)
	return n
}

func tupleWritesOf(t *testing.T, p *pgxpool.Pool, url string) int64 {
	t.Helper()
	var n int64
	if _, err := p.Exec(context.Background(), `SELECT pg_stat_clear_snapshot()`); err != nil {
		t.Fatal(err)
	}
	if err := p.QueryRow(context.Background(), `SELECT tup_inserted + tup_updated + tup_deleted FROM pg_stat_database WHERE datname = $1`, dbName(url)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// cpuSampler samples the Postgres container's CPU through `docker stats` when
// <envPrefix>PIPELINE_CHAOS_PG_CONTAINER names it. Docker reports percent of one host core.
type cpuSampler struct {
	container string
	mu        sync.Mutex
	samples   []float64
	done      chan struct{}
	wg        sync.WaitGroup
}

func newCPUSampler() *cpuSampler {
	n, _ := config.LoadNaming()
	return &cpuSampler{container: config.Env(n, "PIPELINE_CHAOS_PG_CONTAINER")}
}

func (c *cpuSampler) start() {
	c.samples = nil
	c.done = make(chan struct{})
	if c.container == "" {
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		for {
			out, err := osexec.Command("docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}", c.container).Output() //nolint:gosec // test-only, operator-named container
			if err == nil {
				if v, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(string(out)), "%"), 64); err == nil {
					c.mu.Lock()
					c.samples = append(c.samples, v)
					c.mu.Unlock()
				}
			}
			select {
			case <-c.done:
				return
			case <-time.After(time.Second):
			}
		}
	}()
}

func (c *cpuSampler) stop() string {
	close(c.done)
	c.wg.Wait()
	if c.container == "" {
		return "not sampled (set PIPELINE_CHAOS_PG_CONTAINER)"
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.samples) == 0 {
		return "no samples"
	}
	sum, peak := 0.0, 0.0
	for _, v := range c.samples {
		sum += v
		peak = max(peak, v)
	}
	cores := 1.0
	if out, err := osexec.Command("docker", "info", "--format", "{{.NCPU}}").Output(); err == nil {
		if n, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64); err == nil && n > 0 {
			cores = n
		}
	}
	mean := sum / float64(len(c.samples))
	return fmt.Sprintf("mean %.0f%% peak %.0f%% of one core = %.0f%% / %.0f%% of the %.0f-core instance (%d samples)",
		mean, peak, mean/cores, peak/cores, cores, len(c.samples))
}
