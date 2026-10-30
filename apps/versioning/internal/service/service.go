// Package service implements the versioning operations. Handlers in
// internal/server translate HTTP to these calls; everything that must hold
// under concurrency (CAS on branch heads, idempotency, review transitions)
// lives here.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/authz"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/semanticdiff"
	"studio.local/versioning/internal/storage"
)

// Error is a typed service error rendered as problem+json.
type Error struct {
	Status      int
	Code        string
	Detail      string
	CurrentHead string
	Generation  int64
	Problems    []string
}

func (e *Error) Error() string { return e.Code + ": " + e.Detail }

func errf(status int, code, format string, a ...any) *Error {
	return &Error{Status: status, Code: code, Detail: fmt.Sprintf(format, a...)}
}

// Common errors.
var (
	ErrNotFound = errf(http.StatusNotFound, "not_found", "not found")
)

// AsError extracts a service error.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// Enqueuer inserts background jobs transactionally (River).
type Enqueuer interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) error
}

// Service wires the stores together.
type Service struct {
	DB        *storage.DB
	Git       *gitengine.Engine
	Blobs     storage.BlobStore
	Manifests *manifests.Store
	Rules     *semanticdiff.Rules
	Cfg       *config.Config
	Jobs      Enqueuer
	Limiter   *authz.RateLimiter
	Now       func() time.Time

	// Failpoint, when set, is called at named points of multi-step writes so
	// tests can simulate a crash (todo4 1.8). Nil in production.
	Failpoint func(name string) error
}

// New builds a Service.
func New(d *storage.DB, blobs storage.BlobStore, cfg *config.Config, rules *semanticdiff.Rules, jobs Enqueuer) *Service {
	s := &Service{
		DB: d, Blobs: blobs, Cfg: cfg, Rules: rules, Jobs: jobs, Now: time.Now,
		Git:       gitengine.New(d.Pool, cfg.GitCacheObjects),
		Manifests: &manifests.Store{IO: blobs, Keys: storage.ManifestKeys{}, Threshold: cfg.ChunkThreshold},
		Limiter:   authz.NewRateLimiter(),
	}
	return s
}

func (s *Service) failpoint(name string) error {
	if s.Failpoint == nil {
		return nil
	}
	return s.Failpoint(name)
}

// tx runs fn in a tenant-scoped transaction.
func (s *Service) tx(ctx context.Context, tenant string, fn func(q *db.Queries, tx pgx.Tx) error) error {
	return s.DB.InTenantTx(ctx, tenant, func(tx pgx.Tx) error { return fn(db.New(tx), tx) })
}

// read runs fn in a tenant-scoped transaction meant for reads.
func (s *Service) read(ctx context.Context, tenant string, fn func(q *db.Queries) error) error {
	return s.tx(ctx, tenant, func(q *db.Queries, _ pgx.Tx) error { return fn(q) })
}

func notFound(err error, what string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return errf(http.StatusNotFound, "not_found", "%s not found", what)
	}
	return err
}

// repo loads a repository and re-checks tenant and project scope (spec §2).
func (s *Service) repo(ctx context.Context, q *db.Queries, p *authn.Principal, repoID string) (db.VersioningDatasetRepository, error) {
	if !ids.Valid(repoID) {
		return db.VersioningDatasetRepository{}, errf(http.StatusNotFound, "not_found", "repository not found")
	}
	r, err := q.GetRepo(ctx, repoID)
	if err != nil {
		return r, notFound(err, "repository")
	}
	if err := authz.RepoInScope(p, r.TenantID, r.ProjectID); err != nil {
		return r, errf(http.StatusNotFound, "not_found", "repository not found")
	}
	return r, nil
}

func require(p *authn.Principal, scope string) error {
	if err := authz.RequireScope(p, scope); err != nil {
		return errf(http.StatusForbidden, "forbidden", "%v", err)
	}
	return nil
}

func ptr[T any](v T) *T { return &v }

func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// audit records who did what to which commit (spec §9, MVP exit criterion 6).
func (s *Service) audit(ctx context.Context, q *db.Queries, p *authn.Principal, repoID, event, entity, commit string, payload any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if payload == nil {
		b = []byte("{}")
	}
	return q.InsertAudit(ctx, db.InsertAuditParams{
		ID: ids.New(), TenantID: p.TenantID, RepoID: strOrNil(repoID), ActorID: p.Actor.ID, ActorKind: p.Actor.Kind,
		OnBehalfOf: strOrNil(p.Actor.OnBehalfOf), EventType: event, EntityID: entity, CommitOid: strOrNil(commit),
		Payload: b, RequestID: p.RequestID,
	})
}

// Event is the outbox payload (schemas/versioning/events.schema.json). It
// carries opaque ids and immutable oids only, never sample data (spec §12).
type Event struct {
	EventID    string            `json:"event_id"`
	EventType  string            `json:"event_type"`
	Version    int               `json:"version"`
	TenantID   string            `json:"tenant_id"`
	RepoID     string            `json:"repo_id"`
	EntityID   string            `json:"entity_id"`
	ActorID    string            `json:"actor_id"`
	OccurredAt time.Time         `json:"occurred_at"`
	Data       map[string]string `json:"data"`
}

// Event types (spec §12).
const (
	EvCommitCreated        = "versioning.commit.created"
	EvBranchUpdated        = "versioning.branch.updated"
	EvReviewOpened         = "versioning.review.opened"
	EvReviewChecksDone     = "versioning.review.checks_completed"
	EvReviewChecksRequest  = "versioning.review.checks_requested"
	EvReviewMerged         = "versioning.review.merged"
	EvReleasePublished     = "versioning.release.published"
	EvArtifactUnreferenced = "versioning.artifact.unreferenced"
)

func (s *Service) emit(ctx context.Context, q *db.Queries, p *authn.Principal, repoID, typ, entity string, data map[string]string) error {
	return emitAs(ctx, q, s.Now(), p.TenantID, p.Actor.ID, repoID, typ, entity, data)
}

func emitAs(ctx context.Context, q *db.Queries, now time.Time, tenant, actor, repoID, typ, entity string, data map[string]string) error {
	ev := Event{EventID: ids.New(), EventType: typ, Version: 1, TenantID: tenant, RepoID: repoID,
		EntityID: entity, ActorID: actor, OccurredAt: now.UTC(), Data: data}
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	return q.InsertOutbox(ctx, db.InsertOutboxParams{ID: ev.EventID, TenantID: tenant, EventType: typ, EntityID: entity, Payload: b})
}

func (s *Service) enqueue(ctx context.Context, tx pgx.Tx, args river.JobArgs) error {
	if s.Jobs == nil {
		return nil
	}
	return s.Jobs.InsertTx(ctx, tx, args, nil)
}
