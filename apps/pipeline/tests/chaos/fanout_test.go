package chaos_test

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"studio.local/pipeline/internal/dispatch"
	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel"
	"studio.local/pipeline/internal/kernel/kernelfake"
	"studio.local/pipeline/internal/testenv"
)

// TestFanOutWithCompetingWorkspace (P§19 Stage 0 test 2, §7 gates "B's first task starts
// within one claim cycle of a slot freeing" and "B's 20 tasks finish within 2× their time on
// an idle system"). Each task is a workflow on a partitioned queue (the pipeline gate:
// PartitionConcurrency per workspace) that runs one kernel job (the kernel gate: a
// per-workspace running cap per resource class). Workspace A fans out N tasks
// (<envPrefix>PIPELINE_CHAOS_FANOUT, default 10000); once A saturates its share, B starts 20.
//
// The per-workspace cap is what makes the 2× target reachable: B under contention gets
// min(cap, workers-cap) slots and B idle gets cap, so a cap above half the pool lets one
// workspace squeeze the next (measured: cap 6 of 8 gave B 3.2× its idle time).
func TestFanOutWithCompetingWorkspace(t *testing.T) {
	n := envInt("PIPELINE_CHAOS_FANOUT", 10000)
	const (
		bTasks        = 20
		workers       = 8                      // kernel worker slots
		capPerWS      = workers / 2            // kernel gate: running cpu jobs per workspace (see below)
		partitionCap  = 50                     // pipeline gate: in-flight workflows per workspace
		claimInterval = 100 * time.Millisecond // the kernel's claim cycle
		jobTime       = 50 * time.Millisecond
	)
	ctx := context.Background()
	k := testenv.Kernel(t, kernelfake.Options{Workers: workers, ClaimInterval: claimInterval, LongPoll: 5 * time.Second,
		Caps: map[string]int{kernel.ClassCPU: capPerWS},
		Work: func(kernelfake.Job) kernelfake.Outcome {
			return kernelfake.Outcome{Duration: jobTime, ResultRef: "blob://r"}
		}})
	kc := testenv.Client(k)
	db := newDB(t)
	e := testenv.Engine(t, db, "wf-1", "pipeline-0", 20)
	if err := e.RegisterQueue(engine.QueueSpec{Name: "tasks", PartitionConcurrency: engine.Limit(partitionCap), PollInterval: 100 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if err := e.RegisterWorkflow("task", engine.Typed(func(ctx engine.Context, ws string) (string, error) {
		r, err := dispatch.Run(ctx, kc, dispatch.Job{Key: dispatch.Key{RunID: ctx.WorkflowID(), StepID: "map"}, WorkspaceID: ws,
			Kind: "map", InputRef: "blob://in/" + ctx.WorkflowID()}, dispatch.Options{PollAfter: 30 * time.Second})
		return r.ResultRef, err
	})); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = e.Shutdown(10 * time.Second) }()
	c := testenv.StartConsumer(k, e, nil)
	defer c.Stop()

	start := func(prefix, ws string, count, par int) []string {
		ids := make([]string, count)
		for i := range ids {
			ids[i] = fmt.Sprintf("%s-%05d", prefix, i)
		}
		var wg sync.WaitGroup
		var next atomic.Int64
		for range par {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := next.Add(1) - 1; i < int64(count); i = next.Add(1) - 1 {
					if _, err := e.Start(ctx, engine.StartRequest{Workflow: "task", ID: ids[i], Queue: "tasks", PartitionKey: ws, Input: engine.Input(ws)}); err != nil {
						t.Errorf("start %s: %v", ids[i], err)
						return
					}
				}
			}()
		}
		wg.Wait()
		return ids
	}
	awaitAll := func(ids []string) time.Time {
		var last time.Time
		for _, id := range ids {
			if _, err := e.Await(ctx, id, 30*time.Minute); err != nil {
				t.Fatalf("%s: %v", id, err)
			}
		}
		for _, id := range ids {
			info, err := e.Get(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			last = later(last, info.CompletedAt)
		}
		return last
	}

	// Baseline: B's 20 tasks on an idle system.
	t0 := time.Now()
	idleIDs := start("idle", "wsB", bTasks, 4)
	idleEnd := awaitAll(idleIDs)
	idle := idleEnd.Sub(t0)
	// A fans out, then B arrives once A holds its full kernel share.
	aStart := time.Now()
	aIDs := start("A", "wsA", n, 16)
	aEnqueued := time.Since(aStart)
	waitUntil(t, 5*time.Minute, "A to saturate its kernel share", func() bool {
		running := 0
		for _, j := range k.Jobs() {
			if j.WorkspaceID == "wsA" && j.State == kernel.StateRunning {
				running++
			}
		}
		return running >= capPerWS
	})
	bStart := time.Now()
	bIDs := start("B", "wsB", bTasks, 4)
	bEnd := awaitAll(bIDs)
	bTook := bEnd.Sub(bStart)
	aDoneAtB := 0
	for _, j := range k.Jobs() {
		if j.WorkspaceID == "wsA" && j.State == kernel.StateSucceeded {
			aDoneAtB++
		}
	}

	// Pipeline gate: B's workflows leave the queue at once although A has thousands queued.
	var dequeue latencies
	for _, id := range bIDs {
		info, _ := e.Get(ctx, id)
		dequeue.add(info.StartedAt.Sub(info.CreatedAt))
	}
	// Kernel gate: B's jobs are claimed although A's backlog is older.
	var claim, afterFree latencies
	var firstB *kernelfake.Job
	jobs := k.Jobs()
	freed := k.Freed()
	for i := range jobs {
		j := &jobs[i]
		if j.WorkspaceID != "wsB" || !strings.HasPrefix(j.IdempotencyKey, "B-") {
			continue
		}
		claim.add(j.ClaimedAt[0].Sub(j.CreatedAt))
		// When the slot B took became free: the first release at or after the job's
		// creation, unless a slot was already idle (then the claim waited for nothing).
		if f := firstAtOrAfter(freed, j.CreatedAt); !f.IsZero() && f.Before(j.ClaimedAt[0]) {
			afterFree.add(j.ClaimedAt[0].Sub(f))
		} else {
			afterFree.add(0)
		}
		if firstB == nil || j.ClaimedAt[0].Before(firstB.ClaimedAt[0]) {
			firstB = j
		}
	}
	aEnd := awaitAll(aIDs)
	aTook := aEnd.Sub(aStart)
	var reclaimed int
	for _, j := range jobs {
		if j.WorkspaceID == "wsA" && len(j.ClaimedAt) > 1 {
			reclaimed++ // re-claims would mean lost leases; none expected
		}
	}
	var size int64
	_ = pool(t, db, 2).QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&size)

	firstStart := firstB.ClaimedAt[0].Sub(bStart)
	// The gate: B's first job is claimed within one claim cycle of a slot being available
	// to it (already idle when the job was created, or the first release after).
	slotAt := firstB.CreatedAt
	if f := firstAtOrAfter(freed, firstB.CreatedAt); !f.IsZero() && f.Before(firstB.ClaimedAt[0]) && runningAt(jobs, firstB.CreatedAt) >= workers {
		slotAt = f
	}
	firstWait := firstB.ClaimedAt[0].Sub(slotAt)
	gate(t, "fanout: scale A=%d tasks (+B %d); kernel %d workers, cap %d cpu/workspace, claim cycle %s, job %s; pipeline partition cap %d",
		n, bTasks, workers, capPerWS, claimInterval, jobTime, partitionCap)
	gate(t, "fanout: B idle-system time %s; B under A's fan-out %s (ratio %.2f, target ≤ 2.00); A had %d/%d done when B finished",
		idle.Round(time.Millisecond), bTook.Round(time.Millisecond), bTook.Seconds()/idle.Seconds(), aDoneAtB, n)
	gate(t, "fanout: B first kernel job started %s after B's first start, claimed %s after a slot was available to it (target ≤ one claim cycle = %s)",
		firstStart.Round(time.Millisecond), round(firstWait), claimInterval)
	gate(t, "fanout: all B jobs: claim delay %s; after the next slot release %s (later B jobs also wait on B's own cap)", &claim, &afterFree)
	gate(t, "fanout: B workflow dequeue delay (pipeline gate) %s", &dequeue)
	gate(t, "fanout: A enqueue of %d took %s; A all done in %s (%.0f tasks/s); re-claimed jobs %d; engine database %d MB (%.1f KB/workflow)",
		n, aEnqueued.Round(time.Millisecond), aTook.Round(time.Millisecond), float64(n)/aTook.Seconds(), reclaimed,
		size>>20, float64(size)/1024/float64(n+2*bTasks))

	if r := bTook.Seconds() / idle.Seconds(); r > 2 {
		t.Errorf("B took %.2f× its idle time (target ≤ 2×)", r)
	}
	if firstWait > claimInterval {
		t.Errorf("B's first job waited %s for a free slot (target ≤ one claim cycle, %s)", firstWait, claimInterval)
	}
}

// runningAt counts jobs running at instant at.
func runningAt(jobs []kernelfake.Job, at time.Time) int {
	n := 0
	for _, j := range jobs {
		for i, c := range j.ClaimedAt {
			end := j.FinishedAt
			if i+1 < len(j.ClaimedAt) {
				end = j.ClaimedAt[i+1]
			}
			if !c.After(at) && (end.IsZero() || end.After(at)) {
				n++
			}
		}
	}
	return n
}

func later(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func firstAtOrAfter(ts []time.Time, at time.Time) time.Time {
	for _, x := range ts {
		if !x.Before(at) {
			return x
		}
	}
	return time.Time{}
}
