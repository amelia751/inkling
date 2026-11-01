package dispatch_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"studio.local/pipeline/internal/dispatch"
	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel"
	"studio.local/pipeline/internal/kernel/kernelfake"
	"studio.local/pipeline/internal/testdb"
	"studio.local/pipeline/internal/testenv"
)

func TestKeyRoundTrip(t *testing.T) {
	k := dispatch.Key{RunID: "run_1", StepID: "inspect"}
	if k.String() != "run_1/inspect/0" {
		t.Fatal(k.String())
	}
	got, ok := dispatch.ParseKey(k.String())
	if !ok || got.RunID != "run_1" || got.PartitionID != "0" {
		t.Fatalf("%+v %v", got, ok)
	}
	if w := dispatch.Resolve("import-abc"); w != nil {
		t.Fatalf("foreign key resolved to %v", w)
	}
	if w := dispatch.Resolve("run_1/inspect/3"); len(w) != 2 || w[0] != "run_1/inspect/3" || w[1] != "run_1" {
		t.Fatalf("%v", w)
	}
}

// stepWorkflow dispatches one job per run, keyed by the run (workflow) ID.
func stepWorkflow(k dispatch.Kernel, pollAfter time.Duration) engine.WorkflowFunc {
	return engine.Typed(func(ctx engine.Context, ws string) (dispatch.Result, error) {
		r, err := dispatch.Run(ctx, k, dispatch.Job{Key: dispatch.Key{RunID: ctx.WorkflowID(), StepID: "inspect"},
			WorkspaceID: ws, Kind: "inspect", InputRef: "blob://in/" + ctx.WorkflowID()}, dispatch.Options{PollAfter: pollAfter})
		if dispatch.IsJobError(err) {
			return r, nil // report the failed job as a result, for the test
		}
		return r, err
	})
}

func run(t *testing.T, e engine.Engine, id string) dispatch.Result {
	t.Helper()
	_, err := e.Start(context.Background(), engine.StartRequest{Workflow: "step", ID: id, Input: engine.Input("ws1")})
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.Await(context.Background(), id, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	r, err := engine.Decode[dispatch.Result](out)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDispatchEventPath(t *testing.T) {
	db := testdb.New(t)
	k := testenv.Kernel(t, kernelfake.Options{Workers: 2, LongPoll: time.Second, ClaimInterval: 20 * time.Millisecond,
		Work: func(j kernelfake.Job) kernelfake.Outcome {
			return kernelfake.Outcome{Duration: 50 * time.Millisecond, ResultRef: "blob://out/" + j.ID}
		}})
	e := testenv.Engine(t, db, "v1", "x1", 10)
	if err := e.RegisterWorkflow("step", stepWorkflow(testenv.Client(k), 30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown(5 * time.Second)
	c := testenv.StartConsumer(k, e, nil)
	defer c.Stop()

	start := time.Now()
	r := run(t, e, "run_a")
	if r.State != kernel.StateSucceeded || r.Polls != 0 || r.ResultRef == "" || r.Attempts != 1 {
		t.Fatalf("result %+v", r)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %s: the event should wake the workflow, not the poll", d)
	}
	if n := len(k.Jobs()); n != 1 || k.Jobs()[0].IdempotencyKey != "run_a/inspect/0" {
		t.Fatalf("jobs %+v", k.Jobs())
	}
}

func TestDispatchKernelOwnsRetries(t *testing.T) {
	db := testdb.New(t)
	var calls atomic.Int32
	k := testenv.Kernel(t, kernelfake.Options{Workers: 1, LongPoll: time.Second, ClaimInterval: 20 * time.Millisecond, MaxAttempts: 3,
		Work: func(j kernelfake.Job) kernelfake.Outcome {
			calls.Add(1)
			if j.WorkspaceID == "ws1" && j.Attempts < 3 {
				return kernelfake.Outcome{Fail: true}
			}
			return kernelfake.Outcome{Fail: j.WorkspaceID == "ws-bad", ErrorClass: "invalid_input"}
		}})
	e := testenv.Engine(t, db, "v1", "x1", 10)
	cl := testenv.Client(k)
	if err := e.RegisterWorkflow("step", stepWorkflow(cl, 30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown(5 * time.Second)
	c := testenv.StartConsumer(k, e, nil)
	defer c.Stop()

	r := run(t, e, "run_retry")
	if r.State != kernel.StateSucceeded || r.Attempts != 3 {
		t.Fatalf("result %+v: want success on the kernel's 3rd attempt", r)
	}
	// Permanent failure: the job's final failure comes back as a JobError, once.
	_, err := e.Start(context.Background(), engine.StartRequest{Workflow: "step", ID: "run_bad", Input: engine.Input("ws-bad")})
	if err != nil {
		t.Fatal(err)
	}
	out, err := e.Await(context.Background(), "run_bad", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	bad, _ := engine.Decode[dispatch.Result](out)
	if bad.State != kernel.StateFailed || bad.ErrorClass != "invalid_input" || bad.Attempts != 3 {
		t.Fatalf("bad result %+v", bad)
	}
	if n := len(k.Jobs()); n != 2 {
		t.Fatalf("%d jobs: the pipeline must not re-enqueue", n)
	}
	if calls.Load() != 6 {
		t.Fatalf("%d attempts, want 3+3", calls.Load())
	}
}

func TestDispatchLostEventFallsBackToPoll(t *testing.T) {
	db := testdb.New(t)
	k := testenv.Kernel(t, kernelfake.Options{Workers: 1, LongPoll: time.Second, ClaimInterval: 20 * time.Millisecond,
		DropEvent: func(kernel.Event) bool { return true }})
	e := testenv.Engine(t, db, "v1", "x1", 10)
	if err := e.RegisterWorkflow("step", stepWorkflow(testenv.Client(k), 400*time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown(5 * time.Second)
	c := testenv.StartConsumer(k, e, nil)
	defer c.Stop()
	r := run(t, e, "run_lost")
	if r.State != kernel.StateSucceeded || r.Polls < 1 {
		t.Fatalf("result %+v: want success through a status read", r)
	}
}

// TestDispatchRecoveryNoDuplicateJobs: the pipeline stops while its job runs; the job
// finishes meanwhile; a restarted executor resumes the wait (it doesn't re-enqueue) and the
// replayed feed wakes it. This is the §7 recovery gate, in process (tests/chaos kills a
// real process).
func TestDispatchRecoveryNoDuplicateJobs(t *testing.T) {
	db := testdb.New(t)
	release := make(chan struct{})
	k := testenv.Kernel(t, kernelfake.Options{Workers: 1, LongPoll: time.Second, ClaimInterval: 20 * time.Millisecond,
		Work: func(kernelfake.Job) kernelfake.Outcome { <-release; return kernelfake.Outcome{ResultRef: "blob://r"} }})
	cl := testenv.Client(k)
	cur := &triggersCursor{}
	e1 := testenv.Engine(t, db, "v1", "x1", 10)
	if err := e1.RegisterWorkflow("step", stepWorkflow(cl, 30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := e1.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	c1 := testenv.StartConsumer(k, e1, cur)
	if _, err := e1.Start(context.Background(), engine.StartRequest{Workflow: "step", ID: "run_r", Input: engine.Input("ws1")}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { j := k.Jobs(); return len(j) == 1 && j[0].State == kernel.StateRunning })
	c1.Stop()
	_ = e1.Shutdown(5 * time.Second)
	close(release) // the job finishes while no pipeline is up
	waitFor(t, func() bool { return k.Jobs()[0].State == kernel.StateSucceeded })

	e2 := testenv.Engine(t, db, "v1", "x1", 10)
	if err := e2.RegisterWorkflow("step", stepWorkflow(cl, 30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := e2.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e2.Shutdown(5 * time.Second)
	c2 := testenv.StartConsumer(k, e2, cur)
	defer c2.Stop()
	out, err := e2.Await(context.Background(), "run_r", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	r, _ := engine.Decode[dispatch.Result](out)
	if r.State != kernel.StateSucceeded || len(k.Jobs()) != 1 {
		t.Fatalf("result %+v, %d jobs (want 1)", r, len(k.Jobs()))
	}
	// A stop between the enqueue's HTTP call and its checkpoint re-sends the POST on
	// recovery; the idempotency key keeps that to one job, which is the gate.
	t.Logf("enqueue calls: %d (jobs: %d)", k.Requests()["POST /api/v1/service/jobs"], len(k.Jobs()))
}

type triggersCursor struct{ v atomic.Value }

func (c *triggersCursor) Load(context.Context) (string, error) {
	s, _ := c.v.Load().(string)
	return s, nil
}
func (c *triggersCursor) Save(_ context.Context, s string) error { c.v.Store(s); return nil }

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRunRejectsForeignWaiter(t *testing.T) {
	db := testdb.New(t)
	e := testenv.Engine(t, db, "v1", "x1", 5)
	var got error
	if err := e.RegisterWorkflow("bad", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
		_, got = dispatch.Run(ctx, nil, dispatch.Job{Key: dispatch.Key{RunID: "other", StepID: "s"}}, dispatch.Options{})
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown(5 * time.Second)
	if _, err := e.Start(context.Background(), engine.StartRequest{Workflow: "bad", ID: "mine"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Await(context.Background(), "mine", time.Minute); err != nil {
		t.Fatal(err)
	}
	if got == nil || errors.Is(got, context.Canceled) {
		t.Fatalf("want a waiter-convention error, got %v", got)
	}
}
