package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/semanticdiff"
	"studio.local/versioning/internal/storage"
)

// DiffPage is one page of a diff, or a pending job.
type DiffPage struct {
	Result *semanticdiff.Result
	Page   []semanticdiff.Change
	Next   string
	JobID  string
	Status string // set when JobID is set: pending | running | failed
}

func (s *Service) differ(tenant string) *semanticdiff.Differ {
	return &semanticdiff.Differ{Roots: s.Manifests, Revisions: s.revisions(tenant), Rules: s.Rules}
}

// Diff answers small diffs synchronously and hands large ones to a job.
func (s *Service) Diff(ctx context.Context, p *authn.Principal, repoID, base, head, cursor string, limit int) (*DiffPage, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	if !s.Limiter.Allow("diff", p.Actor.ID, s.Cfg.RateDiffPerMinute) {
		return nil, errf(http.StatusTooManyRequests, "rate_limited", "diff rate limit exceeded")
	}
	limit = min(max(limit, 1), s.Cfg.MaxDiffPageSize)
	var baseRoot, headRoot string
	var existing *db.VersioningDiffJob
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		b, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: base})
		if err != nil {
			return notFound(err, "base commit")
		}
		h, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: head})
		if err != nil {
			return notFound(err, "head commit")
		}
		baseRoot, headRoot = b.ManifestRoot, h.ManifestRoot
		j, err := q.FindDiffJob(ctx, db.FindDiffJobParams{RepoID: repoID, BaseOid: base, HeadOid: head})
		if err == nil {
			existing = &j
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if existing != nil {
		return s.diffJobPage(ctx, p, repoID, *existing, cursor, limit)
	}
	br, err := s.Manifests.LoadRoot(ctx, p.TenantID, repoID, baseRoot)
	if err != nil {
		return nil, err
	}
	hr, err := s.Manifests.LoadRoot(ctx, p.TenantID, repoID, headRoot)
	if err != nil {
		return nil, err
	}
	if semanticdiff.Estimate(br, hr) > s.Cfg.SyncDiffMaxEntries {
		var job db.VersioningDiffJob
		err := s.tx(ctx, p.TenantID, func(q *db.Queries, tx pgx.Tx) error {
			var err error
			job, err = q.InsertDiffJob(ctx, db.InsertDiffJobParams{ID: ids.New(), TenantID: p.TenantID, RepoID: repoID, BaseOid: base, HeadOid: head})
			if err != nil {
				return err
			}
			return s.enqueue(ctx, tx, DiffJobArgs{TenantID: p.TenantID, RepoID: repoID, JobID: job.ID, BaseOID: base, HeadOID: head})
		})
		if err != nil {
			return nil, err
		}
		return &DiffPage{JobID: job.ID, Status: job.Status}, nil
	}
	res, err := s.differ(p.TenantID).Diff(ctx, p.TenantID, repoID, baseRoot, headRoot)
	if err != nil {
		return nil, err
	}
	return page(res, cursor, limit)
}

func page(res *semanticdiff.Result, cursor string, limit int) (*DiffPage, error) {
	pg, next, err := semanticdiff.Page(res, cursor, limit)
	if err != nil {
		return nil, errf(http.StatusBadRequest, "bad_request", "invalid cursor")
	}
	return &DiffPage{Result: res, Page: pg, Next: next}, nil
}

// GetDiffJob returns a finished job's page or its status.
func (s *Service) GetDiffJob(ctx context.Context, p *authn.Principal, repoID, jobID, cursor string, limit int) (*DiffPage, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var job db.VersioningDiffJob
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		if !ids.Valid(jobID) {
			return ErrNotFound
		}
		var err error
		job, err = q.GetDiffJob(ctx, db.GetDiffJobParams{RepoID: repoID, ID: jobID})
		return notFound(err, "diff job")
	}); err != nil {
		return nil, err
	}
	return s.diffJobPage(ctx, p, repoID, job, cursor, min(max(limit, 1), s.Cfg.MaxDiffPageSize))
}

func (s *Service) diffJobPage(ctx context.Context, p *authn.Principal, repoID string, job db.VersioningDiffJob, cursor string, limit int) (*DiffPage, error) {
	if job.Status != "done" || job.ResultKey == nil {
		return &DiffPage{JobID: job.ID, Status: job.Status}, nil
	}
	b, err := s.Blobs.GetManifest(ctx, *job.ResultKey)
	if err != nil {
		return nil, err
	}
	var res semanticdiff.Result
	if err := json.Unmarshal(b, &res); err != nil {
		return nil, err
	}
	return page(&res, cursor, limit)
}

// RunDiffJob computes a large diff and stores it as an artifact-backed result.
func (s *Service) RunDiffJob(ctx context.Context, a DiffJobArgs) error {
	set := func(status string, key *string) error {
		return s.tx(ctx, a.TenantID, func(q *db.Queries, _ pgx.Tx) error {
			return q.SetDiffJobStatus(ctx, db.SetDiffJobStatusParams{RepoID: a.RepoID, ID: a.JobID, Status: status, ResultKey: key})
		})
	}
	if err := set("running", nil); err != nil {
		return err
	}
	baseRoot, err := s.commitRoot(ctx, a.TenantID, a.RepoID, a.BaseOID)
	if err != nil {
		return err
	}
	headRoot, err := s.commitRoot(ctx, a.TenantID, a.RepoID, a.HeadOID)
	if err != nil {
		return err
	}
	res, err := s.differ(a.TenantID).Diff(ctx, a.TenantID, a.RepoID, baseRoot, headRoot)
	if err != nil {
		_ = set("failed", nil)
		return err
	}
	b, err := json.Marshal(res)
	if err != nil {
		return err
	}
	key := storage.DiffResultKey(a.TenantID, a.RepoID, a.JobID)
	if err := s.Blobs.PutManifest(ctx, key, b, "application/json"); err != nil {
		return err
	}
	return set("done", &key)
}
