// Package dbos implements engine.Engine on DBOS Transact Go (github.com/dbos-inc/dbos-transact-golang,
// pinned in go.mod). It is the only package that imports DBOS.
//
// Configuration comes only from the caller (internal/config): the system database URL
// (PIPELINE_ENGINE_DATABASE_URL), the application version (PIPELINE_APP_VERSION, the
// workflow package digest) and the executor ID. DBOS Conductor is never configured; New
// refuses to return an engine whose version or executor ID DBOS overrode from its own env.
//
// Recovery model (DBOS without Conductor): Launch recovers the pending workflows of this
// executor ID at this application version. Replicas therefore need stable executor IDs (a
// StatefulSet ordinal, or a reconciler that calls Resume for workflows whose executor is
// gone). Enqueued workflows carry the version that enqueued them and are dequeued only by
// executors of that version (or, unversioned, by the latest version).
package dbos

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/dbos-inc/dbos-transact-golang/dbos"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/pipeline/internal/engine"
)

// AppName scopes the DBOS rows this service owns in the engine database.
const AppName = "pipeline"

// Options configure an engine. DatabaseURL, AppVersion and ExecutorID are required.
type Options struct {
	DatabaseURL string // the pipeline_engine database
	AppVersion  string // workflow package digest (E3)
	ExecutorID  string // stable per replica
	PoolMax     int32  // connections to the engine database (part of the role's budget)
	Logger      *slog.Logger
	// MaxRecoveryAttempts is the default poison-pill bound for registered workflows.
	MaxRecoveryAttempts int
}

// Engine is the DBOS implementation of engine.Engine.
type Engine struct {
	dctx dbos.Context
	pool *pgxpool.Pool
	opts Options

	mu        sync.Mutex
	workflows map[string]*registered
	queues    map[string]dbos.Queue
}

// registered binds one workflow body to a DBOS configured instance. DBOS keys its registry
// by function name, which every closure (and every method value) shares, so each workflow
// is a method value on its own instance, told apart by ConfigName = the workflow name.
// Recovery finds it again from the recorded (name, config name) pair.
type registered struct {
	name string
	fn   engine.WorkflowFunc
	e    *Engine
}

func (r *registered) ConfigName() string { return r.name }

func (r *registered) run(dctx dbos.Context, in json.RawMessage) (json.RawMessage, error) {
	return r.fn(&wfContext{Context: dctx, e: r.e}, in)
}

var _ engine.Engine = (*Engine)(nil)

// New connects to the engine database (running DBOS's migrations) without launching.
func New(ctx context.Context, o Options) (*Engine, error) {
	if o.DatabaseURL == "" || o.AppVersion == "" || o.ExecutorID == "" {
		return nil, errors.New("engine/dbos: DatabaseURL, AppVersion and ExecutorID are required")
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	pc, err := pgxpool.ParseConfig(o.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("engine/dbos: parse database URL: %w", err)
	}
	if o.PoolMax > 0 {
		pc.MaxConns = o.PoolMax
	}
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("engine/dbos: connect: %w", err)
	}
	dctx, err := dbos.NewContext(ctx, dbos.Config{
		AppName:            AppName,
		SystemDBPool:       pool,
		ApplicationVersion: o.AppVersion,
		ExecutorID:         o.ExecutorID,
		Logger:             o.Logger,
	})
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("engine/dbos: init: %w", err)
	}
	// DBOS lets DBOS__APPVERSION / DBOS__VMID override these; ours are the only source.
	if dctx.GetApplicationVersion() != o.AppVersion || dctx.GetExecutorID() != o.ExecutorID {
		_ = dctx.Shutdown(dctx, time.Second)
		pool.Close()
		return nil, errors.New("engine/dbos: application version or executor ID overridden by the environment")
	}
	return &Engine{dctx: dctx, pool: pool, opts: o,
		workflows: map[string]*registered{}, queues: map[string]dbos.Queue{}}, nil
}

// Pool is the engine database pool (for readiness checks and measurements).
func (e *Engine) Pool() *pgxpool.Pool { return e.pool }

func (e *Engine) AppVersion() string { return e.opts.AppVersion }
func (e *Engine) ExecutorID() string { return e.opts.ExecutorID }

func (e *Engine) RegisterWorkflow(name string, fn engine.WorkflowFunc, opts ...engine.RegisterOption) error {
	ro := engine.ApplyRegisterOptions(opts)
	if ro.MaxRecoveryAttempts == 0 {
		ro.MaxRecoveryAttempts = e.opts.MaxRecoveryAttempts
	}
	r := &registered{name: name, fn: fn, e: e}
	regOpts := []dbos.WorkflowRegistrationOption{dbos.WithWorkflowName(name), dbos.WithInstance(r)}
	if ro.MaxRecoveryAttempts > 0 {
		regOpts = append(regOpts, dbos.WithMaxRecoveryAttempts(ro.MaxRecoveryAttempts))
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, dup := e.workflows[name]; dup {
		return fmt.Errorf("engine/dbos: workflow %q registered twice", name)
	}
	if err := registerWorkflow(e.dctx, r.run, regOpts); err != nil {
		return err
	}
	e.workflows[name] = r
	return nil
}

// registerWorkflow turns DBOS's registration panics (after Launch, duplicates) into errors.
func registerWorkflow(dctx dbos.Context, wf dbos.Workflow[json.RawMessage, json.RawMessage], opts []dbos.WorkflowRegistrationOption) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("engine/dbos: register workflow: %v", r)
		}
	}()
	dbos.RegisterWorkflow(dctx, wf, opts...)
	return nil
}

func (e *Engine) RegisterQueue(q engine.QueueSpec) error {
	opts := []dbos.QueueOption{dbos.WithQueueOnConflict(dbos.QueueConflictAlwaysUpdate)}
	if q.Concurrency != nil {
		opts = append(opts, dbos.WithGlobalConcurrency(*q.Concurrency))
	}
	if q.WorkerConcurrency != nil {
		opts = append(opts, dbos.WithWorkerConcurrency(*q.WorkerConcurrency))
	}
	if q.PartitionConcurrency != nil {
		opts = append(opts, dbos.WithPartitionConcurrency(*q.PartitionConcurrency))
	}
	if q.PriorityEnabled {
		opts = append(opts, dbos.WithPriorityEnabled())
	}
	if q.PollInterval > 0 {
		opts = append(opts, dbos.WithQueueBasePollingInterval(q.PollInterval))
	}
	dq, err := dbos.RegisterQueue(e.dctx, q.Name, opts...)
	if err != nil {
		return fmt.Errorf("engine/dbos: register queue %s: %w", q.Name, err)
	}
	e.mu.Lock()
	e.queues[q.Name] = dq
	e.mu.Unlock()
	return nil
}

func (e *Engine) queue(name string) (dbos.Queue, error) {
	e.mu.Lock()
	q, ok := e.queues[name]
	e.mu.Unlock()
	if ok {
		return q, nil
	}
	q, err := dbos.RetrieveQueue(e.dctx, name)
	if err != nil {
		return nil, fmt.Errorf("engine/dbos: queue %s: %w", name, err)
	}
	e.mu.Lock()
	e.queues[name] = q
	e.mu.Unlock()
	return q, nil
}

func (e *Engine) Launch(context.Context) error { return e.dctx.Launch() }

func (e *Engine) Shutdown(timeout time.Duration) error {
	err := e.dctx.Shutdown(e.dctx, timeout)
	e.pool.Close()
	return err
}

func (e *Engine) workflow(name string) (*registered, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	r, ok := e.workflows[name]
	if !ok {
		return nil, fmt.Errorf("engine/dbos: workflow %q is not registered", name)
	}
	return r, nil
}

// start runs or enqueues a workflow from dctx (the root context, or a workflow's for a child).
func (e *Engine) start(dctx dbos.Context, req engine.StartRequest) (string, error) {
	r, err := e.workflow(req.Workflow)
	if err != nil {
		return "", err
	}
	opts := []dbos.WorkflowOption{dbos.WithRunInstance(r)}
	if req.ID != "" {
		opts = append(opts, dbos.WithWorkflowID(req.ID))
	}
	if req.Queue != "" {
		q, err := e.queue(req.Queue)
		if err != nil {
			return "", err
		}
		opts = append(opts, dbos.WithQueue(q))
		if req.PartitionKey != "" {
			opts = append(opts, dbos.WithQueuePartitionKey(req.PartitionKey))
		}
		if req.Priority > 0 {
			opts = append(opts, dbos.WithPriority(req.Priority))
		}
	}
	if req.AppVersion != "" {
		opts = append(opts, dbos.WithApplicationVersion(req.AppVersion))
	}
	runCtx := dctx
	if req.Deadline > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = dbos.WithTimeout(dctx, req.Deadline)
		if req.Queue != "" {
			// Enqueued: DBOS records the timeout and starts the clock at dequeue, under
			// the queue runner's context, so this one can go.
			defer cancel()
		}
		// Run directly, the workflow's context descends from runCtx and DBOS durably
		// cancels a workflow whose context is cancelled: let the timer fire at the
		// deadline (DBOS treats that as the deadline, which it also enforces durably).
	}
	input := req.Input
	if input == nil {
		input = json.RawMessage("null")
	}
	h, err := dbos.RunWorkflow(runCtx, r.run, input, opts...)
	if err != nil {
		return "", mapErr(err)
	}
	return h.GetWorkflowID(), nil
}

// Start runs under the engine's root context, never the caller's: a workflow's context
// descends from the one it was started on, and DBOS durably cancels a workflow whose context
// is cancelled, so starting on a request context would cancel the run when the request ends.
func (e *Engine) Start(_ context.Context, req engine.StartRequest) (string, error) {
	return e.start(e.dctx, req)
}

func (e *Engine) Await(ctx context.Context, id string, timeout time.Duration) (json.RawMessage, error) {
	c := dbos.From(e.dctx, ctx)
	h, err := dbos.RetrieveWorkflow[json.RawMessage](c, id)
	if err != nil {
		return nil, mapErr(err)
	}
	opts := []dbos.GetResultOption{dbos.WithHandlePollingInterval(50 * time.Millisecond)}
	if timeout > 0 {
		opts = append(opts, dbos.WithHandleTimeout(timeout))
	}
	out, err := h.GetResult(opts...)
	if err != nil {
		return nil, mapErr(err)
	}
	return out, nil
}

func (e *Engine) Send(ctx context.Context, id, topic string, msg json.RawMessage, key string) error {
	opts := []dbos.SendOption{dbos.WithSendToForks()}
	if key != "" {
		opts = append(opts, dbos.WithIdempotencyKey(key))
	}
	if msg == nil {
		msg = json.RawMessage("null")
	}
	return mapErr(dbos.Send(dbos.From(e.dctx, ctx), id, msg, topic, opts...))
}

func (e *Engine) Cancel(ctx context.Context, id string) error {
	return mapErr(dbos.CancelWorkflow(dbos.From(e.dctx, ctx), id, dbos.WithCancelChildren()))
}

func (e *Engine) Resume(ctx context.Context, id string) error {
	_, err := dbos.ResumeWorkflow[json.RawMessage](dbos.From(e.dctx, ctx), id)
	return mapErr(err)
}

func (e *Engine) Fork(ctx context.Context, req engine.ForkRequest) (string, error) {
	if req.FromStep < 0 {
		return "", errors.New("engine/dbos: FromStep must be >= 0")
	}
	h, err := dbos.ForkWorkflow[json.RawMessage](dbos.From(e.dctx, ctx), dbos.ForkWorkflowInput{
		OriginalWorkflowID: req.WorkflowID,
		ForkedWorkflowID:   req.NewID,
		StartStep:          uint(req.FromStep),
		ApplicationVersion: req.AppVersion,
		QueueName:          req.Queue,
		QueuePartitionKey:  req.PartitionKey,
	})
	if err != nil {
		return "", mapErr(err)
	}
	return h.GetWorkflowID(), nil
}

func (e *Engine) Get(ctx context.Context, id string) (engine.WorkflowInfo, error) {
	ws, err := e.List(ctx, engine.ListFilter{IDs: []string{id}})
	if err != nil {
		return engine.WorkflowInfo{}, err
	}
	if len(ws) == 0 {
		return engine.WorkflowInfo{}, engine.ErrNotFound
	}
	return ws[0], nil
}

func (e *Engine) List(ctx context.Context, f engine.ListFilter) ([]engine.WorkflowInfo, error) {
	opts := []dbos.ListWorkflowsOption{dbos.WithFilterLoadOutput(true), dbos.WithFilterLoadInput(false)}
	if len(f.IDs) > 0 {
		opts = append(opts, dbos.WithFilterWorkflowIDs(f.IDs...))
	}
	if f.IDPrefix != "" {
		opts = append(opts, dbos.WithFilterWorkflowIDPrefix(f.IDPrefix))
	}
	if f.Workflow != "" {
		opts = append(opts, dbos.WithFilterName(f.Workflow))
	}
	if len(f.Statuses) > 0 {
		var ss []dbos.WorkflowStatusType
		for _, s := range f.Statuses {
			ss = append(ss, toDBOSStatus(s)...)
		}
		opts = append(opts, dbos.WithFilterStatus(ss...))
	}
	if len(f.AppVersions) > 0 {
		opts = append(opts, dbos.WithFilterAppVersion(f.AppVersions...))
	}
	if len(f.ExecutorIDs) > 0 {
		opts = append(opts, dbos.WithFilterExecutorIDs(f.ExecutorIDs...))
	}
	if f.Queue != "" {
		opts = append(opts, dbos.WithFilterQueueName(f.Queue))
	}
	if f.Limit > 0 {
		opts = append(opts, dbos.WithFilterLimit(f.Limit))
	}
	if f.Desc {
		opts = append(opts, dbos.WithFilterSortDesc())
	}
	ws, err := dbos.ListWorkflows(dbos.From(e.dctx, ctx), opts...)
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]engine.WorkflowInfo, 0, len(ws))
	for _, w := range ws {
		info := engine.WorkflowInfo{
			ID: w.ID, Workflow: w.Name, Status: fromDBOSStatus(w.Status), AppVersion: w.ApplicationVersion,
			ExecutorID: w.ExecutorID, Queue: w.QueueName, PartitionKey: w.QueuePartitionKey,
			ForkedFrom: w.ForkedFrom, ParentID: w.ParentWorkflowID, Attempts: w.Attempts,
			CreatedAt: w.CreatedAt, StartedAt: w.StartedAt, CompletedAt: w.CompletedAt, Deadline: w.Deadline,
			Output: rawValue(w.Output),
		}
		if w.Error != nil {
			info.Error = w.Error.Error()
		}
		out = append(out, info)
	}
	return out, nil
}

func (e *Engine) Steps(ctx context.Context, id string) ([]engine.StepInfo, error) {
	ss, err := dbos.GetWorkflowSteps(dbos.From(e.dctx, ctx), id, dbos.WithStepsLoadOutput(true))
	if err != nil {
		return nil, mapErr(err)
	}
	out := make([]engine.StepInfo, 0, len(ss))
	for _, s := range ss {
		si := engine.StepInfo{ID: s.StepID, Name: s.StepName, ChildID: s.ChildWorkflowID,
			StartedAt: s.StartedAt, CompletedAt: s.CompletedAt, Output: rawValue(s.Output)}
		if s.Error != nil {
			si.Error = s.Error.Error()
		}
		out = append(out, si)
	}
	return out, nil
}

func (e *Engine) Purge(ctx context.Context, cutoff time.Time, limit int) (int, error) {
	if limit <= 0 {
		limit = 1000
	}
	c := dbos.From(e.dctx, ctx)
	ws, err := dbos.ListWorkflows(c, dbos.WithFilterStatus(dbos.WorkflowStatusSuccess, dbos.WorkflowStatusError, dbos.WorkflowStatusCancelled),
		dbos.WithFilterCompletedBefore(cutoff), dbos.WithFilterLimit(limit), dbos.WithFilterLoadInput(false), dbos.WithFilterLoadOutput(false))
	if err != nil || len(ws) == 0 {
		return 0, mapErr(err)
	}
	ids := make([]string, len(ws))
	for i, w := range ws {
		ids[i] = w.ID
	}
	if err := dbos.DeleteWorkflows(c, ids); err != nil {
		return 0, mapErr(err)
	}
	return len(ids), nil
}

// rawValue normalises a listed output (DBOS returns it decoded as `any`, or as the
// serialized string) to JSON.
func rawValue(v any) json.RawMessage {
	switch t := v.(type) {
	case nil:
		return nil
	case json.RawMessage:
		return t
	case []byte:
		return t
	case string:
		if json.Valid([]byte(t)) {
			return json.RawMessage(t)
		}
	case *string:
		if t == nil {
			return nil
		}
		return rawValue(*t)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func toDBOSStatus(s engine.Status) []dbos.WorkflowStatusType {
	switch s {
	case engine.StatusEnqueued:
		return []dbos.WorkflowStatusType{dbos.WorkflowStatusEnqueued, dbos.WorkflowStatusDelayed}
	case engine.StatusPending:
		return []dbos.WorkflowStatusType{dbos.WorkflowStatusPending}
	case engine.StatusSuccess:
		return []dbos.WorkflowStatusType{dbos.WorkflowStatusSuccess}
	case engine.StatusError:
		return []dbos.WorkflowStatusType{dbos.WorkflowStatusError}
	case engine.StatusCancelled:
		return []dbos.WorkflowStatusType{dbos.WorkflowStatusCancelled}
	case engine.StatusStuck:
		return []dbos.WorkflowStatusType{dbos.WorkflowStatusMaxRecoveryAttemptsExceeded}
	}
	return nil
}

func fromDBOSStatus(s dbos.WorkflowStatusType) engine.Status {
	switch s {
	case dbos.WorkflowStatusEnqueued, dbos.WorkflowStatusDelayed:
		return engine.StatusEnqueued
	case dbos.WorkflowStatusPending:
		return engine.StatusPending
	case dbos.WorkflowStatusSuccess:
		return engine.StatusSuccess
	case dbos.WorkflowStatusError:
		return engine.StatusError
	case dbos.WorkflowStatusCancelled:
		return engine.StatusCancelled
	case dbos.WorkflowStatusMaxRecoveryAttemptsExceeded:
		return engine.StatusStuck
	}
	return engine.Status(string(s))
}

// mapErr translates DBOS sentinel errors to the engine's, keeping the original wrapped.
func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, dbos.ErrNonExistentWorkflow):
		return errors.Join(engine.ErrNotFound, err)
	case errors.Is(err, dbos.ErrWorkflowCancelled), errors.Is(err, dbos.ErrAwaitedWorkflowCancelled):
		return errors.Join(engine.ErrCancelled, err)
	case errors.Is(err, dbos.ErrTimeout):
		return errors.Join(engine.ErrTimeout, err)
	case errors.Is(err, dbos.ErrConflictingWorkflowID), errors.Is(err, dbos.ErrWorkflowIDInUse):
		return errors.Join(engine.ErrConflict, err)
	}
	// A fork onto an existing ID surfaces as the raw unique violation.
	var pe *pgconn.PgError
	if (errors.As(err, &pe) && pe.Code == "23505" && strings.Contains(pe.ConstraintName, "workflow_status")) ||
		strings.Contains(err.Error(), `"workflow_status_pkey" (SQLSTATE 23505)`) {
		return errors.Join(engine.ErrConflict, err)
	}
	return err
}

// wfContext is engine.Context over a DBOS workflow context.
type wfContext struct {
	dbos.Context
	e *Engine
}

func (c *wfContext) WorkflowID() string {
	id, _ := dbos.GetWorkflowID(c.Context)
	return id
}

func (c *wfContext) Step(name string, fn engine.StepFunc, opts ...engine.StepOption) (json.RawMessage, error) {
	o := engine.ApplyStepOptions(opts)
	sopts := []dbos.StepOption{dbos.WithStepName(name)}
	if o.MaxAttempts > 1 {
		sopts = append(sopts, dbos.WithStepMaxRetries(o.MaxAttempts-1))
		if o.BaseInterval > 0 {
			sopts = append(sopts, dbos.WithStepBaseInterval(o.BaseInterval))
		}
		if o.MaxInterval > 0 {
			sopts = append(sopts, dbos.WithStepMaxInterval(o.MaxInterval))
		}
		if o.Backoff > 0 {
			sopts = append(sopts, dbos.WithStepBackoffFactor(o.Backoff))
		}
		if o.Retryable != nil {
			sopts = append(sopts, dbos.WithStepRetryPredicate(o.Retryable))
		}
	}
	out, err := dbos.RunAsStep(c.Context, func(ctx context.Context) (json.RawMessage, error) {
		v, err := fn(ctx)
		if err != nil {
			return nil, err
		}
		if v == nil {
			v = json.RawMessage("null")
		}
		return v, nil
	}, sopts...)
	return out, mapErr(err)
}

func (c *wfContext) Recv(topic string, timeout time.Duration) (json.RawMessage, bool, error) {
	msg, err := dbos.Recv[json.RawMessage](c.Context, topic, timeout)
	if errors.Is(err, dbos.ErrTimeout) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, mapErr(err)
	}
	return msg, true, nil
}

func (c *wfContext) Sleep(d time.Duration) error {
	_, err := dbos.Sleep(c.Context, d)
	return mapErr(err)
}

func (c *wfContext) Now() (time.Time, error) {
	return dbos.RunAsStep(c.Context, func(context.Context) (time.Time, error) { return time.Now().UTC(), nil },
		dbos.WithStepName("engine.now"))
}

func (c *wfContext) StartChild(req engine.StartRequest) (string, error) {
	return c.e.start(c.Context, req)
}

func (c *wfContext) AwaitChild(id string) (json.RawMessage, error) {
	h, err := dbos.RetrieveWorkflow[json.RawMessage](c.Context, id)
	if err != nil {
		return nil, mapErr(err)
	}
	out, err := h.GetResult()
	return out, mapErr(err)
}
