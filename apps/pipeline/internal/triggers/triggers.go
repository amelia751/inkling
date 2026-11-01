// Package triggers consumes the kernel's service event feed (GET /api/v1/service/events)
// and wakes the workflows waiting on it. Milestone 0 handles job.succeeded / job.failed:
// each becomes Send(job:<job_id>) to the waiting workflow (dispatch's waiter convention),
// with the event ID as the idempotency key, so a replayed page or a second replica
// delivers each event at most once per workflow.
//
// Delivery is at-least-once from the feed and at-most-once into a workflow. The cursor is
// saved after a page is handled; a crash between the two replays the page harmlessly.
// Events for jobs that aren't the pipeline's (imports, plugin tools) are skipped.
package triggers

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"studio.local/pipeline/internal/dispatch"
	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel"
)

// Feed is the event feed (the kernel client).
type Feed interface {
	Events(ctx context.Context, after string, types []string) (kernel.EventPage, error)
}

// Sender delivers workflow messages (the engine).
type Sender interface {
	Send(ctx context.Context, workflowID, topic string, msg json.RawMessage, idempotencyKey string) error
}

// Cursors persists the feed position. Implementations: MemoryCursor, PGCursor.
type Cursors interface {
	Load(ctx context.Context) (string, error)
	Save(ctx context.Context, cursor string) error
}

// Consumer turns job events into workflow messages.
type Consumer struct {
	Feed    Feed
	Engine  Sender
	Cursors Cursors
	Log     *slog.Logger
	// Backoff after a failed poll or delivery (default 1s, doubling to 30s).
	Backoff time.Duration

	pages, delivered, skipped, failed atomic.Int64
}

// Stats counts what the consumer did (for tests and metrics).
type Stats struct {
	Pages, Delivered, Skipped, Failed int64
}

// Types are the event types the consumer asks for.
var Types = []string{kernel.EventJobSucceeded, kernel.EventJobFailed}

// Stats returns the counters.
func (c *Consumer) Stats() Stats {
	return Stats{Pages: c.pages.Load(), Delivered: c.delivered.Load(), Skipped: c.skipped.Load(), Failed: c.failed.Load()}
}

// Run consumes until ctx ends.
func (c *Consumer) Run(ctx context.Context) error {
	log := c.Log
	if log == nil {
		log = slog.Default()
	}
	base := c.Backoff
	if base <= 0 {
		base = time.Second
	}
	cursor, err := c.Cursors.Load(ctx)
	if err != nil {
		return err
	}
	wait := base
	for ctx.Err() == nil {
		page, err := c.Feed.Events(ctx, cursor, Types)
		if err == nil {
			err = c.Handle(ctx, page.Events)
		}
		if err == nil && page.Cursor != "" {
			// Saved on every page, changed or not: the save also renews a PGCursor lease.
			if err = c.Cursors.Save(ctx, page.Cursor); err == nil {
				cursor = page.Cursor
			} else if errors.Is(err, ErrLeaseLost) {
				// Another replica took over: wait for the lease again, from its cursor.
				if cursor, err = c.Cursors.Load(ctx); err != nil {
					return err
				}
				continue
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			log.Warn("trigger feed", "error", err, "retry_in", wait)
			sleep(ctx, wait)
			wait = min(2*wait, 30*time.Second)
			continue
		}
		c.pages.Add(1)
		wait = base
	}
	return nil
}

// Handle delivers one page. It fails (so the page is retried) only on a delivery error
// that isn't "no such workflow".
func (c *Consumer) Handle(ctx context.Context, events []kernel.Event) error {
	for _, ev := range events {
		if ev.Type != kernel.EventJobSucceeded && ev.Type != kernel.EventJobFailed {
			c.skipped.Add(1)
			continue
		}
		var je kernel.JobEvent
		if err := json.Unmarshal(ev.Payload, &je); err != nil || je.JobID == "" {
			c.skipped.Add(1) // malformed: never block the feed on it
			continue
		}
		waiters := dispatch.Resolve(je.IdempotencyKey)
		if len(waiters) == 0 {
			c.skipped.Add(1)
			continue
		}
		msg, _ := json.Marshal(dispatch.Message{Type: ev.Type, Job: je})
		delivered := false
		for _, wf := range waiters {
			err := c.Engine.Send(ctx, wf, dispatch.Topic(je.JobID), msg, ev.EventID)
			if err == nil {
				delivered = true
				break
			}
			if !errors.Is(err, engine.ErrNotFound) {
				c.failed.Add(1)
				return err
			}
		}
		if delivered {
			c.delivered.Add(1)
		} else {
			c.skipped.Add(1) // the run is gone (retention) or never existed
		}
	}
	return nil
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
