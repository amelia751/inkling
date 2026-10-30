package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
)

var tagRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// CreateRelease publishes an immutable tag pinning a commit and its manifest
// root. Attestations record the checks that passed on the merged reviews.
func (s *Service) CreateRelease(ctx context.Context, p *authn.Principal, repoID, tag, commit, policy string, retainUntil *time.Time, idemKey string) (*db.VersioningDatasetRelease, error) {
	if err := require(p, authn.ScopeRelease); err != nil {
		return nil, err
	}
	if !tagRE.MatchString(tag) {
		return nil, errf(http.StatusBadRequest, "bad_request", "invalid tag")
	}
	if policy == "" {
		policy = "standard"
	}
	k, err := newIdem(repoID, "@op/release/"+tag, idemKey, map[string]any{"tag": tag, "commit": commit, "policy": policy, "retain": retainUntil})
	if err != nil {
		return nil, err
	}
	return idempotent(ctx, s, p, k, http.StatusCreated, func(q *db.Queries, _ pgx.Tx) (*db.VersioningDatasetRelease, error) {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return nil, err
		}
		c, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: commit})
		if err != nil {
			return nil, notFound(err, "commit")
		}
		if _, err := q.GetRelease(ctx, db.GetReleaseParams{RepoID: repoID, Tag: tag}); err == nil {
			return nil, errf(http.StatusConflict, "conflict", "release tags are immutable")
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		att, err := s.attestations(ctx, q, repoID, commit)
		if err != nil {
			return nil, err
		}
		r, err := q.InsertRelease(ctx, db.InsertReleaseParams{TenantID: p.TenantID, RepoID: repoID, Tag: tag, CommitOid: commit,
			ManifestRoot: c.ManifestRoot, CreatedBy: p.Actor.ID, RetentionPolicy: policy, RetainUntil: retainUntil, Attestations: att})
		if err != nil {
			return nil, err
		}
		if err := q.UpsertRefProjection(ctx, db.UpsertRefProjectionParams{TenantID: p.TenantID, RepoID: repoID,
			Name: "refs/tags/" + tag, Target: commit}); err != nil {
			return nil, err
		}
		if err := s.audit(ctx, q, p, repoID, "release.published", tag, commit, map[string]string{"manifest_root": c.ManifestRoot}); err != nil {
			return nil, err
		}
		return &r, s.emit(ctx, q, p, repoID, EvReleasePublished, tag,
			map[string]string{"tag": tag, "commit_oid": commit, "manifest_root": c.ManifestRoot})
	})
}

func (s *Service) attestations(ctx context.Context, q *db.Queries, repoID, commit string) (json.RawMessage, error) {
	reviews, err := q.ReviewsMergedAt(ctx, db.ReviewsMergedAtParams{RepoID: repoID, MergeOid: &commit})
	if err != nil {
		return nil, err
	}
	type att struct {
		ReviewID  string            `json:"review_id"`
		SourceOID string            `json:"source_oid"`
		Checks    map[string]string `json:"checks"`
		Approvers []string          `json:"approvers"`
	}
	out := []att{}
	for _, id := range reviews {
		r, err := q.GetReview(ctx, db.GetReviewParams{RepoID: repoID, ID: id})
		if err != nil {
			return nil, err
		}
		a := att{ReviewID: id, SourceOID: r.SourceOid, Checks: map[string]string{}, Approvers: []string{}}
		checks, err := q.ListChecks(ctx, db.ListChecksParams{ReviewID: id, SourceOid: r.SourceOid, TargetOid: deref(r.CheckedTargetOid)})
		if err != nil {
			return nil, err
		}
		for _, c := range checks {
			a.Checks[c.Name] = c.Outcome
		}
		apps, err := q.ListApprovals(ctx, id)
		if err != nil {
			return nil, err
		}
		for _, ap := range apps {
			if ap.ApprovedSourceOid == r.SourceOid {
				a.Approvers = append(a.Approvers, ap.ReviewerID)
			}
		}
		out = append(out, a)
	}
	return json.Marshal(out)
}

// GetRelease returns one release.
func (s *Service) GetRelease(ctx context.Context, p *authn.Principal, repoID, tag string) (*db.VersioningDatasetRelease, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var out db.VersioningDatasetRelease
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		out, err = q.GetRelease(ctx, db.GetReleaseParams{RepoID: repoID, Tag: tag})
		return notFound(err, "release")
	})
	return &out, err
}

// ListReleases lists releases.
func (s *Service) ListReleases(ctx context.Context, p *authn.Principal, repoID string) ([]db.VersioningDatasetRelease, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var out []db.VersioningDatasetRelease
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		out, err = q.ListReleases(ctx, repoID)
		return err
	})
	return out, err
}

// DeleteRelease removes a release once its retention has lapsed and no
// legal hold applies.
func (s *Service) DeleteRelease(ctx context.Context, p *authn.Principal, repoID, tag string) error {
	if err := require(p, authn.ScopeAdmin); err != nil {
		return err
	}
	return s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		r, err := q.GetRelease(ctx, db.GetReleaseParams{RepoID: repoID, Tag: tag})
		if err != nil {
			return notFound(err, "release")
		}
		if r.RetainUntil == nil || r.RetainUntil.After(s.Now()) || r.RetentionPolicy != "standard" {
			return errf(http.StatusConflict, "retention", "release is within its retention period")
		}
		held, err := q.HeldRepos(ctx)
		if err != nil {
			return err
		}
		for _, h := range held {
			if h != nil && *h == repoID {
				return errf(http.StatusConflict, "legal_hold", "repository is under legal hold")
			}
		}
		if err := q.DeleteRelease(ctx, db.DeleteReleaseParams{RepoID: repoID, Tag: tag}); err != nil {
			return err
		}
		if err := q.DeleteRefProjection(ctx, db.DeleteRefProjectionParams{RepoID: repoID, Name: "refs/tags/" + tag}); err != nil {
			return err
		}
		return s.audit(ctx, q, p, repoID, "release.deleted", tag, r.CommitOid, nil)
	})
}
