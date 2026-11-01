// Package enginetest is the engine.Engine conformance suite (docs/pipeline.md §5.5): retry,
// cancel, messages, recovery after restart, recovery after an application-version change,
// idempotent start by workflow ID (also on a partitioned queue, E5), deadlines, child
// workflows and partitioned-queue fairness. Every implementation must pass it; run it from
// the implementation's tests with Run.
package enginetest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"studio.local/pipeline/internal/engine"
)

// Harness builds engines for the suite.
type Harness struct {
	// NewDB returns a fresh, empty engine database for one test.
	NewDB func(t testing.TB) string
	// New returns an unlaunched engine on db. Several engines may share a db (restarts,
	// version changes, replicas).
	New func(t testing.TB, db, appVersion, executorID string) (engine.Engine, error)
}

// Run runs the conformance suite.
func Run(t *testing.T, h Harness) {
	s := &suite{h: h}
	t.Run("StepRetry", s.stepRetry)
	t.Run("NoRetryByDefault", s.noRetryByDefault)
	t.Run("IdempotentStart", s.idempotentStart)
	t.Run("IdempotentStartOnPartitionedQueue", s.idempotentStartPartitioned)
	t.Run("SendRecv", s.sendRecv)
	t.Run("Cancel", s.cancel)
	t.Run("Deadline", s.deadline)
	t.Run("ChildWorkflow", s.child)
	t.Run("RecoveryAfterRestart", s.recoveryAfterRestart)
	t.Run("RecoveryAfterVersionChange", s.recoveryAfterVersionChange)
	t.Run("SendReachesForks", s.sendReachesForks)
	t.Run("ListAndSteps", s.listAndSteps)
	t.Run("Purge", s.purge)
	t.Run("PartitionedQueueFairness", s.fairness)
}

type suite struct{ h Harness }

const waitLong = 60 * time.Second

func (s *suite) engine(t *testing.T, db, ver, exec string, reg func(e engine.Engine)) engine.Engine {
	t.Helper()
	e, err := s.h.New(t, db, ver, exec)
	if err != nil {
		t.Fatalf("new engine: %v", err)
	}
	reg(e)
	if err := e.Launch(context.Background()); err != nil {
		t.Fatalf("launch: %v", err)
	}
	return e
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func shutdown(t *testing.T, e engine.Engine) {
	t.Helper()
	if err := e.Shutdown(10 * time.Second); err != nil {
		t.Logf("shutdown: %v", err)
	}
}

func (s *suite) stepRetry(t *testing.T) {
	db := s.h.NewDB(t)
	var runs atomic.Int32
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("retry", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			return ctx.Step("flaky", func(context.Context) (json.RawMessage, error) {
				if runs.Add(1) < 3 {
					return nil, errors.New("transient")
				}
				return json.RawMessage(`"ok"`), nil
			}, engine.WithRetries(3, 10*time.Millisecond))
		}))
	})
	defer shutdown(t, e)
	id, err := e.Start(context.Background(), engine.StartRequest{Workflow: "retry", ID: "retry-1"})
	must(t, err)
	out, err := e.Await(context.Background(), id, waitLong)
	must(t, err)
	if string(out) != `"ok"` || runs.Load() != 3 {
		t.Fatalf("out %s after %d runs, want \"ok\" after 3", out, runs.Load())
	}
}

func (s *suite) noRetryByDefault(t *testing.T) {
	db := s.h.NewDB(t)
	var runs atomic.Int32
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("once", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			return ctx.Step("fails", func(context.Context) (json.RawMessage, error) {
				runs.Add(1)
				return nil, errors.New("permanent")
			})
		}))
	})
	defer shutdown(t, e)
	id, err := e.Start(context.Background(), engine.StartRequest{Workflow: "once"})
	must(t, err)
	if _, err := e.Await(context.Background(), id, waitLong); err == nil {
		t.Fatal("want the step's error")
	}
	info, err := e.Get(context.Background(), id)
	must(t, err)
	if info.Status != engine.StatusError || runs.Load() != 1 {
		t.Fatalf("status %s after %d runs, want error after 1", info.Status, runs.Load())
	}
}

func (s *suite) idempotentStart(t *testing.T) {
	db := s.h.NewDB(t)
	var runs atomic.Int32
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("idem", func(ctx engine.Context, in json.RawMessage) (json.RawMessage, error) {
			runs.Add(1)
			return in, nil
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	a, err := e.Start(ctx, engine.StartRequest{Workflow: "idem", ID: "run-7", Input: json.RawMessage(`1`)})
	must(t, err)
	_, err = e.Await(ctx, a, waitLong)
	must(t, err)
	b, err := e.Start(ctx, engine.StartRequest{Workflow: "idem", ID: "run-7", Input: json.RawMessage(`1`)})
	must(t, err)
	out, err := e.Await(ctx, b, waitLong)
	must(t, err)
	if a != b || string(out) != "1" || runs.Load() != 1 {
		t.Fatalf("ids %s/%s, out %s, runs %d: want one run", a, b, out, runs.Load())
	}
}

func (s *suite) idempotentStartPartitioned(t *testing.T) {
	db := s.h.NewDB(t)
	var runs atomic.Int32
	release := make(chan struct{})
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterQueue(engine.QueueSpec{Name: "steps", PartitionConcurrency: engine.Limit(1), PollInterval: 50 * time.Millisecond}))
		must(t, e.RegisterWorkflow("task", func(ctx engine.Context, in json.RawMessage) (json.RawMessage, error) {
			runs.Add(1)
			_, err := ctx.Step("hold", func(c context.Context) (json.RawMessage, error) {
				select {
				case <-release:
				case <-c.Done():
					return nil, c.Err()
				}
				return nil, nil
			})
			return in, err
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	// The same ID started three times while the first is still queued or running: one run.
	var ids []string
	for range 3 {
		id, err := e.Start(ctx, engine.StartRequest{Workflow: "task", ID: "ws1/run-1/step-a/0", Queue: "steps", PartitionKey: "ws1", Input: json.RawMessage(`"a"`)})
		must(t, err)
		ids = append(ids, id)
	}
	close(release)
	for _, id := range ids {
		_, err := e.Await(ctx, id, waitLong)
		must(t, err)
	}
	if ids[0] != ids[1] || ids[1] != ids[2] || runs.Load() != 1 {
		t.Fatalf("ids %v, runs %d: want one workflow, one run", ids, runs.Load())
	}
}

func (s *suite) sendRecv(t *testing.T) {
	db := s.h.NewDB(t)
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("inbox", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			var got []string
			for {
				m, ok, err := engine.Recv[string](ctx, "job:1", 2*time.Second)
				if err != nil {
					return nil, err
				}
				if !ok {
					break // timeout: no more messages
				}
				got = append(got, m)
			}
			return json.Marshal(got)
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	// Sent before the workflow exists would fail; send right after start (before or during
	// Recv), twice with one key and once with another: two deliveries.
	id, err := e.Start(ctx, engine.StartRequest{Workflow: "inbox", ID: "inbox-1"})
	must(t, err)
	must(t, e.Send(ctx, id, "job:1", engine.Input("a"), "evt-1"))
	must(t, e.Send(ctx, id, "job:1", engine.Input("a"), "evt-1"))
	must(t, e.Send(ctx, id, "job:1", engine.Input("b"), "evt-2"))
	must(t, e.Send(ctx, id, "other", engine.Input("x"), "evt-3"))
	out, err := e.Await(ctx, id, waitLong)
	must(t, err)
	if string(out) != `["a","b"]` {
		t.Fatalf("got %s, want [\"a\",\"b\"] (idempotent per key, per topic)", out)
	}
	if err := e.Send(ctx, "no-such-workflow", "job:1", engine.Input("a"), "k"); err == nil {
		t.Fatal("send to a missing workflow should fail")
	}
}

func (s *suite) cancel(t *testing.T) {
	db := s.h.NewDB(t)
	var after atomic.Bool
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("waits", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			if _, _, err := ctx.Recv("never", 30*time.Second); err != nil {
				return nil, err
			}
			_, err := ctx.Step("after", func(context.Context) (json.RawMessage, error) { after.Store(true); return nil, nil })
			return nil, err
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	id, err := e.Start(ctx, engine.StartRequest{Workflow: "waits", ID: "cancel-1"})
	must(t, err)
	time.Sleep(300 * time.Millisecond)
	must(t, e.Cancel(ctx, id))
	_, err = e.Await(ctx, id, waitLong)
	if !errors.Is(err, engine.ErrCancelled) {
		t.Fatalf("await: %v, want ErrCancelled", err)
	}
	time.Sleep(200 * time.Millisecond)
	info, err := e.Get(ctx, id)
	must(t, err)
	if info.Status != engine.StatusCancelled || after.Load() {
		t.Fatalf("status %s, later step ran: %v", info.Status, after.Load())
	}
}

func (s *suite) deadline(t *testing.T) {
	db := s.h.NewDB(t)
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("slow", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			return nil, ctx.Sleep(20 * time.Second)
		}))
		must(t, e.RegisterWorkflow("fast", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			if err := ctx.Sleep(300 * time.Millisecond); err != nil {
				return nil, err
			}
			return json.RawMessage(`"ok"`), nil
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	id, err := e.Start(ctx, engine.StartRequest{Workflow: "slow", ID: "deadline-1", Deadline: 500 * time.Millisecond})
	must(t, err)
	_, err = e.Await(ctx, id, waitLong)
	if !errors.Is(err, engine.ErrCancelled) {
		t.Fatalf("await: %v, want ErrCancelled at the deadline", err)
	}
	// A run inside its deadline finishes normally, and the caller's context ending
	// (a request finishing) doesn't touch it.
	reqCtx, cancel := context.WithCancel(ctx)
	fast, err := e.Start(reqCtx, engine.StartRequest{Workflow: "fast", ID: "deadline-2", Deadline: 30 * time.Second})
	cancel()
	must(t, err)
	if out, err := e.Await(ctx, fast, waitLong); err != nil || string(out) != `"ok"` {
		t.Fatalf("fast run: %s, %v", out, err)
	}
}

func (s *suite) child(t *testing.T) {
	db := s.h.NewDB(t)
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("double", engine.Typed(func(_ engine.Context, n int) (int, error) { return 2 * n, nil })))
		must(t, e.RegisterWorkflow("parent", engine.Typed(func(ctx engine.Context, n int) (int, error) {
			sum := 0
			var ids []string
			for i := range n {
				id, err := ctx.StartChild(engine.StartRequest{Workflow: "double", ID: fmt.Sprintf("%s/c%d", ctx.WorkflowID(), i), Input: engine.Input(i)})
				if err != nil {
					return 0, err
				}
				ids = append(ids, id)
			}
			for _, id := range ids {
				raw, err := ctx.AwaitChild(id)
				if err != nil {
					return 0, err
				}
				v, err := engine.Decode[int](raw)
				if err != nil {
					return 0, err
				}
				sum += v
			}
			return sum, nil
		})))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	id, err := e.Start(ctx, engine.StartRequest{Workflow: "parent", ID: "parent-1", Input: engine.Input(4)})
	must(t, err)
	out, err := e.Await(ctx, id, waitLong)
	must(t, err)
	if string(out) != "12" {
		t.Fatalf("sum %s, want 12", out)
	}
	kids, err := e.List(ctx, engine.ListFilter{IDPrefix: "parent-1/"})
	must(t, err)
	if len(kids) != 4 || kids[0].ParentID != "parent-1" {
		t.Fatalf("children %+v", kids)
	}
}

// blockingWorkflow: step "one" counts, step "two" blocks until released or the context ends.
type blocking struct {
	one, two atomic.Int32
	mu       sync.Mutex
	release  chan struct{}
}

func newBlocking() *blocking { return &blocking{release: make(chan struct{})} }

func (b *blocking) unblock() {
	b.mu.Lock()
	defer b.mu.Unlock()
	select {
	case <-b.release:
	default:
		close(b.release)
	}
}

func (b *blocking) fn(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
	if _, err := ctx.Step("one", func(context.Context) (json.RawMessage, error) { b.one.Add(1); return nil, nil }); err != nil {
		return nil, err
	}
	return ctx.Step("two", func(c context.Context) (json.RawMessage, error) {
		b.two.Add(1)
		select {
		case <-b.release:
			return json.RawMessage(`"done"`), nil
		case <-c.Done():
			return nil, c.Err()
		}
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(waitLong)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (s *suite) recoveryAfterRestart(t *testing.T) {
	db := s.h.NewDB(t)
	b := newBlocking()
	ctx := context.Background()
	e1 := s.engine(t, db, "v1", "x1", func(e engine.Engine) { must(t, e.RegisterWorkflow("block", b.fn)) })
	id, err := e1.Start(ctx, engine.StartRequest{Workflow: "block", ID: "restart-1"})
	must(t, err)
	waitFor(t, "step two to start", func() bool { return b.two.Load() == 1 })
	shutdown(t, e1) // the executor stops mid-step

	b.unblock()
	e2 := s.engine(t, db, "v1", "x1", func(e engine.Engine) { must(t, e.RegisterWorkflow("block", b.fn)) })
	defer shutdown(t, e2)
	out, err := e2.Await(ctx, id, waitLong)
	must(t, err)
	if string(out) != `"done"` || b.one.Load() != 1 || b.two.Load() != 2 {
		t.Fatalf("out %s, step one ran %d (want 1: checkpointed), two ran %d (want 2)", out, b.one.Load(), b.two.Load())
	}
}

func (s *suite) recoveryAfterVersionChange(t *testing.T) {
	db := s.h.NewDB(t)
	b := newBlocking()
	ctx := context.Background()
	reg := func(e engine.Engine) {
		must(t, e.RegisterQueue(engine.QueueSpec{Name: "runs", PollInterval: 50 * time.Millisecond}))
		must(t, e.RegisterWorkflow("block", b.fn))
	}
	a := s.engine(t, db, "vA", "x1", reg)
	id, err := a.Start(ctx, engine.StartRequest{Workflow: "block", ID: "ver-1"})
	must(t, err)
	waitFor(t, "step two to start", func() bool { return b.two.Load() == 1 })
	shutdown(t, a)

	b.unblock()
	bEng := s.engine(t, db, "vB", "x1", reg)
	defer shutdown(t, bEng)
	// A run enqueued for vA (as vA's pods would have) is not dequeued by vB.
	queued, err := bEng.Start(ctx, engine.StartRequest{Workflow: "block", ID: "ver-queued", Queue: "runs", AppVersion: "vA"})
	must(t, err)
	time.Sleep(1500 * time.Millisecond)
	info, err := bEng.Get(ctx, id)
	must(t, err)
	if info.Status != engine.StatusPending || info.AppVersion != "vA" {
		t.Fatalf("vB recovered a vA workflow: %+v", info)
	}
	q, err := bEng.Get(ctx, queued)
	must(t, err)
	if q.Status != engine.StatusEnqueued {
		t.Fatalf("vB dequeued a vA workflow: %+v", q)
	}

	// Drain deadline: fork the stranded run onto vB from its first incomplete step.
	steps, err := bEng.Steps(ctx, id)
	must(t, err)
	fork, err := bEng.Fork(ctx, engine.ForkRequest{WorkflowID: id, NewID: engine.ForkID(id, "vB"), FromStep: len(steps), AppVersion: "vB"})
	must(t, err)
	out, err := bEng.Await(ctx, fork, waitLong)
	must(t, err)
	if string(out) != `"done"` || b.one.Load() != 1 {
		t.Fatalf("fork out %s, step one ran %d times (want 1: replayed from the checkpoint)", out, b.one.Load())
	}
	fi, err := bEng.Get(ctx, fork)
	must(t, err)
	if fi.AppVersion != "vB" || fi.ForkedFrom != id {
		t.Fatalf("fork info %+v", fi)
	}
	// Forking the same run onto the same version again is idempotent.
	again, err := bEng.Fork(ctx, engine.ForkRequest{WorkflowID: id, NewID: engine.ForkID(id, "vB"), FromStep: len(steps), AppVersion: "vB"})
	if err != nil && !errors.Is(err, engine.ErrConflict) {
		t.Fatalf("second fork: %v", err)
	}
	if err == nil && again != fork {
		t.Fatalf("second fork made %s", again)
	}
	// The original is cancelled once forked, so vA never resumes it if it comes back.
	must(t, bEng.Cancel(ctx, id))
	// The queued vA run moves by fork too (it never started: from step 0).
	qf, err := bEng.Fork(ctx, engine.ForkRequest{WorkflowID: queued, NewID: queued + "/fork/vB", AppVersion: "vB", Queue: "runs"})
	must(t, err)
	must(t, bEng.Cancel(ctx, queued))
	_, err = bEng.Await(ctx, qf, waitLong)
	must(t, err)
}

func (s *suite) listAndSteps(t *testing.T) {
	db := s.h.NewDB(t)
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("two-steps", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			if _, err := ctx.Step("a", func(context.Context) (json.RawMessage, error) { return json.RawMessage(`{"n":1}`), nil }); err != nil {
				return nil, err
			}
			return ctx.Step("b", func(context.Context) (json.RawMessage, error) { return json.RawMessage(`{"n":2}`), nil })
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	id, err := e.Start(ctx, engine.StartRequest{Workflow: "two-steps", ID: "ls-1"})
	must(t, err)
	_, err = e.Await(ctx, id, waitLong)
	must(t, err)
	info, err := e.Get(ctx, id)
	must(t, err)
	var o struct{ N int }
	if info.Workflow != "two-steps" || info.Status != engine.StatusSuccess || info.AppVersion != "v1" ||
		info.ExecutorID != "x1" || json.Unmarshal(info.Output, &o) != nil || o.N != 2 {
		t.Fatalf("info %+v (output %s)", info, info.Output)
	}
	steps, err := e.Steps(ctx, id)
	must(t, err)
	if len(steps) != 2 || steps[0].Name != "a" || steps[1].Name != "b" || json.Unmarshal(steps[0].Output, &o) != nil || o.N != 1 {
		t.Fatalf("steps %+v", steps)
	}
	ws, err := e.List(ctx, engine.ListFilter{Workflow: "two-steps", Statuses: []engine.Status{engine.StatusSuccess}})
	must(t, err)
	if len(ws) != 1 {
		t.Fatalf("list %+v", ws)
	}
	if _, err := e.Get(ctx, "missing"); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("get missing: %v", err)
	}
}

// fairness: workspace A floods a partitioned queue, then B arrives. With a per-partition
// limit B runs alongside A at once instead of after A's backlog.
func (s *suite) fairness(t *testing.T) {
	db := s.h.NewDB(t)
	const perPartition, aTasks, bTasks = 2, 30, 4
	var mu sync.Mutex
	running := map[string]int{}
	maxRunning := map[string]int{}
	done := map[string]int{}
	var aDoneWhenBFinished int
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterQueue(engine.QueueSpec{Name: "fair", PartitionConcurrency: engine.Limit(perPartition), PollInterval: 20 * time.Millisecond}))
		must(t, e.RegisterWorkflow("task", func(ctx engine.Context, in json.RawMessage) (json.RawMessage, error) {
			ws, _ := engine.Decode[string](in)
			_, err := ctx.Step("work", func(context.Context) (json.RawMessage, error) {
				mu.Lock()
				running[ws]++
				maxRunning[ws] = max(maxRunning[ws], running[ws])
				mu.Unlock()
				time.Sleep(100 * time.Millisecond)
				mu.Lock()
				running[ws]--
				done[ws]++
				if ws == "B" && done["B"] == bTasks {
					aDoneWhenBFinished = done["A"]
				}
				mu.Unlock()
				return nil, nil
			})
			return nil, err
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	var ids []string
	for i := range aTasks {
		id, err := e.Start(ctx, engine.StartRequest{Workflow: "task", ID: fmt.Sprintf("A-%d", i), Queue: "fair", PartitionKey: "A", Input: engine.Input("A")})
		must(t, err)
		ids = append(ids, id)
	}
	for i := range bTasks {
		id, err := e.Start(ctx, engine.StartRequest{Workflow: "task", ID: fmt.Sprintf("B-%d", i), Queue: "fair", PartitionKey: "B", Input: engine.Input("B")})
		must(t, err)
		ids = append(ids, id)
	}
	for _, id := range ids {
		_, err := e.Await(ctx, id, waitLong)
		must(t, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if maxRunning["A"] > perPartition || maxRunning["B"] > perPartition {
		t.Fatalf("partition limit exceeded: %v", maxRunning)
	}
	// Without partitions B would finish after all 30 of A's; with them, alongside A's first few.
	if aDoneWhenBFinished > aTasks/2 {
		t.Fatalf("B finished only after %d of A's %d tasks", aDoneWhenBFinished, aTasks)
	}
	t.Logf("B's %d tasks finished after %d of A's %d; max running per partition %v", bTasks, aDoneWhenBFinished, aTasks, maxRunning)
}

func (s *suite) purge(t *testing.T) {
	db := s.h.NewDB(t)
	e := s.engine(t, db, "v1", "x1", func(e engine.Engine) {
		must(t, e.RegisterWorkflow("noop", func(ctx engine.Context, in json.RawMessage) (json.RawMessage, error) {
			if string(in) == `"wait"` {
				_, _, err := ctx.Recv("go", 30*time.Second)
				return nil, err
			}
			return in, nil
		}))
	})
	defer shutdown(t, e)
	ctx := context.Background()
	for i := range 5 {
		id, err := e.Start(ctx, engine.StartRequest{Workflow: "noop", ID: fmt.Sprintf("old-%d", i), Input: engine.Input(i)})
		must(t, err)
		_, err = e.Await(ctx, id, waitLong)
		must(t, err)
	}
	live, err := e.Start(ctx, engine.StartRequest{Workflow: "noop", ID: "live", Input: engine.Input("wait")})
	must(t, err)
	cutoff := time.Now().Add(time.Second) // everything finished so far is "old"
	n1, err := e.Purge(ctx, cutoff, 3)
	must(t, err)
	n2, err := e.Purge(ctx, cutoff, 3)
	must(t, err)
	if n1 != 3 || n2 != 2 {
		t.Fatalf("purged %d then %d, want 3 then 2", n1, n2)
	}
	if _, err := e.Get(ctx, "old-0"); !errors.Is(err, engine.ErrNotFound) {
		t.Fatalf("old-0 survived: %v", err)
	}
	if info, err := e.Get(ctx, live); err != nil || info.Status.Terminal() {
		t.Fatalf("a running workflow was purged or ended: %+v %v", info, err)
	}
	must(t, e.Send(ctx, live, "go", nil, ""))
	_, err = e.Await(ctx, live, waitLong)
	must(t, err)
}

// sendReachesForks: a run forked mid-wait (drain policy) still gets messages addressed to
// the original ID, which is all the kernel's event consumer knows.
func (s *suite) sendReachesForks(t *testing.T) {
	db := s.h.NewDB(t)
	var waits atomic.Int32
	reg := func(e engine.Engine) {
		must(t, e.RegisterWorkflow("waiter", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
			if _, err := ctx.Step("before", func(context.Context) (json.RawMessage, error) { return nil, nil }); err != nil {
				return nil, err
			}
			waits.Add(1)
			m, ok, err := ctx.Recv("job:1", 30*time.Second)
			if err != nil || !ok {
				return nil, fmt.Errorf("no message: %v", err)
			}
			return m, nil
		}))
	}
	ctx := context.Background()
	a := s.engine(t, db, "vA", "x1", reg)
	id, err := a.Start(ctx, engine.StartRequest{Workflow: "waiter", ID: "run-f"})
	must(t, err)
	waitFor(t, "the wait", func() bool { return waits.Load() == 1 })
	shutdown(t, a)
	b := s.engine(t, db, "vB", "x2", reg)
	defer shutdown(t, b)
	fork, err := b.Fork(ctx, engine.ForkRequest{WorkflowID: id, NewID: engine.ForkID(id, "vB"), FromStep: 1, AppVersion: "vB"})
	must(t, err)
	must(t, b.Cancel(ctx, id))
	waitFor(t, "the fork's wait", func() bool { return waits.Load() == 2 })
	must(t, b.Send(ctx, id, "job:1", engine.Input("done"), "evt-1"))
	out, err := b.Await(ctx, fork, waitLong)
	must(t, err)
	if string(out) != `"done"` {
		t.Fatalf("fork got %s", out)
	}
}
