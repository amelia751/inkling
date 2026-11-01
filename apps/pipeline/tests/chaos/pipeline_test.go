package chaos_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/pipeline/internal/dispatch"
	"studio.local/pipeline/internal/engine"
)

// toy is a stand-in for PipelineWorkflow and PublishWorkflow with the P§5.2 shape: a run
// executes kernel steps, proposes a candidate, records awaiting_review and ends; an
// approval starts a short publish workflow (workflow ID = approval ID) that CAS-publishes.
// Run state lives in Postgres (database "studio"), like the pipeline schema.
type toy struct {
	db        *pgxpool.Pool
	k         dispatch.Kernel
	pollAfter time.Duration
}

const toyDDL = `
CREATE TABLE IF NOT EXISTS chaos_runs (run_id text PRIMARY KEY, workspace text NOT NULL, state text NOT NULL,
  candidate text, version text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS chaos_publish_log (id bigserial PRIMARY KEY, run_id text NOT NULL, approval_id text NOT NULL,
  version text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS chaos_effects (run_id text NOT NULL, step text NOT NULL, version text NOT NULL, at timestamptz NOT NULL DEFAULT now());`

type runInput struct {
	RunID     string `json:"run_id"`
	Workspace string `json:"workspace"`
}

type approval struct {
	RunID      string `json:"run_id"`
	ApprovalID string `json:"approval_id"`
	Candidate  string `json:"candidate"`
}

func (y *toy) register(t *testing.T, e engine.Engine) {
	t.Helper()
	ver := e.AppVersion()
	if err := e.RegisterQueue(engine.QueueSpec{Name: "runs", PartitionConcurrency: engine.Limit(8), PollInterval: 50 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if err := e.RegisterWorkflow("pipeline-run", engine.Typed(func(ctx engine.Context, in runInput) (string, error) {
		if _, err := engine.Step(ctx, "mark-running", func(c context.Context) (bool, error) {
			_, err := y.db.Exec(c, `INSERT INTO chaos_effects (run_id, step, version) VALUES ($1, 'mark-running', $2)`, in.RunID, ver)
			if err != nil {
				return false, err
			}
			_, err = y.db.Exec(c, `UPDATE chaos_runs SET state = 'running', version = $2, updated_at = now() WHERE run_id = $1 AND state = 'queued'`, in.RunID, ver)
			return true, err
		}, engine.WithRetries(5, 100*time.Millisecond)); err != nil {
			return "", err
		}
		for _, step := range []string{"inspect", "validate"} {
			if _, err := dispatch.Run(ctx, y.k, dispatch.Job{Key: dispatch.Key{RunID: in.RunID, StepID: step}, WorkspaceID: in.Workspace,
				Kind: step, InputRef: "blob://pipeline/" + in.RunID + "/" + step}, dispatch.Options{PollAfter: y.pollAfter}); err != nil {
				return "", err
			}
		}
		return engine.Step(ctx, "propose", func(c context.Context) (string, error) {
			cand := "cand-" + in.RunID
			_, err := y.db.Exec(c, `UPDATE chaos_runs SET state = 'awaiting_review', candidate = $2, updated_at = now()
				WHERE run_id = $1 AND state IN ('queued', 'running')`, in.RunID, cand)
			return cand, err
		}, engine.WithRetries(5, 100*time.Millisecond))
	}), engine.WithMaxRecoveryAttempts(20)); err != nil {
		t.Fatal(err)
	}
	if err := e.RegisterWorkflow("publish", engine.Typed(func(ctx engine.Context, a approval) (bool, error) {
		return engine.Step(ctx, "cas-publish", func(c context.Context) (bool, error) {
			tx, err := y.db.Begin(c)
			if err != nil {
				return false, err
			}
			defer tx.Rollback(c) //nolint:errcheck
			tag, err := tx.Exec(c, `UPDATE chaos_runs SET state = 'published', updated_at = now()
				WHERE run_id = $1 AND state = 'awaiting_review' AND candidate = $2`, a.RunID, a.Candidate)
			if err != nil {
				return false, err
			}
			if tag.RowsAffected() == 1 {
				if _, err := tx.Exec(c, `INSERT INTO chaos_publish_log (run_id, approval_id, version) VALUES ($1, $2, $3)`, a.RunID, a.ApprovalID, ver); err != nil {
					return false, err
				}
			}
			return tag.RowsAffected() == 1, tx.Commit(c)
		}, engine.WithRetries(5, 100*time.Millisecond))
	})); err != nil {
		t.Fatal(err)
	}
}

func (y *toy) startRun(t *testing.T, e engine.Engine, runID, ws string) {
	t.Helper()
	ctx := context.Background()
	if _, err := y.db.Exec(ctx, `INSERT INTO chaos_runs (run_id, workspace, state) VALUES ($1, $2, 'queued') ON CONFLICT DO NOTHING`, runID, ws); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Start(ctx, engine.StartRequest{Workflow: "pipeline-run", ID: runID, Queue: "runs", PartitionKey: ws,
		Input: engine.Input(runInput{RunID: runID, Workspace: ws}), Deadline: 24 * time.Hour}); err != nil {
		t.Fatal(err)
	}
}

// approve records an approval (as apps/api would) and starts its publish workflow.
func (y *toy) approve(t *testing.T, e engine.Engine, runID string) {
	t.Helper()
	var cand string
	if err := y.db.QueryRow(context.Background(), `SELECT coalesce(candidate, '') FROM chaos_runs WHERE run_id = $1`, runID).Scan(&cand); err != nil {
		t.Fatal(err)
	}
	id := "approval-" + runID
	if _, err := e.Start(context.Background(), engine.StartRequest{Workflow: "publish", ID: id,
		Input: engine.Input(approval{RunID: runID, ApprovalID: id, Candidate: cand})}); err != nil {
		t.Fatalf("approve %s: %v", runID, err)
	}
}

func (y *toy) count(t *testing.T, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := y.db.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func (y *toy) inState(t *testing.T, state string) []string {
	t.Helper()
	rows, err := y.db.Query(context.Background(), `SELECT run_id FROM chaos_runs WHERE state = $1 ORDER BY run_id`, state)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

func runID(prefix string, i int) string { return fmt.Sprintf("%s_%03d", prefix, i) }
