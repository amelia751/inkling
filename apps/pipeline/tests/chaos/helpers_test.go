// Package chaos holds the Milestone 0 decisive tests (docs/pipeline.md §19 Stage 0,
// todo12 §4 item 6, gates in todo12 §7), against the real DBOS engine, a real Postgres and
// the in-process fake kernel (internal/kernel/kernelfake) with both fairness gates:
//
//   - TestDeployWithPendingWork: runs on version A (mid-step, queued, awaiting review),
//     deploy B, retire A at the drain deadline; nothing lost or published twice;
//   - TestFanOutWithCompetingWorkspace: A starts 10,000 tasks, then B starts 20;
//   - TestDatabaseContention: checkpoint load while versioning-like commits and API-like
//     transactions run on the same instance; reports the §7 database signals;
//   - TestRecoveryAfterKill: a pipeline process is SIGKILLed mid-step and restarted.
//
// Run with `pnpm --filter @studio/pipeline test:chaos`. They need
// <envPrefix>PIPELINE_TEST_DATABASE_URL (a role that may create databases) and skip
// without it. <envPrefix>PIPELINE_CHAOS_FANOUT scales the fan-out (default 10000).
// Every measured number is logged on a line starting "GATE".
package chaos_test

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/pipeline/internal/config"
	"studio.local/pipeline/internal/testdb"
)

func envInt(key string, def int) int {
	n, _ := config.LoadNaming()
	if v := config.Env(n, key); v != "" {
		if i, err := strconv.Atoi(v); err == nil && i > 0 {
			return i
		}
	}
	return def
}

func gate(t *testing.T, format string, args ...any) {
	t.Helper()
	t.Logf("GATE "+format, args...)
}

func pool(t *testing.T, url string, max int32) *pgxpool.Pool {
	t.Helper()
	pc, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	pc.MaxConns = max
	p, err := pgxpool.NewWithConfig(context.Background(), pc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func newDB(t *testing.T) string { return testdb.New(t) }

func exec(t *testing.T, p *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := p.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// latencies collects durations from many goroutines.
type latencies struct {
	mu sync.Mutex
	d  []time.Duration
}

func (l *latencies) add(d time.Duration) { l.mu.Lock(); l.d = append(l.d, d); l.mu.Unlock() }

func (l *latencies) pct(p float64) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.d) == 0 {
		return 0
	}
	s := slices.Clone(l.d)
	slices.Sort(s)
	return s[min(len(s)-1, int(float64(len(s))*p))]
}

func (l *latencies) n() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.d) }

func (l *latencies) String() string {
	return fmt.Sprintf("n=%d p50=%s p95=%s p99=%s", l.n(), round(l.pct(.50)), round(l.pct(.95)), round(l.pct(.99)))
}

func round(d time.Duration) time.Duration {
	if d > 10*time.Millisecond {
		return d.Round(time.Millisecond)
	}
	return d.Round(10 * time.Microsecond)
}

func waitUntil(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
