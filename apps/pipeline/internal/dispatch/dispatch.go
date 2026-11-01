// Package dispatch runs Python work as kernel jobs from inside a workflow (P§5.3, E2).
//
// Run enqueues a kernel job with idempotency key run_id/step_id/partition_id, then waits on
// topic job:<job_id> with Recv. internal/triggers turns the kernel's job.succeeded /
// job.failed events into that message. If no message arrives within PollAfter, Run reads
// GET /api/v1/service/jobs/{id} once and either returns (terminal) or waits again, so a
// lost or late event costs at most one poll interval.
//
// One retry owner per unit of work: the kernel retries the job (max_attempts). Nothing here
// re-enqueues: the enqueue step retries only its HTTP call, under the same idempotency key
// (the kernel answers a repeat with the same job), and the waiting has no engine retries.
//
// Waiter convention (how triggers find the workflow to wake): the workflow calling Run
// must have workflow ID Key.String() (a per-partition child workflow) or Key.RunID (the run
// workflow itself), or be a fork of one (engine.ForkID: messages to a workflow reach its
// forks). Resolve implements the lookup. IDs must not contain "/" themselves.
package dispatch

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"studio.local/pipeline/internal/engine"
	"studio.local/pipeline/internal/kernel"
)

// Kernel is the slice of the kernel client dispatch needs.
type Kernel interface {
	Enqueue(ctx context.Context, req kernel.EnqueueRequest) (string, error)
	Job(ctx context.Context, id string) (kernel.JobStatus, error)
}

// Key identifies one logical step execution: the kernel job's idempotency key.
type Key struct {
	RunID       string
	StepID      string
	PartitionID string
}

// String is run_id/step_id/partition_id (partition "0" when unpartitioned).
func (k Key) String() string {
	p := k.PartitionID
	if p == "" {
		p = "0"
	}
	return k.RunID + "/" + k.StepID + "/" + p
}

// ParseKey splits an idempotency key made by Key.String.
func ParseKey(s string) (Key, bool) {
	parts := strings.Split(s, "/")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return Key{}, false
	}
	return Key{RunID: parts[0], StepID: parts[1], PartitionID: parts[2]}, true
}

// Resolve lists the workflow IDs that may be waiting on a job with this idempotency key,
// most specific first (see the waiter convention). Empty for keys that aren't ours.
func Resolve(idempotencyKey string) []string {
	k, ok := ParseKey(idempotencyKey)
	if !ok {
		return nil
	}
	return []string{k.String(), k.RunID}
}

// Topic is the message topic a job's completion is delivered on.
func Topic(jobID string) string { return "job:" + jobID }

// Message is what triggers sends on Topic(job_id).
type Message struct {
	Type string          `json:"type"` // job.succeeded | job.failed
	Job  kernel.JobEvent `json:"job"`
}

// Job is one unit of Python work.
type Job struct {
	Key           Key
	WorkspaceID   string
	Kind          string // the kernel job kind (plugin tool or boundary job)
	Plugin        string // optional plugin@version
	InputRef      string // a BlobStore ref: inputs travel by reference, never inline
	ResourceClass string // cpu (default), memory, gpu
}

// Result is a finished job.
type Result struct {
	JobID      string `json:"job_id"`
	State      string `json:"state"` // succeeded | failed | cancelled
	Attempts   int    `json:"attempts"`
	ResultRef  string `json:"result_ref,omitempty"`
	ErrorClass string `json:"error_class,omitempty"`
	Polls      int    `json:"polls"` // status reads needed (0 when the event arrived in time)
}

// JobError is returned for a job that ended failed or cancelled; Result is still filled.
type JobError struct {
	JobID      string
	State      string
	ErrorClass string
}

func (e *JobError) Error() string {
	return fmt.Sprintf("kernel job %s %s (%s)", e.JobID, e.State, e.ErrorClass)
}

// Options tune the wait.
type Options struct {
	// PollAfter is how long to wait for the completion event before reading the job's
	// status once (default 60s). It bounds the cost of a lost event.
	PollAfter time.Duration
	// EnqueueAttempts bounds retries of the enqueue HTTP call (default 5).
	EnqueueAttempts int
}

// Run enqueues j and waits for it to finish. Call it from a workflow.
func Run(ctx engine.Context, k Kernel, j Job, o Options) (Result, error) {
	if o.PollAfter <= 0 {
		o.PollAfter = 60 * time.Second
	}
	if o.EnqueueAttempts <= 0 {
		o.EnqueueAttempts = 5
	}
	key := j.Key.String()
	if id := ctx.WorkflowID(); !waiterOf(id, key) && !waiterOf(id, j.Key.RunID) {
		return Result{}, fmt.Errorf("dispatch: workflow %q can't wait on key %q (waiter convention)", id, key)
	}
	class := j.ResourceClass
	if class == "" {
		class = kernel.ClassCPU
	}
	jobID, err := engine.Step(ctx, "dispatch.enqueue", func(c context.Context) (string, error) {
		return k.Enqueue(c, kernel.EnqueueRequest{WorkspaceID: j.WorkspaceID, Kind: j.Kind, Plugin: j.Plugin,
			InputRef: j.InputRef, ResourceClass: class, IdempotencyKey: key})
	}, engine.WithRetries(o.EnqueueAttempts, 200*time.Millisecond), engine.WithRetryIf(kernel.Retryable))
	if err != nil {
		return Result{}, fmt.Errorf("dispatch: enqueue %s: %w", key, err)
	}
	polls := 0
	for {
		msg, ok, err := engine.Recv[Message](ctx, Topic(jobID), o.PollAfter)
		if err != nil {
			return Result{}, err
		}
		if ok && msg.Job.JobID == jobID {
			st := kernel.StateSucceeded
			if msg.Type == kernel.EventJobFailed {
				st = kernel.StateFailed
			}
			return finish(Result{JobID: jobID, State: st, Attempts: msg.Job.Attempts, ResultRef: msg.Job.ResultRef,
				ErrorClass: msg.Job.ErrorClass, Polls: polls})
		}
		if ok {
			continue // a stray message on this topic: keep waiting
		}
		// No event in time: read the status once. A failed read is just another wait.
		polls++
		st, err := engine.Step(ctx, "dispatch.poll", func(c context.Context) (*kernel.JobStatus, error) {
			s, err := k.Job(c, jobID)
			if err != nil {
				return nil, nil //nolint:nilerr // transient: wait again rather than fail the step
			}
			return &s, nil
		})
		if err != nil {
			return Result{}, err
		}
		if st != nil && kernel.Terminal(st.State) {
			return finish(Result{JobID: jobID, State: st.State, Attempts: st.Attempts, ResultRef: st.ResultRef,
				ErrorClass: st.ErrorClass, Polls: polls})
		}
	}
}

// waiterOf reports whether workflow id is base or a fork of it (base/fork/<version>…).
func waiterOf(id, base string) bool {
	return id == base || strings.HasPrefix(id, base+"/fork/")
}

func finish(r Result) (Result, error) {
	if r.State == kernel.StateSucceeded {
		return r, nil
	}
	return r, &JobError{JobID: r.JobID, State: r.State, ErrorClass: r.ErrorClass}
}

// IsJobError reports whether err is a failed or cancelled job (not an engine error).
func IsJobError(err error) bool {
	var je *JobError
	return errors.As(err, &je)
}
