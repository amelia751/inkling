// Package persistence is the pipeline schema's data access (pgx): definitions
// and immutable revisions, runs with optimistic state transitions, logical
// steps and attempts, staged artifacts, the outbox (written in the same
// transaction as the state change it announces) and the consumer inbox.
// The pipeline schema is not a branch-head authority: candidate and publish
// records are read models of versioning's state.
package persistence

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver for goose
	"github.com/pressly/goose/v3"

	"studio.local/pipeline/internal/contracts"
	"studio.local/pipeline/internal/domain"
	"studio.local/pipeline/migrations"
)

// Schema is the Postgres schema the service owns.
const Schema = "pipeline"

// Errors.
var (
	ErrNotFound  = errors.New("not found")
	ErrConflict  = errors.New("conflict")
	ErrImmutable = errors.New("immutable record differs")
)

// Store wraps the pool.
type Store struct {
	Pool *pgxpool.Pool
	Now  func() time.Time
}

// Open connects with at most maxConns connections (the role's budget, E7).
func Open(ctx context.Context, url string, maxConns int32) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Store{Pool: pool, Now: func() time.Time { return time.Now().UTC() }}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.Pool.Close() }

func provider(db *sql.DB) (*goose.Provider, error) {
	return goose.NewProvider(goose.DialectPostgres, db, migrations.FS, goose.WithTableName(Schema+".goose_db_version"))
}

// Migrate applies every goose migration (the pipeline-migrate Job).
func Migrate(ctx context.Context, url string) error {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	// goose's version table lives in the schema, so the schema must exist first.
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA IF NOT EXISTS `+Schema); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	p, err := provider(db)
	if err != nil {
		return err
	}
	if _, err := p.Up(ctx); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	return nil
}

// MigrateDown rolls back the most recent migration (tested locally before every deploy).
func MigrateDown(ctx context.Context, url string) error {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	p, err := provider(db)
	if err != nil {
		return err
	}
	_, err = p.Down(ctx)
	return err
}

func (s *Store) tx(ctx context.Context, f func(pgx.Tx) error) error {
	return pgx.BeginTxFunc(ctx, s.Pool, pgx.TxOptions{}, f)
}

// NewRunID mints a run id (time-ordered).
func NewRunID() string { return "run_" + compact(uuid.Must(uuid.NewV7())) }

func compact(u uuid.UUID) string {
	b, _ := u.MarshalText()
	out := make([]byte, 0, 32)
	for _, c := range b {
		if c != '-' {
			out = append(out, c)
		}
	}
	return string(out)
}

// eventNS seeds deterministic event ids, so a re-built event gets the same id.
var eventNS = uuid.MustParse("6f1d2b4e-5c1a-4f0e-9b8a-2d7c3e4f5a6b")

// NewEvent builds an outbox event whose id derives from its idempotency key.
func NewEvent(ws, typ, key, correlation string, depth int, payload any) (contracts.Event, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return contracts.Event{}, err
	}
	return contracts.Event{EventID: "evt_" + compact(uuid.NewSHA1(eventNS, []byte(ws+"\x00"+key))), WorkspaceID: ws, Type: typ,
		Source: contracts.EventSource, CorrelationID: correlation, Depth: depth, IdempotencyKey: key, Payload: b}, nil
}

func insertEvents(ctx context.Context, tx pgx.Tx, events []contracts.Event) error {
	for _, e := range events {
		if err := contracts.ValidateValue(contracts.SchemaEvent, e); err != nil {
			return fmt.Errorf("event %s: %w", e.Type, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO pipeline.pipeline_outbox
			(event_id, workspace_id, type, payload, payload_ref, correlation_id, depth, idempotency_key)
			VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8) ON CONFLICT DO NOTHING`,
			e.EventID, e.WorkspaceID, e.Type, []byte(e.Payload), e.PayloadRef, e.CorrelationID, e.Depth, e.IdempotencyKey); err != nil {
			return fmt.Errorf("outbox: %w", err)
		}
	}
	return nil
}

// ---- definitions and revisions --------------------------------------------------

// Revision is one immutable pipeline revision.
type Revision struct {
	WorkspaceID string
	PipelineID  string
	Revision    string
	Graph       json.RawMessage
	Plan        contracts.Plan
	CreatedBy   string
	CreatedAt   time.Time
}

// PutRevision stores a compiled revision and makes it current. A revision is
// its definition digest: re-proposing the same graph is a no-op that returns
// the stored revision (with the plan compiled the first time).
func (s *Store) PutRevision(ctx context.Context, ws, pipelineID, name, actor string, graph json.RawMessage, plan *contracts.Plan) (*Revision, bool, error) {
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return nil, false, err
	}
	created := false
	err = s.tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO pipeline.pipeline_definitions (workspace_id, pipeline_id, name, created_by)
			VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, pipeline_id) DO NOTHING`, ws, pipelineID, name, actor); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `INSERT INTO pipeline.pipeline_revisions (workspace_id, pipeline_id, revision, graph, plan, plan_digest, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
			ws, pipelineID, plan.DefinitionDigest, []byte(graph), planJSON, plan.Digest, actor)
		if err != nil {
			return err
		}
		created = tag.RowsAffected() == 1
		_, err = tx.Exec(ctx, `UPDATE pipeline.pipeline_definitions SET current_revision = $3, name = $4, updated_at = now()
			WHERE workspace_id = $1 AND pipeline_id = $2`, ws, pipelineID, plan.DefinitionDigest, name)
		return err
	})
	if err != nil {
		return nil, false, err
	}
	r, err := s.GetRevision(ctx, ws, pipelineID, plan.DefinitionDigest)
	return r, created, err
}

// GetRevision loads one revision.
func (s *Store) GetRevision(ctx context.Context, ws, pipelineID, revision string) (*Revision, error) {
	r := &Revision{WorkspaceID: ws, PipelineID: pipelineID, Revision: revision}
	var plan []byte
	err := s.Pool.QueryRow(ctx, `SELECT graph, plan, created_by, created_at FROM pipeline.pipeline_revisions
		WHERE workspace_id = $1 AND pipeline_id = $2 AND revision = $3`, ws, pipelineID, revision).
		Scan(&r.Graph, &plan, &r.CreatedBy, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return r, json.Unmarshal(plan, &r.Plan)
}

// CurrentRevision loads a definition's current revision.
func (s *Store) CurrentRevision(ctx context.Context, ws, pipelineID string) (*Revision, error) {
	var rev *string
	err := s.Pool.QueryRow(ctx, `SELECT current_revision FROM pipeline.pipeline_definitions
		WHERE workspace_id = $1 AND pipeline_id = $2 AND archived_at IS NULL`, ws, pipelineID).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && rev == nil) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.GetRevision(ctx, ws, pipelineID, *rev)
}

// ---- runs --------------------------------------------------------------------

// Run is a run row.
type Run struct {
	RunID              string
	WorkspaceID        string
	ProjectID          string
	PipelineID         string
	Revision           string
	PlanDigest         string
	State              string
	Trigger            contracts.RunTrigger
	Envelope           contracts.Envelope
	TargetRepoID       string
	TargetBranch       string
	Candidate          *contracts.Candidate
	Publish            *contracts.Publish
	Error              *contracts.ErrorEnvelope
	ApplicationVersion string
	Actor              string
	CorrelationID      string
	Version            int
	CreatedAt          time.Time
	UpdatedAt          time.Time
	DeadlineAt         time.Time
	FinishedAt         *time.Time
}

const runCols = `run_id, workspace_id, project_id, pipeline_id, revision, plan_digest, state, trigger_type,
	coalesce(source_event_id, ''), idempotency_key, envelope, target_repo_id, target_branch, candidate, publish, error,
	application_version, actor, coalesce(correlation_id, ''), version, created_at, updated_at, deadline_at, finished_at`

func scanRun(row pgx.Row) (*Run, error) {
	r := &Run{}
	var env, cand, pub, rerr []byte
	err := row.Scan(&r.RunID, &r.WorkspaceID, &r.ProjectID, &r.PipelineID, &r.Revision, &r.PlanDigest, &r.State,
		&r.Trigger.Type, &r.Trigger.SourceEventID, &r.Trigger.IdempotencyKey, &env, &r.TargetRepoID, &r.TargetBranch,
		&cand, &pub, &rerr, &r.ApplicationVersion, &r.Actor, &r.CorrelationID, &r.Version, &r.CreatedAt, &r.UpdatedAt,
		&r.DeadlineAt, &r.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(env, &r.Envelope); err != nil {
		return nil, err
	}
	for _, x := range []struct {
		b []byte
		v any
	}{{cand, &r.Candidate}, {pub, &r.Publish}, {rerr, &r.Error}} {
		if len(x.b) > 0 {
			if err := json.Unmarshal(x.b, x.v); err != nil {
				return nil, err
			}
		}
	}
	return r, nil
}

// CreateRun inserts a queued run, or returns the existing run for the same
// (workspace, idempotency key): a repeated start is not a second run.
func (s *Store) CreateRun(ctx context.Context, r *Run) (*Run, bool, error) {
	if err := contracts.ValidateValue(contracts.SchemaReproducibility, r.Envelope); err != nil {
		return nil, false, err
	}
	env, err := json.Marshal(r.Envelope)
	if err != nil {
		return nil, false, err
	}
	tag, err := s.Pool.Exec(ctx, `INSERT INTO pipeline.pipeline_runs
		(run_id, workspace_id, project_id, pipeline_id, revision, plan_digest, state, trigger_type, source_event_id,
		 idempotency_key, envelope, target_repo_id, target_branch, application_version, actor, correlation_id, deadline_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, NULLIF($8, ''), $9, $10, $11, $12, $13, $14, NULLIF($15, ''), $16)
		ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
		r.RunID, r.WorkspaceID, r.ProjectID, r.PipelineID, r.Revision, r.PlanDigest, r.Trigger.Type, r.Trigger.SourceEventID,
		r.Trigger.IdempotencyKey, env, r.TargetRepoID, r.TargetBranch, r.ApplicationVersion, r.Actor, r.CorrelationID, r.DeadlineAt)
	if err != nil {
		return nil, false, err
	}
	got, err := scanRun(s.Pool.QueryRow(ctx, `SELECT `+runCols+` FROM pipeline.pipeline_runs
		WHERE workspace_id = $1 AND idempotency_key = $2`, r.WorkspaceID, r.Trigger.IdempotencyKey))
	return got, tag.RowsAffected() == 1, err
}

// GetRun loads a run by id.
func (s *Store) GetRun(ctx context.Context, runID string) (*Run, error) {
	return scanRun(s.Pool.QueryRow(ctx, `SELECT `+runCols+` FROM pipeline.pipeline_runs WHERE run_id = $1`, runID))
}

// GetRunInWorkspace loads a run only if it belongs to ws (P§20 test 19:
// guessing another workspace's run id finds nothing).
func (s *Store) GetRunInWorkspace(ctx context.Context, ws, runID string) (*Run, error) {
	return scanRun(s.Pool.QueryRow(ctx, `SELECT `+runCols+` FROM pipeline.pipeline_runs WHERE run_id = $1 AND workspace_id = $2`, runID, ws))
}

// RunUpdate is what a transition may change besides the state.
type RunUpdate struct {
	Candidate *contracts.Candidate
	Publish   *contracts.Publish
	Error     *contracts.ErrorEnvelope
}

// Transition moves a run to `to` and enqueues its events, atomically. A run
// already in `to` is returned unchanged (a retried step); any other illegal
// move is ErrConflict wrapping domain.ErrTransition.
func (s *Store) Transition(ctx context.Context, runID, to string, upd func(*Run, *RunUpdate) error, events func(*Run) ([]contracts.Event, error)) (*Run, error) {
	var out *Run
	err := s.tx(ctx, func(tx pgx.Tx) error {
		r, err := scanRun(tx.QueryRow(ctx, `SELECT `+runCols+` FROM pipeline.pipeline_runs WHERE run_id = $1 FOR UPDATE`, runID))
		if err != nil {
			return err
		}
		if r.State == to {
			out = r
			return nil
		}
		if err := domain.CheckTransition(r.State, to); err != nil {
			return fmt.Errorf("%w: %w", ErrConflict, err)
		}
		u := RunUpdate{Candidate: r.Candidate, Publish: r.Publish, Error: r.Error}
		if upd != nil {
			if err := upd(r, &u); err != nil {
				return err
			}
		}
		cand, pub, rerr := jsonOrNil(u.Candidate), jsonOrNil(u.Publish), jsonOrNil(u.Error)
		var finished any
		if domain.Terminal(to) {
			finished = s.Now()
		}
		if _, err := tx.Exec(ctx, `UPDATE pipeline.pipeline_runs SET state = $2, candidate = $3, publish = $4, error = $5,
			version = version + 1, updated_at = now(), finished_at = coalesce($6, finished_at) WHERE run_id = $1`,
			runID, to, cand, pub, rerr, finished); err != nil {
			return err
		}
		r.State, r.Candidate, r.Publish, r.Error = to, u.Candidate, u.Publish, u.Error
		r.Version++
		if events != nil {
			evs, err := events(r)
			if err != nil {
				return err
			}
			if err := insertEvents(ctx, tx, evs); err != nil {
				return err
			}
		}
		out = r
		return nil
	})
	return out, err
}

func jsonOrNil(v any) []byte {
	switch x := v.(type) {
	case *contracts.Candidate:
		if x == nil {
			return nil
		}
	case *contracts.Publish:
		if x == nil {
			return nil
		}
	case *contracts.ErrorEnvelope:
		if x == nil {
			return nil
		}
	}
	b, _ := json.Marshal(v)
	return b
}

// ExpiredRuns lists non-terminal runs past their deadline (the reconciler fails them).
func (s *Store) ExpiredRuns(ctx context.Context, now time.Time, limit int) ([]string, error) {
	rows, err := s.Pool.Query(ctx, `SELECT run_id FROM pipeline.pipeline_runs
		WHERE state IN ('queued', 'running', 'publishing') AND deadline_at < $1 ORDER BY deadline_at LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// ---- steps and attempts ----------------------------------------------------------

// StepUpdate changes a logical step.
type StepUpdate struct {
	State            string
	JobID            string
	Attempts         int
	Outputs          map[string]contracts.PortValue
	ItemsIn          *int
	ItemsOut         *int
	ItemsQuarantined *int
	Error            *contracts.ErrorEnvelope
}

var stepTerminal = map[string]bool{domain.StepSucceeded: true, domain.StepFailed: true, domain.StepSkipped: true, domain.StepCancelled: true}

// SetStep upserts a logical step (run, step, partition) and its events in one
// transaction. Terminal steps never change again: a replayed engine step that
// tries to re-record an outcome gets the stored row back.
func (s *Store) SetStep(ctx context.Context, ws, runID, stepID, partitionID string, u StepUpdate, events []contracts.Event) (contracts.StepExecution, error) {
	id := domain.StepExecutionID(runID, stepID, partitionID)
	var out contracts.StepExecution
	err := s.tx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO pipeline.step_executions (step_execution_id, run_id, workspace_id, step_id, partition_id, state)
			VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT DO NOTHING`, id, runID, ws, stepID, partitionID); err != nil {
			return err
		}
		cur, err := scanStep(tx.QueryRow(ctx, `SELECT `+stepCols+` FROM pipeline.step_executions WHERE step_execution_id = $1 FOR UPDATE`, id))
		if err != nil {
			return err
		}
		if stepTerminal[cur.State] {
			out = cur
			return nil
		}
		outputs := []byte(nil)
		if u.Outputs != nil {
			outputs, _ = json.Marshal(u.Outputs)
		}
		now := s.Now()
		var started, finished any
		if u.State == domain.StepRunning && cur.StartedAt == nil {
			started = now
		}
		if stepTerminal[u.State] {
			finished = now
		}
		if _, err := tx.Exec(ctx, `UPDATE pipeline.step_executions SET state = $2, job_id = coalesce(NULLIF($3, ''), job_id),
			attempts = greatest(attempts, $4), outputs = coalesce($5, outputs), items_in = coalesce($6, items_in),
			items_out = coalesce($7, items_out), items_quarantined = coalesce($8, items_quarantined), error = coalesce($9, error),
			started_at = coalesce(started_at, $10), finished_at = coalesce($11, finished_at), updated_at = now()
			WHERE step_execution_id = $1`, id, u.State, u.JobID, u.Attempts, outputs, u.ItemsIn, u.ItemsOut, u.ItemsQuarantined,
			jsonOrNil(u.Error), started, finished); err != nil {
			return err
		}
		if err := insertEvents(ctx, tx, events); err != nil {
			return err
		}
		out, err = scanStep(tx.QueryRow(ctx, `SELECT `+stepCols+` FROM pipeline.step_executions WHERE step_execution_id = $1`, id))
		return err
	})
	return out, err
}

const stepCols = `step_id, partition_id, state, attempts, coalesce(job_id, ''), started_at, finished_at, items_in, items_out, items_quarantined, error`

func scanStep(row pgx.Row) (contracts.StepExecution, error) {
	var se contracts.StepExecution
	var rerr []byte
	err := row.Scan(&se.StepID, &se.PartitionID, &se.State, &se.Attempts, &se.JobID, &se.StartedAt, &se.FinishedAt,
		&se.ItemsIn, &se.ItemsOut, &se.ItemsQuarantined, &rerr)
	if errors.Is(err, pgx.ErrNoRows) {
		return se, ErrNotFound
	}
	if err != nil {
		return se, err
	}
	if len(rerr) > 0 {
		se.Error = &contracts.ErrorEnvelope{}
		if err := json.Unmarshal(rerr, se.Error); err != nil {
			return se, err
		}
	}
	for _, t := range []**time.Time{&se.StartedAt, &se.FinishedAt} {
		if *t != nil {
			u := (*t).UTC()
			*t = &u
		}
	}
	return se, nil
}

// StepOutputs returns a finished step partition's outputs.
func (s *Store) StepOutputs(ctx context.Context, runID, stepID, partitionID string) (map[string]contracts.PortValue, error) {
	var b []byte
	err := s.Pool.QueryRow(ctx, `SELECT outputs FROM pipeline.step_executions WHERE step_execution_id = $1`,
		domain.StepExecutionID(runID, stepID, partitionID)).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil || len(b) == 0 {
		return nil, err
	}
	out := map[string]contracts.PortValue{}
	return out, json.Unmarshal(b, &out)
}

// ListSteps returns a run's logical steps in a stable order.
func (s *Store) ListSteps(ctx context.Context, runID string) ([]contracts.StepExecution, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+stepCols+` FROM pipeline.step_executions WHERE run_id = $1
		ORDER BY coalesce(started_at, updated_at), step_id, length(partition_id), partition_id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []contracts.StepExecution{}
	for rows.Next() {
		se, err := scanStep(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, se)
	}
	return out, rows.Err()
}

// Attempt is one observed attempt of a step partition.
type Attempt struct {
	WorkspaceID, RunID, StepID, PartitionID string
	Attempt                                 int
	JobID, State, ResultRef                 string
	Error                                   *contracts.ErrorEnvelope
}

// RecordAttempt stores an attempt; recording the same attempt twice keeps the
// first terminal outcome.
func (s *Store) RecordAttempt(ctx context.Context, a Attempt) error {
	se := domain.StepExecutionID(a.RunID, a.StepID, a.PartitionID)
	var finished any
	if a.State != "running" {
		finished = s.Now()
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO pipeline.step_attempts (attempt_id, step_execution_id, workspace_id, attempt, job_id, state, result_ref, error, finished_at)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, NULLIF($7, ''), $8, $9)
		ON CONFLICT (step_execution_id, attempt) DO UPDATE SET state = EXCLUDED.state, result_ref = coalesce(EXCLUDED.result_ref, pipeline.step_attempts.result_ref),
			error = coalesce(EXCLUDED.error, pipeline.step_attempts.error), finished_at = coalesce(pipeline.step_attempts.finished_at, EXCLUDED.finished_at)
		WHERE pipeline.step_attempts.state = 'running'`,
		fmt.Sprintf("%s#%d", se, a.Attempt), se, a.WorkspaceID, a.Attempt, a.JobID, a.State, a.ResultRef, jsonOrNil(a.Error), finished)
	return err
}

// ---- artifacts -------------------------------------------------------------------

// Artifact is a staged blob.
type Artifact struct {
	WorkspaceID, RunID, StepID, PartitionID string
	Attempt                                 int
	Name, Role                              string
	Ref                                     contracts.ArtifactRef
}

// RecordArtifacts stores staged blobs. Keys are attempt-unique and immutable:
// the same key with a different digest is ErrImmutable (P§20 test 6).
func (s *Store) RecordArtifacts(ctx context.Context, arts []Artifact) error {
	return s.tx(ctx, func(tx pgx.Tx) error {
		for _, a := range arts {
			if _, err := tx.Exec(ctx, `INSERT INTO pipeline.run_artifacts (blob_key, workspace_id, run_id, step_id, partition_id, attempt, name, role, digest, size_bytes, media_type)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (blob_key) DO NOTHING`,
				a.Ref.Key, a.WorkspaceID, a.RunID, a.StepID, a.PartitionID, a.Attempt, a.Name, a.Role, a.Ref.Digest, a.Ref.Size, a.Ref.MediaType); err != nil {
				return err
			}
			var digest string
			if err := tx.QueryRow(ctx, `SELECT digest FROM pipeline.run_artifacts WHERE blob_key = $1`, a.Ref.Key).Scan(&digest); err != nil {
				return err
			}
			if digest != a.Ref.Digest {
				return fmt.Errorf("%w: %s", ErrImmutable, a.Ref.Key)
			}
		}
		return nil
	})
}

// ListArtifacts returns a run's staged blobs.
func (s *Store) ListArtifacts(ctx context.Context, runID string) ([]Artifact, error) {
	rows, err := s.Pool.Query(ctx, `SELECT workspace_id, run_id, step_id, partition_id, attempt, name, role, blob_key, digest, size_bytes, media_type
		FROM pipeline.run_artifacts WHERE run_id = $1 ORDER BY step_id, blob_key`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Artifact
	for rows.Next() {
		var a Artifact
		if err := rows.Scan(&a.WorkspaceID, &a.RunID, &a.StepID, &a.PartitionID, &a.Attempt, &a.Name, &a.Role,
			&a.Ref.Key, &a.Ref.Digest, &a.Ref.Size, &a.Ref.MediaType); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ---- run record --------------------------------------------------------------------

// Record assembles the API's run record.
func (s *Store) Record(ctx context.Context, r *Run) (*contracts.RunRecord, error) {
	steps, err := s.ListSteps(ctx, r.RunID)
	if err != nil {
		return nil, err
	}
	return &contracts.RunRecord{RunID: r.RunID, WorkspaceID: r.WorkspaceID, ProjectID: r.ProjectID, DefinitionID: r.PipelineID,
		DefinitionRevision: r.Revision, PlanDigest: r.PlanDigest, State: r.State, Trigger: r.Trigger, Envelope: r.Envelope,
		Steps: steps, Candidate: r.Candidate, Publish: r.Publish, Error: r.Error, CreatedAt: r.CreatedAt.UTC(),
		UpdatedAt: r.UpdatedAt.UTC(), DeadlineAt: r.DeadlineAt.UTC()}, nil
}

// ---- outbox and inbox ---------------------------------------------------------------

// Emit enqueues events outside a state change (e.g. step progress).
func (s *Store) Emit(ctx context.Context, events ...contracts.Event) error {
	return s.tx(ctx, func(tx pgx.Tx) error { return insertEvents(ctx, tx, events) })
}

// Dispatch hands up to limit pending outbox events to send, oldest first, and
// marks those it accepted. Rows are locked with SKIP LOCKED so replicas don't
// double-send; a crash before commit redelivers (at least once; receivers
// dedupe on event_id, P§20 test 8).
func (s *Store) Dispatch(ctx context.Context, limit int, send func(context.Context, contracts.Event) error) (int, error) {
	n := 0
	err := s.tx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id, event_id, workspace_id, type, payload, coalesce(payload_ref, ''), coalesce(correlation_id, ''),
			depth, idempotency_key FROM pipeline.pipeline_outbox WHERE dispatched_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, limit)
		if err != nil {
			return err
		}
		type pending struct {
			id int64
			ev contracts.Event
		}
		var batch []pending
		for rows.Next() {
			var p pending
			var payload []byte
			if err := rows.Scan(&p.id, &p.ev.EventID, &p.ev.WorkspaceID, &p.ev.Type, &payload, &p.ev.PayloadRef,
				&p.ev.CorrelationID, &p.ev.Depth, &p.ev.IdempotencyKey); err != nil {
				rows.Close()
				return err
			}
			p.ev.Payload, p.ev.Source = payload, contracts.EventSource
			batch = append(batch, p)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, p := range batch {
			if err := send(ctx, p.ev); err != nil {
				if _, uerr := tx.Exec(ctx, `UPDATE pipeline.pipeline_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
					p.id, truncate(err.Error(), 500)); uerr != nil {
					return uerr
				}
				return nil // keep order: stop at the first failure, commit what was sent
			}
			if _, err := tx.Exec(ctx, `UPDATE pipeline.pipeline_outbox SET dispatched_at = now(), attempts = attempts + 1 WHERE id = $1`, p.id); err != nil {
				return err
			}
			n++
		}
		return nil
	})
	return n, err
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// Inbox applies f at most once per (consumer, event id): the dedupe row and
// f's writes commit together, so a redelivered event is a no-op.
func (s *Store) Inbox(ctx context.Context, consumer, eventID, ws string, f func(pgx.Tx) error) (bool, error) {
	applied := false
	err := s.tx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `INSERT INTO pipeline.pipeline_inbox_dedupe (consumer, event_id, workspace_id) VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, consumer, eventID, ws)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		applied = true
		if f != nil {
			return f(tx)
		}
		return nil
	})
	return applied, err
}

// IsUniqueViolation reports a Postgres unique violation.
func IsUniqueViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}
