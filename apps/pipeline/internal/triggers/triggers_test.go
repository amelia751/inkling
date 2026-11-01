package triggers_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"studio.local/pipeline/internal/dispatch"
	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel"
	"studio.local/pipeline/internal/testdb"
	"studio.local/pipeline/internal/testenv"
	"studio.local/pipeline/internal/triggers"
)

func jobEvent(id, typ, jobID, key string) kernel.Event {
	p, _ := json.Marshal(kernel.JobEvent{JobID: jobID, WorkspaceID: "ws1", IdempotencyKey: key, Attempts: 1})
	return kernel.Event{EventID: id, WorkspaceID: "ws1", Type: typ, Payload: p, Source: "kernel"}
}

// TestHandleDeliversOnceAndSkipsForeign: a replayed page delivers each event once; events
// for other jobs, unknown runs and other types are skipped without blocking the feed.
func TestHandleDeliversOnceAndSkipsForeign(t *testing.T) {
	db := testdb.New(t)
	e := testenv.Engine(t, db, "v1", "x1", 5)
	if err := e.RegisterWorkflow("inbox", func(ctx engine.Context, _ json.RawMessage) (json.RawMessage, error) {
		var got []dispatch.Message
		for {
			m, ok, err := engine.Recv[dispatch.Message](ctx, dispatch.Topic("job_1"), 1500*time.Millisecond)
			if err != nil {
				return nil, err
			}
			if !ok {
				return json.Marshal(got)
			}
			got = append(got, m)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := e.Launch(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer e.Shutdown(5 * time.Second)
	ctx := context.Background()
	if _, err := e.Start(ctx, engine.StartRequest{Workflow: "inbox", ID: "run_1"}); err != nil {
		t.Fatal(err)
	}
	c := &triggers.Consumer{Engine: e}
	page := []kernel.Event{
		jobEvent("evt_1", kernel.EventJobSucceeded, "job_1", "run_1/inspect/0"),  // ours: the run workflow waits
		jobEvent("evt_2", kernel.EventJobSucceeded, "job_9", "import-123"),       // not a pipeline job
		jobEvent("evt_3", kernel.EventJobFailed, "job_8", "run_gone/inspect/0"),  // run no longer exists
		{EventID: "evt_4", Type: "item.created", Payload: json.RawMessage(`{}`)}, // another type
		{EventID: "evt_5", Type: kernel.EventJobFailed, Payload: json.RawMessage(`not json`)},
	}
	for range 2 { // the page replayed (crash before the cursor save, or a second replica)
		if err := c.Handle(ctx, page); err != nil {
			t.Fatal(err)
		}
	}
	out, err := e.Await(ctx, "run_1", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var got []dispatch.Message
	_ = json.Unmarshal(out, &got)
	if len(got) != 1 || got[0].Type != kernel.EventJobSucceeded || got[0].Job.JobID != "job_1" {
		t.Fatalf("delivered %s, want job_1 once", out)
	}
	if s := c.Stats(); s.Delivered != 2 || s.Skipped != 8 || s.Failed != 0 {
		t.Fatalf("stats %+v", s) // 2 sends (the second deduped by the engine), 4 skips per pass
	}
}

func TestPGCursorLease(t *testing.T) {
	db := testdb.New(t)
	e := testenv.Engine(t, db, "v1", "x1", 5) // runs DBOS migrations; we only borrow its pool
	defer e.Shutdown(time.Second)
	ctx := context.Background()
	a := &triggers.PGCursor{Pool: e.Pool(), Name: "kernel-jobs", Owner: "a", TTL: 500 * time.Millisecond}
	b := &triggers.PGCursor{Pool: e.Pool(), Name: "kernel-jobs", Owner: "b", TTL: 500 * time.Millisecond}
	if c, err := a.Load(ctx); err != nil || c != "" {
		t.Fatalf("load %q %v", c, err)
	}
	if err := a.Save(ctx, "42"); err != nil {
		t.Fatal(err)
	}
	if ok, err := b.Acquire(ctx); err != nil || ok {
		t.Fatalf("b took a live lease: %v %v", ok, err)
	}
	time.Sleep(700 * time.Millisecond) // a stops renewing
	c, err := b.Load(ctx)
	if err != nil || c != "42" {
		t.Fatalf("b load %q %v", c, err)
	}
	if err := a.Save(ctx, "43"); err != triggers.ErrLeaseLost {
		t.Fatalf("a saved after losing the lease: %v", err)
	}
}
