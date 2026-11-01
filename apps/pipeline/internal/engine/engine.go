// Package engine is the pipeline's durable-execution adapter (docs/pipeline.md §5.5).
//
// It is deliberately thin: register workflows and queues, start a workflow, run a step,
// send a message, wait for a message with a timeout, cancel, fork, resume, list. Workflow
// code (internal/workflows, owned by the pipeline workstream) depends only on this package;
// no engine library type crosses it. The implementation is internal/engine/dbos (DBOS
// Transact Go); a second implementation would have to pass the same conformance suite
// (internal/engine/enginetest) before running new workflows while the first drains.
//
// # Rules for workflow code (P§5.2)
//
//   - A workflow function is deterministic: no clocks, randomness, HTTP, SQL or file I/O in
//     it. Do those in a Step, whose result is checkpointed, and use Context.Now for time.
//   - Steps can run more than once (crash between effect and checkpoint): make them
//     idempotent, with keys derived from the run (run_id/step_id/partition_id).
//   - Values crossing the engine (inputs, outputs, step results, messages) are JSON. Keep
//     them small: URIs and digests, never item bytes or PHI (engine state is
//     customer-data-adjacent and must stay small, P§16).
//   - No workflow waits for a human (E3): end in awaiting_review and start a new workflow
//     on approval. Give long work a Deadline; anything longer is a coordinator that
//     restarts itself per chunk.
//   - Workflows recover only on the application version that started them. AppVersion is
//     the workflow package digest; when it changes, the old version drains (Fork onto the
//     new version or cancel and rerun at the drain deadline).
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Status is a workflow's engine state. It is engine-level only; run states
// (queued → running → awaiting_review → …) live in the pipeline schema.
type Status string

const (
	StatusEnqueued  Status = "enqueued"  // waiting on a queue (or delayed)
	StatusPending   Status = "pending"   // running, or interrupted and awaiting recovery
	StatusSuccess   Status = "success"   // returned a result
	StatusError     Status = "error"     // returned an error
	StatusCancelled Status = "cancelled" // cancelled, or past its deadline
	StatusStuck     Status = "stuck"     // exceeded its recovery attempts; needs Resume or Fork
)

// Terminal reports whether s never changes again without Resume or Fork.
func (s Status) Terminal() bool {
	return s == StatusSuccess || s == StatusError || s == StatusCancelled
}

var (
	// ErrNotFound: no workflow with that ID.
	ErrNotFound = errors.New("engine: workflow not found")
	// ErrCancelled: the workflow (or the one awaited) was cancelled or passed its deadline.
	ErrCancelled = errors.New("engine: workflow cancelled")
	// ErrTimeout: Await gave up before the workflow finished (the workflow keeps running).
	ErrTimeout = errors.New("engine: timed out waiting")
	// ErrConflict: a start reused a workflow ID for a different workflow or input.
	ErrConflict = errors.New("engine: workflow ID in use by a different workflow")
)

// Engine is the process-wide engine. Register everything, then Launch; Launch recovers
// this executor's interrupted workflows of the current AppVersion.
type Engine interface {
	// RegisterWorkflow makes fn startable under a stable name. Names are part of the
	// durable record: renaming one strands its in-flight workflows. Before Launch only.
	RegisterWorkflow(name string, fn WorkflowFunc, opts ...RegisterOption) error
	// RegisterQueue declares a queue (persisted; limits are shared by every executor).
	RegisterQueue(q QueueSpec) error
	// Launch starts recovery, queue runners and timers.
	Launch(ctx context.Context) error
	// Shutdown stops taking work; in-flight workflows stay pending and are recovered by
	// the next Launch with the same executor ID and AppVersion.
	Shutdown(timeout time.Duration) error

	// Start begins a workflow, or returns the existing one with the same ID (idempotent
	// start, E5). With a Queue it is enqueued; otherwise it runs on this executor now.
	Start(ctx context.Context, req StartRequest) (string, error)
	// Await waits for a workflow's result. ErrTimeout leaves it running.
	Await(ctx context.Context, workflowID string, timeout time.Duration) (json.RawMessage, error)
	// Send delivers msg to a workflow's topic, and to every fork of it (so a run moved
	// onto a new version by the drain policy keeps receiving its job events). With an
	// idempotency key it delivers at most once per (workflow, key), whatever the number
	// of calls.
	Send(ctx context.Context, workflowID, topic string, msg json.RawMessage, idempotencyKey string) error
	// Cancel stops a workflow at its next step boundary (children too).
	Cancel(ctx context.Context, workflowID string) error
	// Resume restarts a cancelled or stuck workflow from its last completed step, or
	// recovers a pending one whose executor is gone (never one whose executor is alive).
	Resume(ctx context.Context, workflowID string) error
	// Fork starts a new workflow that replays the original's checkpointed steps before
	// FromStep and executes the rest, optionally on another application version.
	Fork(ctx context.Context, req ForkRequest) (string, error)
	// Get returns one workflow's state.
	Get(ctx context.Context, workflowID string) (WorkflowInfo, error)
	// List returns workflows matching f, oldest first unless f.Desc.
	List(ctx context.Context, f ListFilter) ([]WorkflowInfo, error)
	// Steps returns a workflow's checkpointed steps in order.
	Steps(ctx context.Context, workflowID string) ([]StepInfo, error)
	// Purge deletes up to limit terminal workflows that completed before cutoff, with
	// their steps and messages (PIPELINE_ENGINE_RETENTION). It returns how many it removed;
	// call it until that is below limit. Run history lives on in the pipeline schema.
	Purge(ctx context.Context, cutoff time.Time, limit int) (int, error)

	// AppVersion is the workflow package digest this executor runs.
	AppVersion() string
	// ExecutorID identifies this replica in recovery.
	ExecutorID() string
}

// WorkflowFunc is a workflow body. input and the result are JSON.
type WorkflowFunc func(ctx Context, input json.RawMessage) (json.RawMessage, error)

// StepFunc is a step body. It gets a plain context (cancelled with the workflow).
type StepFunc func(ctx context.Context) (json.RawMessage, error)

// Context is what a workflow body may use. It is a context.Context so it can be passed to
// helpers, but never pass it to I/O: do I/O in a Step.
type Context interface {
	context.Context
	// WorkflowID is this workflow's ID.
	WorkflowID() string
	// Step runs fn once (checkpointed); on replay it returns the recorded result.
	Step(name string, fn StepFunc, opts ...StepOption) (json.RawMessage, error)
	// Recv waits up to timeout for the next message on topic. ok is false on timeout.
	// Messages sent before Recv are kept; each is delivered once, in send order.
	Recv(topic string, timeout time.Duration) (msg json.RawMessage, ok bool, err error)
	// Sleep is a durable sleep: a recovered workflow sleeps only the remainder.
	Sleep(d time.Duration) error
	// Now is a checkpointed clock read.
	Now() (time.Time, error)
	// StartChild starts a child workflow (same rules as Engine.Start); its ID is recorded.
	StartChild(req StartRequest) (string, error)
	// AwaitChild waits for a workflow started with StartChild (checkpointed).
	AwaitChild(workflowID string) (json.RawMessage, error)
}

// StartRequest starts one workflow.
type StartRequest struct {
	Workflow string          // registered name
	ID       string          // workflow ID; derive it from our own key (E5). Empty: generated
	Input    json.RawMessage // JSON; nil means null
	// Queue, when set, enqueues the workflow; PartitionKey selects the partition
	// (workspace_id) on a partitioned queue.
	Queue        string
	PartitionKey string
	Priority     uint          // lower first; the queue must have priority enabled
	Deadline     time.Duration // relative; the workflow is cancelled when it passes. 0: none
	// AppVersion pins the version to run on. Empty: this executor's version for a direct
	// start or an enqueue from a running executor.
	AppVersion string
}

// ForkID is the conventional ID of a fork of workflowID onto version: <id>/fork/<version>.
// Derived IDs make forking idempotent and let dispatch recognise a run's forks.
func ForkID(workflowID, version string) string { return workflowID + "/fork/" + version }

// ForkRequest forks a workflow (P§5.2 drain policy, run repair).
type ForkRequest struct {
	WorkflowID   string // the original
	NewID        string // the fork's ID: ForkID(WorkflowID, AppVersion). Empty: generated
	FromStep     int    // first step to execute; earlier steps replay their checkpoints
	AppVersion   string // version the fork runs on; empty: the original's
	Queue        string
	PartitionKey string
}

// QueueSpec declares a queue. Nil limits are unlimited.
type QueueSpec struct {
	Name string
	// Concurrency is the maximum number of workflows from this queue running at once
	// across all executors; WorkerConcurrency per executor.
	Concurrency       *int
	WorkerConcurrency *int
	// PartitionConcurrency partitions the queue (the pipeline's fairness gate, E4): at most
	// this many workflows per partition key (workspace) run at once across executors.
	PartitionConcurrency *int
	PriorityEnabled      bool
	// PollInterval is how often executors look for work (default: the engine's).
	PollInterval time.Duration
}

// WorkflowInfo is one workflow's state.
type WorkflowInfo struct {
	ID           string
	Workflow     string
	Status       Status
	AppVersion   string
	ExecutorID   string
	Queue        string
	PartitionKey string
	ForkedFrom   string
	ParentID     string
	Attempts     int
	Output       json.RawMessage
	Error        string
	CreatedAt    time.Time
	StartedAt    time.Time
	CompletedAt  time.Time
	Deadline     time.Time
}

// StepInfo is one checkpointed step.
type StepInfo struct {
	ID          int
	Name        string
	Output      json.RawMessage
	Error       string
	ChildID     string
	StartedAt   time.Time
	CompletedAt time.Time
}

// ListFilter selects workflows. Zero fields match everything.
type ListFilter struct {
	IDs         []string
	IDPrefix    string
	Workflow    string
	Statuses    []Status
	AppVersions []string
	ExecutorIDs []string
	Queue       string
	Limit       int
	Desc        bool
}

// StepOption configures a step.
type StepOption func(*StepOptions)

// StepOptions are a step's retry policy. The default is no retries: a step that waits on
// another retry owner (a kernel job, E2) keeps it that way.
type StepOptions struct {
	MaxAttempts  int // total runs including the first; <= 1: no retries
	BaseInterval time.Duration
	MaxInterval  time.Duration
	Backoff      float64
	Retryable    func(error) bool // nil: every error is retryable
}

// WithRetries runs a step up to attempts times with exponential backoff from base.
func WithRetries(attempts int, base time.Duration) StepOption {
	return func(o *StepOptions) { o.MaxAttempts = attempts; o.BaseInterval = base }
}

// WithRetryIf retries only errors for which fn is true.
func WithRetryIf(fn func(error) bool) StepOption { return func(o *StepOptions) { o.Retryable = fn } }

// RegisterOption configures a workflow registration.
type RegisterOption func(*RegisterOptions)

// RegisterOptions tune a registered workflow.
type RegisterOptions struct {
	// MaxRecoveryAttempts bounds how often a crashing workflow is recovered before it is
	// parked as StatusStuck (a poison-pill guard). 0: the engine's default.
	MaxRecoveryAttempts int
}

// WithMaxRecoveryAttempts sets RegisterOptions.MaxRecoveryAttempts.
func WithMaxRecoveryAttempts(n int) RegisterOption {
	return func(o *RegisterOptions) { o.MaxRecoveryAttempts = n }
}

// ApplyStepOptions folds opts into StepOptions (for implementations).
func ApplyStepOptions(opts []StepOption) StepOptions {
	var o StepOptions
	for _, f := range opts {
		f(&o)
	}
	return o
}

// ApplyRegisterOptions folds opts into RegisterOptions (for implementations).
func ApplyRegisterOptions(opts []RegisterOption) RegisterOptions {
	var o RegisterOptions
	for _, f := range opts {
		f(&o)
	}
	return o
}

// Limit is a helper for QueueSpec's optional limits.
func Limit(n int) *int { return &n }
