// Package app wires the service from configuration; cmd/* and the
// integration tests share it.
package app

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/events"
	"studio.local/versioning/internal/gc"
	"studio.local/versioning/internal/jobs"
	"studio.local/versioning/internal/migrate"
	"studio.local/versioning/internal/reconcile"
	"studio.local/versioning/internal/semanticdiff"
	"studio.local/versioning/internal/server"
	"studio.local/versioning/internal/service"
	"studio.local/versioning/internal/storage"
)

// App is a wired service instance.
type App struct {
	Cfg       *config.Config
	Log       *slog.Logger
	DB        *storage.DB
	Blobs     storage.BlobStore
	Svc       *service.Service
	River     *river.Client[pgx.Tx]
	Relay     *events.Relay
	Reconcile *reconcile.Reconciler
	GC        *gc.Collector
	Handler   http.Handler
}

// Options override pieces for tests.
type Options struct {
	Blobs     storage.BlobStore
	Verifier  *authn.Verifier
	Publisher events.Publisher
	Periodic  bool
	GitSHA    string
}

// Build wires everything; it does not start the River client.
func Build(ctx context.Context, cfg *config.Config, log *slog.Logger, o Options) (*App, error) {
	d, err := storage.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	a := &App{Cfg: cfg, Log: log, DB: d}
	if a.Blobs = o.Blobs; a.Blobs == nil && cfg.ObjectStore == "gcs" {
		gcs, err := storage.NewGCS(ctx, storage.GCSConfig{ObjectBucket: cfg.ObjectBucket, ManifestBucket: cfg.ManifestBucket})
		if err != nil {
			return nil, err
		}
		a.Blobs = gcs
	}
	if a.Blobs == nil {
		s3, err := storage.NewS3(ctx, storage.S3Config{Endpoint: cfg.ObjectEndpoint, Region: cfg.ObjectRegion,
			PathStyle: cfg.ObjectPathStyle, AccessKeyID: cfg.S3AccessKeyID, SecretKey: cfg.S3SecretKey,
			ObjectBucket: cfg.ObjectBucket, ManifestBucket: cfg.ManifestBucket, TempDir: cfg.TempDir})
		if err != nil {
			return nil, err
		}
		a.Blobs = s3
	}
	rules, err := semanticdiff.LoadRules(cfg.DiffRulesDir)
	if err != nil {
		return nil, fmt.Errorf("diff rules: %w", err)
	}
	a.Svc = service.New(d, a.Blobs, cfg, rules, nil)
	pub := o.Publisher
	if pub == nil {
		switch cfg.EventBus {
		case "redis":
			if pub, err = events.NewRedisStreams(cfg.RedisURL); err != nil {
				return nil, err
			}
		default:
			pub = events.LogPublisher{Log: log}
		}
	}
	a.Relay = &events.Relay{DB: d, Publisher: pub, Prefix: cfg.EventSubject}
	now := time.Now
	a.Reconcile = &reconcile.Reconciler{DB: d, Git: a.Svc.Git, Blobs: a.Blobs, Manifests: a.Svc.Manifests, Log: log,
		OrphanGrace: time.Hour, OutboxLag: 10 * time.Minute, Recent: 24 * time.Hour, Now: now}
	a.GC = &gc.Collector{DB: d, Git: a.Svc.Git, Blobs: a.Blobs, Manifests: a.Svc.Manifests,
		HistoryRetention: cfg.HistoryRetention, Now: now}
	a.River, err = jobs.NewClient(jobs.Deps{DB: d, Svc: a.Svc, Relay: a.Relay, Reconcile: a.Reconcile, GC: a.GC, Log: log, Periodic: o.Periodic})
	if err != nil {
		return nil, err
	}
	a.Svc.Jobs = jobs.Enqueuer{C: a.River}
	v := o.Verifier
	if v == nil {
		if v, err = authn.NewVerifier(cfg.JWTPublicKeyFile, cfg.JWTAudience, cfg.JWTIssuer); err != nil {
			return nil, err
		}
	}
	h := &server.Handlers{Svc: a.Svc, GitSHA: o.GitSHA, Ready: a.ready, SchemaVersion: a.schemaVersion}
	a.Handler = server.New(server.Options{Handlers: h, Verifier: v, Log: log, MaxBodyBytes: cfg.MaxBodyBytes,
		MaxArtifactBytes: cfg.MaxArtifactBytes, RequestTimeout: cfg.RequestTimeout, UploadTimeout: 30 * time.Minute})
	return a, nil
}

func (a *App) ready(ctx context.Context) map[string]string {
	out := map[string]string{}
	c, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := a.DB.Pool.Ping(c); err != nil {
		out["postgres"] = "unreachable"
	} else {
		out["postgres"] = "ok"
	}
	c2, cancel2 := context.WithTimeout(ctx, 2*time.Second)
	defer cancel2()
	if err := a.Blobs.Ping(c2); err != nil {
		out["object_storage"] = "unreachable"
	} else {
		out["object_storage"] = "ok"
	}
	return out
}

func (a *App) schemaVersion(ctx context.Context) int64 {
	var v int64
	_ = a.DB.Pool.QueryRow(ctx, "SELECT coalesce(max(version_id), 0) FROM "+migrate.Schema+".goose_db_version WHERE is_applied").Scan(&v)
	return v
}

// Close releases resources.
func (a *App) Close() { a.DB.Close() }
