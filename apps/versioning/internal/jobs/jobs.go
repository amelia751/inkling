// Package jobs runs background work on River, a Postgres-native queue living
// in the versioning schema: artifact promotion, review checks, large diffs,
// the outbox relay, reconciliation and GC marking (todo4 V3).
package jobs

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"studio.local/versioning/internal/events"
	"studio.local/versioning/internal/gc"
	"studio.local/versioning/internal/migrate"
	"studio.local/versioning/internal/reconcile"
	"studio.local/versioning/internal/service"
	"studio.local/versioning/internal/storage"
)

// Deps are what the workers call into.
type Deps struct {
	DB        *storage.DB
	Svc       *service.Service
	Relay     *events.Relay
	Reconcile *reconcile.Reconciler
	GC        *gc.Collector
	Log       *slog.Logger
	// Periodic disables the scheduled jobs (tests drive them directly).
	Periodic bool
}

type promoteWorker struct {
	river.WorkerDefaults[service.ReconcileRootArgs]
	d Deps
}

func (w *promoteWorker) Work(ctx context.Context, j *river.Job[service.ReconcileRootArgs]) error {
	_, err := w.d.Svc.PromoteRoot(ctx, j.Args)
	return err
}

type checksWorker struct {
	river.WorkerDefaults[service.ReviewChecksArgs]
	d Deps
}

func (w *checksWorker) Work(ctx context.Context, j *river.Job[service.ReviewChecksArgs]) error {
	return w.d.Svc.RunChecks(ctx, j.Args)
}

func (w *checksWorker) Timeout(*river.Job[service.ReviewChecksArgs]) time.Duration {
	return 30 * time.Minute
}

type diffWorker struct {
	river.WorkerDefaults[service.DiffJobArgs]
	d Deps
}

func (w *diffWorker) Work(ctx context.Context, j *river.Job[service.DiffJobArgs]) error {
	return w.d.Svc.RunDiffJob(ctx, j.Args)
}

func (w *diffWorker) Timeout(*river.Job[service.DiffJobArgs]) time.Duration { return time.Hour }

type relayWorker struct {
	river.WorkerDefaults[service.OutboxRelayArgs]
	d Deps
}

func (w *relayWorker) Work(ctx context.Context, _ *river.Job[service.OutboxRelayArgs]) error {
	_, err := w.d.Relay.RunOnce(ctx)
	return err
}

type reconcileWorker struct {
	river.WorkerDefaults[service.ReconcileArgs]
	d Deps
}

func (w *reconcileWorker) Work(ctx context.Context, _ *river.Job[service.ReconcileArgs]) error {
	_, err := w.d.Reconcile.RunOnce(ctx)
	return err
}

type gcMarkWorker struct {
	river.WorkerDefaults[service.GCMarkArgs]
	d Deps
}

// Work marks reachability and starts the grace period of newly unreferenced
// artifacts. It never deletes; sweeping is cmd/gc's job.
func (w *gcMarkWorker) Work(ctx context.Context, _ *river.Job[service.GCMarkArgs]) error {
	tenants, err := tenantsOf(ctx, w.d.DB)
	if err != nil {
		return err
	}
	for _, t := range tenants {
		r, err := w.d.GC.Mark(ctx, t)
		if err != nil {
			return err
		}
		if _, err := w.d.GC.UpdateStatuses(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

// NewClient builds the River client with every worker and periodic job.
func NewClient(d Deps) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &promoteWorker{d: d})
	river.AddWorker(workers, &checksWorker{d: d})
	river.AddWorker(workers, &diffWorker{d: d})
	river.AddWorker(workers, &relayWorker{d: d})
	river.AddWorker(workers, &reconcileWorker{d: d})
	river.AddWorker(workers, &gcMarkWorker{d: d})
	cfg := &river.Config{
		Schema:  migrate.Schema,
		Queues:  map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 16}},
		Workers: workers,
		Logger:  d.Log,
	}
	if d.Periodic {
		unique := &river.InsertOpts{UniqueOpts: river.UniqueOpts{ByPeriod: time.Minute}}
		cfg.PeriodicJobs = []*river.PeriodicJob{
			river.NewPeriodicJob(river.PeriodicInterval(5*time.Second),
				func() (river.JobArgs, *river.InsertOpts) { return service.OutboxRelayArgs{}, nil },
				&river.PeriodicJobOpts{RunOnStart: true}),
			river.NewPeriodicJob(river.PeriodicInterval(time.Hour),
				func() (river.JobArgs, *river.InsertOpts) { return service.ReconcileArgs{}, unique }, nil),
			river.NewPeriodicJob(river.PeriodicInterval(24*time.Hour),
				func() (river.JobArgs, *river.InsertOpts) { return service.GCMarkArgs{}, unique }, nil),
		}
	}
	return river.NewClient(riverpgxv5.New(d.DB.Pool), cfg)
}

// Enqueuer adapts a River client to service.Enqueuer.
type Enqueuer struct{ C *river.Client[pgx.Tx] }

// InsertTx inserts a job in the caller's transaction.
func (e Enqueuer) InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) error {
	_, err := e.C.InsertTx(ctx, tx, args, opts)
	return err
}

func tenantsOf(ctx context.Context, d *storage.DB) ([]string, error) {
	rows, err := d.Pool.Query(ctx, "SELECT id FROM versioning.tenants ORDER BY id")
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
