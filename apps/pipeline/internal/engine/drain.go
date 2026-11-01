package engine

import (
	"context"
	"errors"
	"fmt"
)

// DrainReport says what Drain did with a retired version's workflows.
type DrainReport struct {
	Forked    []string // fork IDs (ForkID(original, to))
	Cancelled []string // originals cancelled after forking
	Skipped   []string // couldn't fork (decide: cancel and rerun from pinned inputs)
}

// Drain moves every unfinished workflow of application version from onto version to, at
// the drain deadline (P§5.2), once no executor of from is left: each is forked from its
// first step without a checkpoint (earlier steps replay, so nothing completed runs again)
// and the original is cancelled, so a returning from executor can't resume it. Queued
// workflows are forked onto the same queue and partition.
//
// compatible decides per workflow whether the plan allows a fork; nil means always. The
// caller records the outcome on the run (forked or cancelled-and-rerun). Drain is
// idempotent: fork IDs are derived, so a second pass re-finds the same forks.
func Drain(ctx context.Context, e Engine, from, to string, compatible func(WorkflowInfo) bool) (DrainReport, error) {
	var rep DrainReport
	if from == to {
		return rep, errors.New("engine: drain needs two versions")
	}
	ws, err := e.List(ctx, ListFilter{AppVersions: []string{from}, Statuses: []Status{StatusPending, StatusEnqueued, StatusStuck}})
	if err != nil {
		return rep, err
	}
	for _, w := range ws {
		if w.ParentID != "" {
			continue // children move with their parent's replay
		}
		if compatible != nil && !compatible(w) {
			rep.Skipped = append(rep.Skipped, w.ID)
			continue
		}
		from := 0
		if w.Status != StatusEnqueued {
			steps, err := e.Steps(ctx, w.ID)
			if err != nil {
				return rep, err
			}
			from = FirstUncheckpointed(steps)
		}
		req := ForkRequest{WorkflowID: w.ID, NewID: ForkID(w.ID, to), FromStep: from, AppVersion: to}
		if w.Status == StatusEnqueued {
			req.Queue, req.PartitionKey = w.Queue, w.PartitionKey
		}
		fork, err := e.Fork(ctx, req)
		if errors.Is(err, ErrConflict) {
			fork, err = ForkID(w.ID, to), nil // forked by an earlier pass
		}
		if err != nil {
			return rep, fmt.Errorf("engine: fork %s: %w", w.ID, err)
		}
		rep.Forked = append(rep.Forked, fork)
		if err := e.Cancel(ctx, w.ID); err != nil {
			return rep, fmt.Errorf("engine: cancel %s: %w", w.ID, err)
		}
		rep.Cancelled = append(rep.Cancelled, w.ID)
	}
	return rep, nil
}

// FirstUncheckpointed is the first step ID with no checkpoint: where a fork resumes.
func FirstUncheckpointed(steps []StepInfo) int {
	seen := map[int]bool{}
	for _, s := range steps {
		seen[s.ID] = true
	}
	i := 0
	for seen[i] {
		i++
	}
	return i
}
