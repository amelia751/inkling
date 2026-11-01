package chaos_test

import (
	"context"
	"testing"
	"time"

	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel/kernelfake"
	"studio.local/pipeline/internal/testenv"
)

// TestDeployWithPendingWork (P§19 Stage 0 test 1, §7 gate "0 lost runs, 0 double
// publishes; every stranded run forked or rerun"). Version A runs work: some runs finish
// and wait for review (no workflow waits for a human), some are mid-step, some are still
// queued. Version B is deployed beside A and takes new runs and approvals; duplicate
// approvals hit both. At the drain deadline A is retired and its unfinished workflows are
// forked onto B (engine.Drain). Every run must publish exactly once, with one kernel job
// per step.
func TestDeployWithPendingWork(t *testing.T) {
	ctx := context.Background()
	studio := pool(t, newDB(t), 10)
	exec(t, studio, toyDDL)
	engineDB := newDB(t)
	k := testenv.Kernel(t, kernelfake.Options{Workers: 4, ClaimInterval: 20 * time.Millisecond, LongPoll: 2 * time.Second,
		Work: func(kernelfake.Job) kernelfake.Outcome {
			return kernelfake.Outcome{Duration: 120 * time.Millisecond, ResultRef: "blob://r"}
		}})
	y := &toy{db: studio, k: testenv.Client(k), pollAfter: 2 * time.Second}

	const onA, onB = 40, 10
	a := testenv.Engine(t, engineDB, "wf-A", "pipeline-a-0", 10)
	y.register(t, a)
	if err := a.Launch(ctx); err != nil {
		t.Fatal(err)
	}
	ca := testenv.StartConsumer(k, a, nil)
	for i := range onA {
		y.startRun(t, a, runID("a", i), []string{"ws1", "ws2", "ws3"}[i%3])
	}
	waitUntil(t, 2*time.Minute, "some runs awaiting review on A", func() bool { return len(y.inState(t, "awaiting_review")) >= 6 })
	early := y.inState(t, "awaiting_review")[:3]
	for _, r := range early {
		y.approve(t, a, r) // approved while only A exists
	}

	// Deploy B beside A (the drain window): new runs and new approvals go to B.
	deployAt := time.Now()
	b := testenv.Engine(t, engineDB, "wf-B", "pipeline-b-0", 10)
	y.register(t, b)
	if err := b.Launch(ctx); err != nil {
		t.Fatal(err)
	}
	cb := testenv.StartConsumer(k, b, nil)
	defer cb.Stop()
	defer func() { _ = b.Shutdown(10 * time.Second) }()
	for i := range onB {
		y.startRun(t, b, runID("b", i), []string{"ws1", "ws2"}[i%2])
	}
	waiting := y.inState(t, "awaiting_review")
	var mid []string
	for _, r := range waiting {
		if !contains(early, r) && len(mid) < 3 {
			mid = append(mid, r)
		}
	}
	for _, r := range mid {
		y.approve(t, b, r) // the api delivers an approval twice: once to each version
		y.approve(t, a, r)
	}
	time.Sleep(300 * time.Millisecond)

	// Drain deadline: retire A with work still pending, then move what it left onto B.
	var aBefore struct{ pending, queued int }
	ws, _ := b.List(ctx, engine.ListFilter{AppVersions: []string{"wf-A"}, Statuses: []engine.Status{engine.StatusPending}})
	aBefore.pending = len(ws)
	ws, _ = b.List(ctx, engine.ListFilter{AppVersions: []string{"wf-A"}, Statuses: []engine.Status{engine.StatusEnqueued}})
	aBefore.queued = len(ws)
	ca.Stop()
	_ = a.Shutdown(5 * time.Second)
	retiredAt := time.Now()
	rep, err := engine.Drain(ctx, b, "wf-A", "wf-B", nil)
	if err != nil {
		t.Fatal(err)
	}
	// A second pass (a retried drain job) finds nothing new and forks nothing twice.
	rep2, err := engine.Drain(ctx, b, "wf-A", "wf-B", nil)
	if err != nil {
		t.Fatal(err)
	}
	drainedIn := time.Since(retiredAt)

	// Everything reaches review; then every run is approved (again for the early ones).
	waitUntil(t, 3*time.Minute, "every run proposed", func() bool {
		return y.count(t, `SELECT count(*) FROM chaos_runs WHERE state IN ('queued', 'running')`) == 0
	})
	for _, r := range y.inState(t, "awaiting_review") {
		y.approve(t, b, r)
	}
	for _, r := range append(early, mid...) {
		y.approve(t, b, r) // late duplicates of approvals already handled
	}
	waitUntil(t, 2*time.Minute, "every run published", func() bool {
		return y.count(t, `SELECT count(*) FROM chaos_runs WHERE state = 'published'`) == onA+onB
	})
	time.Sleep(500 * time.Millisecond) // let any duplicate publish land, if one could

	total := onA + onB
	published := y.count(t, `SELECT count(DISTINCT run_id) FROM chaos_publish_log`)
	publishes := y.count(t, `SELECT count(*) FROM chaos_publish_log`)
	lost := total - y.count(t, `SELECT count(*) FROM chaos_runs WHERE state = 'published'`)
	viaA := y.count(t, `SELECT count(*) FROM chaos_publish_log WHERE version = 'wf-A'`)
	jobs := k.Jobs()
	perKey := map[string]int{}
	for _, j := range jobs {
		perKey[j.WorkspaceID+"/"+j.IdempotencyKey]++
	}
	dupJobs := 0
	for _, n := range perKey {
		dupJobs += n - 1
	}
	stillA, _ := b.List(ctx, engine.ListFilter{AppVersions: []string{"wf-A"}, Statuses: []engine.Status{engine.StatusPending, engine.StatusEnqueued}})
	markedTwice := y.count(t, `SELECT count(*) FROM (SELECT run_id FROM chaos_effects GROUP BY run_id HAVING count(*) > 1) d`)

	gate(t, "deploy: runs=%d (A %d, B %d) lost=%d published=%d publish_effects=%d (double=%d) via_A=%d via_B=%d",
		total, onA, onB, lost, published, publishes, publishes-published, viaA, publishes-viaA)
	gate(t, "deploy: at retirement A had pending=%d queued=%d; drain forked=%d cancelled=%d skipped=%d in %s; second pass forked=%d (originals already cancelled)",
		aBefore.pending, aBefore.queued, len(rep.Forked), len(rep.Cancelled), len(rep.Skipped), drainedIn.Round(time.Millisecond), len(rep2.Forked))
	gate(t, "deploy: kernel jobs=%d for %d steps (duplicates=%d); runs whose first step re-ran=%d; A workflows left unfinished=%d; deploy→all published %s",
		len(jobs), 2*total, dupJobs, markedTwice, len(stillA), time.Since(deployAt).Round(time.Millisecond))

	if lost != 0 || publishes != published || published != total {
		t.Fatalf("lost %d, %d publish effects for %d runs", lost, publishes, published)
	}
	if dupJobs != 0 || len(jobs) != 2*total {
		t.Fatalf("%d kernel jobs for %d steps", len(jobs), 2*total)
	}
	if len(stillA) != 0 || len(rep2.Forked) != 0 {
		t.Fatalf("A left %d workflows; drain passes forked %d then %d", len(stillA), len(rep.Forked), len(rep2.Forked))
	}
	if aBefore.pending+aBefore.queued == 0 {
		t.Fatal("the scenario retired A with nothing pending: tune the timings")
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}
