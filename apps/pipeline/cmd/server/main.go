// Command server runs the pipeline service: the engine executor (DBOS), the kernel event
// consumer that wakes waiting workflows, and the HTTP probes (later the private run API).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"studio.local/pipeline/internal/config"
	enginedbos "studio.local/pipeline/internal/engine/dbos"
	"studio.local/pipeline/internal/kernel"
	"studio.local/pipeline/internal/server"
	"studio.local/pipeline/internal/triggers"
)

// gitSHA is set with -ldflags "-X main.gitSHA=...".
var gitSHA = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "pipeline:", err)
		os.Exit(1)
	}
}

func run() error {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// The `pipeline` schema in database studio (definitions, runs, lineage: the pipeline
	// workstream's tables). Each pool is at most PIPELINE_DB_POOL_MAX, so a pod uses at
	// most twice that against the role's CONNECTION LIMIT.
	pc, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return errors.New("parse PIPELINE_DATABASE_URL")
	}
	pc.MaxConns = int32(min(cfg.DBPoolMax, 1<<20)) //nolint:gosec // bounded
	db, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return fmt.Errorf("database: %w", err)
	}
	defer db.Close()

	eng, err := enginedbos.New(ctx, enginedbos.Options{
		DatabaseURL: cfg.EngineDatabaseURL, AppVersion: cfg.AppVersion, ExecutorID: cfg.ExecutorID,
		PoolMax: int32(min(cfg.DBPoolMax, 1<<20)), Logger: log.With("component", "engine"), //nolint:gosec // bounded
	})
	if err != nil {
		return err
	}
	kc := kernel.New(cfg.APIURL, cfg.APIToken)
	// Workflows and queues are registered here, before Launch (the pipeline workstream's
	// internal/workflows: PipelineWorkflow, PublishWorkflow), using kc for dispatch.
	if err := eng.Launch(ctx); err != nil {
		return fmt.Errorf("engine: %w", err)
	}
	defer func() {
		if err := eng.Shutdown(20 * time.Second); err != nil {
			log.Warn("engine shutdown", "error", err)
		}
	}()

	consumer := &triggers.Consumer{Feed: kc, Engine: eng, Log: log.With("component", "triggers"),
		Cursors: &triggers.PGCursor{Pool: eng.Pool(), Name: "kernel-jobs", Owner: cfg.ExecutorID}}
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			log.Error("trigger consumer stopped", "error", err)
		}
	}()

	go retention(ctx, log, eng, cfg.EngineRetention)

	mux := server.New(server.Info{GitSHA: gitSHA, AppVersion: cfg.AppVersion, ExecutorID: cfg.ExecutorID, Engine: server.EngineVersion()},
		map[string]server.Check{
			"database":        db.Ping,
			"engine_database": eng.Pool().Ping,
		})
	srv := &http.Server{Addr: ":" + strconv.Itoa(cfg.Port), Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "port", cfg.Port, "git_sha", gitSHA, "app_version", cfg.AppVersion, "executor_id", cfg.ExecutorID)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	drain, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	log.Info("shutting down")
	err = srv.Shutdown(drain)
	<-consumerDone
	return err
}

// retention purges engine records older than PIPELINE_ENGINE_RETENTION, hourly, in batches.
func retention(ctx context.Context, log *slog.Logger, eng *enginedbos.Engine, keep time.Duration) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		for {
			n, err := eng.Purge(ctx, time.Now().Add(-keep), 1000)
			if err != nil {
				if ctx.Err() == nil {
					log.Warn("engine retention", "error", err)
				}
				break
			}
			if n > 0 {
				log.Info("engine retention", "purged", n)
			}
			if n < 1000 {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
