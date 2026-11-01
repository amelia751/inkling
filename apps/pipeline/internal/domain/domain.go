// Package domain holds the pipeline's rules that don't touch I/O: run, step
// and item state machines, error classes and their retry policy, and the
// stable keys every side effect is idempotent on (docs/pipeline.md §10.2):
// kernel job keys, event keys, staging blob keys and candidate branch names.
package domain

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"studio.local/pipeline/internal/contracts"
)

// Run states (todo12 §5 contracts; names fixed).
const (
	RunQueued         = "queued"
	RunRunning        = "running"
	RunAwaitingReview = "awaiting_review"
	RunPublishing     = "publishing"
	RunPublished      = "published"
	RunRejected       = "rejected"
	RunFailed         = "failed"
	RunCancelled      = "cancelled"
)

// RunStates lists every run state.
var RunStates = []string{RunQueued, RunRunning, RunAwaitingReview, RunPublishing, RunPublished, RunRejected, RunFailed, RunCancelled}

// RunTransitions mirrors PIPELINE_RUN_TRANSITIONS in packages/contracts.
// publishing → awaiting_review is a stale head: a rebase review opens.
var RunTransitions = map[string][]string{
	RunQueued:         {RunRunning, RunCancelled, RunFailed},
	RunRunning:        {RunAwaitingReview, RunPublishing, RunFailed, RunCancelled},
	RunAwaitingReview: {RunPublishing, RunRejected, RunCancelled},
	RunPublishing:     {RunPublished, RunAwaitingReview, RunFailed},
	RunPublished:      {},
	RunRejected:       {},
	RunFailed:         {},
	RunCancelled:      {},
}

// ErrTransition is an illegal state change.
var ErrTransition = errors.New("illegal state transition")

// CanTransition reports whether from → to is allowed.
func CanTransition(from, to string) bool {
	for _, t := range RunTransitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// CheckTransition returns ErrTransition for an illegal change.
func CheckTransition(from, to string) error {
	if !CanTransition(from, to) {
		return fmt.Errorf("%w: %s → %s", ErrTransition, from, to)
	}
	return nil
}

// Terminal reports whether no transition leaves state.
func Terminal(state string) bool {
	ts, ok := RunTransitions[state]
	return ok && len(ts) == 0
}

// Step states.
const (
	StepPending   = "pending"
	StepRunning   = "running"
	StepSucceeded = "succeeded"
	StepFailed    = "failed"
	StepSkipped   = "skipped"
	StepCancelled = "cancelled"
)

// Item states (todo11 item.* extended).
const (
	ItemDiscovered  = "discovered"
	ItemStaged      = "staged"
	ItemValidated   = "validated"
	ItemQuarantined = "quarantined"
	ItemProcessed   = "processed"
	ItemProposed    = "proposed"
	ItemRejected    = "rejected"
)

// Error classes (docs/pipeline.md §12).
const (
	ErrClassTransient           = "transient"
	ErrClassRateLimited         = "rate_limited"
	ErrClassWorkerCrash         = "worker_crash"
	ErrClassInvalidInput        = "invalid_input"
	ErrClassSchemaIncompatible  = "schema_incompatible"
	ErrClassUserCode            = "user_code_error"
	ErrClassPolicyDenied        = "policy_denied"
	ErrClassResourceExceeded    = "resource_exceeded"
	ErrClassPermanentDependency = "permanent_dependency"
	ErrClassApprovalTimeout     = "approval_timeout"
	ErrClassCancelled           = "cancelled"
	ErrClassDeadlineExceeded    = "deadline_exceeded"
)

// Retryable reports whether a class is worth another attempt.
func Retryable(class string) bool {
	switch class {
	case ErrClassTransient, ErrClassRateLimited, ErrClassWorkerCrash:
		return true
	}
	return false
}

// Quarantines reports whether a per-item failure of this class quarantines
// the item instead of failing the run (partial success, §6).
func Quarantines(class string) bool {
	switch class {
	case ErrClassInvalidInput, ErrClassSchemaIncompatible, ErrClassUserCode:
		return true
	}
	return false
}

// NewError builds an envelope with fixed platform wording.
func NewError(class, code, message string) *contracts.ErrorEnvelope {
	return &contracts.ErrorEnvelope{Class: class, Code: code, Message: message, Retryable: Retryable(class)}
}

var (
	safeIDRE   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	stepIDRE   = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,62}$`)
	branchIDRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,100}$`) // versioning branch names are lower-case
	nameRE     = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
)

// ErrBadID rejects an id that would make an unsafe key.
var ErrBadID = errors.New("id not safe for a key")

func check(re *regexp.Regexp, what, v string) error {
	if !re.MatchString(v) {
		return fmt.Errorf("%w: %s %q", ErrBadID, what, v)
	}
	return nil
}

// PartitionID formats partition n ("0" when the step doesn't fan out).
func PartitionID(n int) string { return strconv.Itoa(n) }

// JobKey is a kernel job's idempotency key: <run_id>/<step_id>/<partition_id>.
func JobKey(runID, stepID, partitionID string) (string, error) {
	if err := check(safeIDRE, "run", runID); err != nil {
		return "", err
	}
	if err := check(stepIDRE, "step", stepID); err != nil {
		return "", err
	}
	return runID + "/" + stepID + "/" + partitionID, nil
}

// StepExecutionID is the logical step's id; attempts are subordinate.
func StepExecutionID(runID, stepID, partitionID string) string {
	return runID + "/" + stepID + "/" + partitionID
}

// EventKey is an event's idempotency key: <run_id>/<event>[/<step_id>[/<partition_id>]].
func EventKey(runID, eventType string, parts ...string) string {
	k := runID + "/" + eventType
	for _, p := range parts {
		if p != "" {
			k += "/" + p
		}
	}
	return k
}

// CandidateBranch is the versioning branch a run's candidate lives on.
func CandidateBranch(runID string) (string, error) {
	if err := check(branchIDRE, "run", runID); err != nil {
		return "", err
	}
	return "pipeline/" + runID, nil
}

// RebaseBranch is where a candidate is rebuilt when main moved under it.
func RebaseBranch(runID string, n int) (string, error) {
	b, err := CandidateBranch(runID)
	if err != nil {
		return "", err
	}
	return b + "-rebase-" + strconv.Itoa(n), nil
}

// StagingPrefix is pipeline/<run_id>/<step_id>/ (a step input's output_prefix).
func StagingPrefix(runID, stepID string) (string, error) {
	if err := check(safeIDRE, "run", runID); err != nil {
		return "", err
	}
	if err := check(stepIDRE, "step", stepID); err != nil {
		return "", err
	}
	return "pipeline/" + runID + "/" + stepID + "/", nil
}

// StagingKey is an attempt-unique blob key:
// pipeline/<run_id>/<step_id>/<partition_id>.<attempt>/<name>. A late worker
// writing its old attempt can't overwrite its replacement's outputs (§10.3).
func StagingKey(runID, stepID, partitionID string, attempt int, name string) (string, error) {
	prefix, err := StagingPrefix(runID, stepID)
	if err != nil {
		return "", err
	}
	if attempt < 1 {
		return "", fmt.Errorf("%w: attempt %d", ErrBadID, attempt)
	}
	if err := check(nameRE, "name", name); err != nil {
		return "", err
	}
	if _, err := strconv.Atoi(partitionID); err != nil {
		return "", fmt.Errorf("%w: partition %q", ErrBadID, partitionID)
	}
	return fmt.Sprintf("%s%s.%d/%s", prefix, partitionID, attempt, name), nil
}

// Partitions splits n items into batches of size, at most max of them.
// It returns an error rather than silently dropping items past the bound.
func Partitions(n, size, max int) ([]contracts.Range, error) {
	if size < 1 || max < 1 {
		return nil, fmt.Errorf("bad fan-out bounds %d/%d", size, max)
	}
	if n == 0 {
		return []contracts.Range{}, nil
	}
	count := (n + size - 1) / size
	if count > max {
		return nil, fmt.Errorf("%d items need %d partitions, the step allows %d", n, count, max)
	}
	out := make([]contracts.Range, 0, count)
	for off := 0; off < n; off += size {
		l := size
		if off+l > n {
			l = n - off
		}
		out = append(out, contracts.Range{Offset: off, Limit: l})
	}
	return out, nil
}
