package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
)

// MaxBranchesPerRepo is the per-repository branch quota (spec §6).
const MaxBranchesPerRepo = 1000

var branchRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._/-]{0,127}$`)

// ValidateBranchName applies the strict ref rules of todo4 1.6.
func ValidateBranchName(name string) error {
	switch {
	case strings.IndexFunc(name, unicode.IsControl) >= 0:
		return errors.New("control characters are not allowed")
	case !branchRE.MatchString(name):
		return errors.New("must match ^[a-z0-9][a-z0-9._/-]{0,127}$")
	case strings.Contains(name, ".."), strings.Contains(name, "//"), strings.Contains(name, "@{"):
		return errors.New(`must not contain "..", "//" or "@{"`)
	case strings.HasSuffix(name, "/"), strings.HasSuffix(name, ".lock"), strings.HasSuffix(name, "."):
		return errors.New(`must not end with "/", "." or ".lock"`)
	case strings.EqualFold(name, "head"):
		return errors.New("HEAD is reserved")
	case strings.Contains(name, "/."):
		return errors.New(`path components must not start with "."`)
	}
	return nil
}

// CreateBranch creates a branch at an existing commit (O(1), no copy).
func (s *Service) CreateBranch(ctx context.Context, p *authn.Principal, repoID, name, from string, protected bool, idemKey string) (*db.VersioningRepoBranch, error) {
	if err := require(p, authn.ScopeWrite); err != nil {
		return nil, err
	}
	if err := ValidateBranchName(name); err != nil {
		return nil, errf(http.StatusBadRequest, "bad_request", "invalid branch name: %v", err)
	}
	if protected {
		if err := require(p, authn.ScopeAdmin); err != nil {
			return nil, err
		}
	}
	k, err := newIdem(repoID, "@op/create-branch/"+name, idemKey, map[string]any{"name": name, "from": from, "protected": protected})
	if err != nil {
		return nil, err
	}
	return idempotent(ctx, s, p, k, http.StatusCreated, func(q *db.Queries, _ pgx.Tx) (*db.VersioningRepoBranch, error) {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return nil, err
		}
		oid, err := resolveRef(ctx, q, repoID, from)
		if err != nil {
			return nil, err
		}
		n, err := q.CountLiveBranches(ctx, repoID)
		if err != nil {
			return nil, err
		}
		if n >= MaxBranchesPerRepo {
			return nil, errf(http.StatusConflict, "conflict", "branch quota reached")
		}
		var b db.VersioningRepoBranch
		existing, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: name})
		switch {
		case err == nil && existing.DeletedAt == nil:
			return nil, errf(http.StatusConflict, "conflict", "branch already exists")
		case err == nil:
			b, err = q.ReviveBranch(ctx, db.ReviveBranchParams{RepoID: repoID, Name: name, CommitOid: oid, Protected: protected})
		case errors.Is(err, pgx.ErrNoRows):
			b, err = q.CreateBranch(ctx, db.CreateBranchParams{TenantID: p.TenantID, RepoID: repoID, Name: name,
				CommitOid: oid, Protected: protected, CreatedBy: p.Actor.ID})
		}
		if err != nil {
			return nil, err
		}
		if err := q.UpsertRefProjection(ctx, db.UpsertRefProjectionParams{TenantID: p.TenantID, RepoID: repoID,
			Name: "refs/heads/" + name, Target: oid}); err != nil {
			return nil, err
		}
		if err := s.audit(ctx, q, p, repoID, "branch.created", name, oid, map[string]any{"protected": protected}); err != nil {
			return nil, err
		}
		return &b, s.emit(ctx, q, p, repoID, EvBranchUpdated, name, map[string]string{"branch": name, "commit_oid": oid})
	})
}

// ListBranches pages live branches by name.
func (s *Service) ListBranches(ctx context.Context, p *authn.Principal, repoID, after string, limit int) ([]db.VersioningRepoBranch, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var out []db.VersioningRepoBranch
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		out, err = q.ListBranches(ctx, db.ListBranchesParams{RepoID: repoID, After: after, Limit: int32(limit)})
		return err
	})
	return out, err
}

// DeleteBranch tombstones a branch; it stays a GC root for BranchRetention.
func (s *Service) DeleteBranch(ctx context.Context, p *authn.Principal, repoID, name, expected string) (*db.VersioningRepoBranch, error) {
	if err := require(p, authn.ScopeWrite); err != nil {
		return nil, err
	}
	var out db.VersioningRepoBranch
	err := s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		b, err := q.GetLiveBranchForUpdate(ctx, db.GetLiveBranchForUpdateParams{RepoID: repoID, Name: name})
		if err != nil {
			return notFound(err, "branch")
		}
		if b.Protected {
			return errf(http.StatusForbidden, "protected_branch", "protected branches cannot be deleted")
		}
		if b.CommitOid != expected {
			return staleHead(b)
		}
		out, err = q.TombstoneBranch(ctx, db.TombstoneBranchParams{RetainUntil: timePtr(s.Now().Add(s.Cfg.BranchRetention)),
			RepoID: repoID, Name: name, ExpectedOid: expected})
		if err != nil {
			return fmt.Errorf("tombstone: %w", err)
		}
		if err := q.DeleteRefProjection(ctx, db.DeleteRefProjectionParams{RepoID: repoID, Name: "refs/heads/" + name}); err != nil {
			return err
		}
		if err := s.audit(ctx, q, p, repoID, "branch.deleted", name, b.CommitOid, nil); err != nil {
			return err
		}
		return s.emit(ctx, q, p, repoID, EvBranchUpdated, name, map[string]string{"branch": name, "deleted": "true", "commit_oid": b.CommitOid})
	})
	return &out, err
}
