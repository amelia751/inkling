package service

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/authz"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
)

var oidRE = regexp.MustCompile(`^[0-9a-f]{40}$`)

// CommitInput is a linear commit request (spec §10 example).
type CommitInput struct {
	Branch         string   `json:"branch"`
	ExpectedHead   string   `json:"expected_head"`
	ManifestRoot   string   `json:"manifest_root"`
	Message        string   `json:"message"`
	IdempotencyKey string   `json:"-"`
	Tool           string   `json:"tool,omitempty"`
	Inputs         []string `json:"inputs,omitempty"`
	// Studio replaces the `.studio/` tree; nil keeps the parent's (studio.go).
	Studio *StudioInput `json:"studio,omitempty"`
	// studioTree sets the tree to an existing one (revert: the target's).
	studioTree *string
}

// CommitResult is returned by every head-advancing write.
type CommitResult struct {
	CommitOID      string `json:"commit_oid"`
	Branch         string `json:"branch"`
	HeadGeneration int64  `json:"head_generation"`
	ManifestRoot   string `json:"manifest_root"`
	StudioTree     string `json:"studio_tree,omitempty"`
	RequestID      string `json:"request_id"`
}

// Commit implements the commit protocol of spec §5. The order is load-bearing:
//  1. authn (middleware) then authz (tenant/repo/branch scope);
//  2. idempotency lookup;
//  3. referenced artifacts belong to this tenant and are not purged;
//  4. Git objects are written outside any DB transaction;
//  5. one transaction: CAS on the branch head plus commit row, audit, outbox,
//     idempotency record and the reconcile job;
//  6. a stale expected head returns 409 with the current head;
//  7. the reconcile job promotes staged artifacts asynchronously.
func (s *Service) Commit(ctx context.Context, p *authn.Principal, repoID string, in CommitInput) (*CommitResult, error) {
	if err := require(p, authn.ScopeWrite); err != nil {
		return nil, err
	}
	if !oidRE.MatchString(in.ExpectedHead) {
		return nil, errf(http.StatusBadRequest, "bad_request", "expected_head must be a commit oid")
	}
	if !authz.AgentBranchAllowed(p, in.Branch) {
		return nil, errf(http.StatusForbidden, "forbidden", "agents may only commit to work/agent-* branches")
	}
	studioFiles, err := validateStudio(in.Studio)
	if err != nil {
		return nil, err
	}
	k, err := newIdem(repoID, in.Branch, in.IdempotencyKey, in)
	if err != nil {
		return nil, err
	}
	var (
		repo   db.VersioningDatasetRepository
		replay *CommitResult
		root   db.VersioningManifestRoot
	)
	err = s.read(ctx, p.TenantID, func(q *db.Queries) error {
		var err error
		if repo, err = s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		b, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: in.Branch})
		if err != nil || b.DeletedAt != nil {
			return errf(http.StatusNotFound, "not_found", "branch not found")
		}
		if b.Protected {
			return errf(http.StatusForbidden, "protected_branch", "%s is protected; changes reach it only through a merged review", in.Branch)
		}
		raw, ok, err := lookupIdem(ctx, q, p.TenantID, k)
		if err != nil {
			return err
		}
		if ok {
			replay = &CommitResult{}
			return jsonUnmarshal(raw, replay)
		}
		if root, err = rootRow(ctx, q, repoID, in.ManifestRoot); err != nil {
			return err
		}
		if _, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: in.ExpectedHead}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return staleHead(b)
			}
			return err
		}
		return s.recheckRootArtifacts(ctx, q, p.TenantID, repoID, in.ManifestRoot)
	})
	if err != nil || replay != nil {
		return replay, err
	}
	m, err := s.Manifests.LoadRoot(ctx, p.TenantID, repoID, in.ManifestRoot)
	if err != nil {
		return nil, err
	}
	w := &manifests.Written{RootHash: root.RootHash, Format: root.Format, Samples: int(root.SampleCount),
		Annots: int(root.AnnotationCount), Manifest: &manifests.Manifest{Ontology: m.Ontology}}
	snap := s.snapshot(repoID, repo.PolicyID, w, p, "commit", in.Tool, in.Inputs, "")
	switch {
	case in.Studio != nil:
		snap.Studio.Files = studioFiles
	case in.studioTree != nil:
		snap.Studio.OID = *in.studioTree
	default:
		if snap.Studio.OID, err = s.studioOf(ctx, p.TenantID, repoID, in.ExpectedHead); err != nil {
			return nil, err
		}
	}
	g := s.Git.Open(ctx, p.TenantID, repoID)
	oid, err := g.WriteCommit(snap, []string{in.ExpectedHead}, p.Actor.ID, in.Message, s.Now())
	if err != nil {
		return nil, err
	}
	studioTree, err := s.studioOf(ctx, p.TenantID, repoID, oid)
	if err != nil {
		return nil, err
	}
	if err := s.failpoint("commit.after-git-write"); err != nil {
		return nil, err
	}
	res, err := s.advance(ctx, p, advanceArgs{repoID: repoID, branch: in.Branch, expected: in.ExpectedHead, newOID: oid,
		root: in.ManifestRoot, studio: studioTree, parents: []string{in.ExpectedHead}, message: in.Message, event: "commit.created", idem: &k})
	if err != nil {
		var se *Error
		if errors.As(err, &se) && se.Code == "stale_head" {
			// A concurrent identical retry may have won: replay its response.
			if r, ok := s.replay(ctx, p, k); ok {
				return r, nil
			}
		}
		return nil, err
	}
	return res, nil
}

func (s *Service) replay(ctx context.Context, p *authn.Principal, k idem) (*CommitResult, bool) {
	var out *CommitResult
	_ = s.read(ctx, p.TenantID, func(q *db.Queries) error {
		raw, ok, err := lookupIdem(ctx, q, p.TenantID, k)
		if ok && err == nil {
			out = &CommitResult{}
			return jsonUnmarshal(raw, out)
		}
		return err
	})
	return out, out != nil
}

func staleHead(b db.VersioningRepoBranch) *Error {
	return &Error{Status: http.StatusConflict, Code: "stale_head", Detail: "branch head moved; refresh and re-apply",
		CurrentHead: b.CommitOid, Generation: b.Generation}
}

// recheckRootArtifacts re-validates, at commit time, that the artifacts a
// registered root references are still usable (not purged since).
func (s *Service) recheckRootArtifacts(ctx context.Context, q *db.Queries, tenant, repoID, root string) error {
	m, err := s.Manifests.LoadRoot(ctx, tenant, repoID, root)
	if err != nil || m.Full == nil {
		return err // chunked roots were fully checked at registration
	}
	_, err = s.checkArtifacts(ctx, q, tenant, m.Full)
	return err
}

type advanceArgs struct {
	repoID, branch, expected, newOID, root, studio, message, event string
	parents                                                        []string
	idem                                                           *idem
	allowProtected                                                 bool
	extra                                                          func(q *db.Queries, tx pgx.Tx, gen int64) error
}

// advance performs step 5: the conditional head move and everything that
// must commit atomically with it.
func (s *Service) advance(ctx context.Context, p *authn.Principal, a advanceArgs) (*CommitResult, error) {
	var res *CommitResult
	err := s.tx(ctx, p.TenantID, func(q *db.Queries, tx pgx.Tx) error {
		b, err := q.GetLiveBranchForUpdate(ctx, db.GetLiveBranchForUpdateParams{RepoID: a.repoID, Name: a.branch})
		if err != nil {
			return notFound(err, "branch")
		}
		if b.Protected && !a.allowProtected {
			return errf(http.StatusForbidden, "protected_branch", "%s is protected", a.branch)
		}
		gen, err := q.CASBranchHead(ctx, db.CASBranchHeadParams{NewOid: a.newOID, RepoID: a.repoID, Name: a.branch,
			ExpectedOid: a.expected, TenantID: p.TenantID})
		if errors.Is(err, pgx.ErrNoRows) {
			return staleHead(b)
		}
		if err != nil {
			return err
		}
		if err := q.InsertCommit(ctx, db.InsertCommitParams{TenantID: p.TenantID, RepoID: a.repoID, Oid: a.newOID,
			ManifestRoot: a.root, AuthorID: p.Actor.ID, OnBehalfOf: strOrNil(p.Actor.OnBehalfOf),
			ParentOids: a.parents, Message: gitengine.SanitizeMessage(a.message)}); err != nil {
			return err
		}
		if err := q.UpsertRefProjection(ctx, db.UpsertRefProjectionParams{TenantID: p.TenantID, RepoID: a.repoID,
			Name: "refs/heads/" + a.branch, Target: a.newOID}); err != nil {
			return err
		}
		if err := s.audit(ctx, q, p, a.repoID, a.event, a.newOID, a.newOID,
			map[string]any{"branch": a.branch, "parents": a.parents, "manifest_root": a.root}); err != nil {
			return err
		}
		data := map[string]string{"branch": a.branch, "commit_oid": a.newOID, "previous_oid": a.expected}
		if err := s.emit(ctx, q, p, a.repoID, EvCommitCreated, a.newOID, data); err != nil {
			return err
		}
		if err := s.emit(ctx, q, p, a.repoID, EvBranchUpdated, a.branch, data); err != nil {
			return err
		}
		if err := s.invalidateReviews(ctx, q, tx, p, a.repoID, a.branch, a.newOID); err != nil {
			return err
		}
		if a.extra != nil {
			if err := a.extra(q, tx, gen); err != nil {
				return err
			}
		}
		res = &CommitResult{CommitOID: a.newOID, Branch: a.branch, HeadGeneration: gen, ManifestRoot: a.root, StudioTree: a.studio, RequestID: p.RequestID}
		if a.idem != nil {
			if err := s.storeIdem(ctx, q, p.TenantID, *a.idem, http.StatusCreated, res); err != nil {
				return err
			}
		}
		return s.enqueue(ctx, tx, ReconcileRootArgs{TenantID: p.TenantID, RepoID: a.repoID, RootHash: a.root})
	})
	if err != nil && storage.IsUniqueViolation(err) && a.idem != nil {
		if r, ok := s.replay(ctx, p, *a.idem); ok {
			return r, nil
		}
	}
	return res, err
}

// Revert creates a new commit whose manifest and Studio definition equal the
// target's (spec §6; todo10: restoring a version restores its Studio setup).
func (s *Service) Revert(ctx context.Context, p *authn.Principal, repoID, branch, expected, target, message, idemKey string) (*CommitResult, error) {
	var root string
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		c, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: target})
		if err != nil {
			return notFound(err, "target commit")
		}
		root = c.ManifestRoot
		return nil
	}); err != nil {
		return nil, err
	}
	if message == "" {
		message = "Revert to " + target[:12]
	}
	studio, err := s.studioOf(ctx, p.TenantID, repoID, target)
	if err != nil {
		return nil, err
	}
	return s.Commit(ctx, p, repoID, CommitInput{Branch: branch, ExpectedHead: expected, ManifestRoot: root,
		Message: message, IdempotencyKey: idemKey, Tool: "revert", Inputs: []string{target}, studioTree: &studio})
}

// CommitView is a commit with its snapshot.
type CommitView struct {
	Row    db.VersioningRepoCommit
	Commit *gitengine.Commit
}

// GetCommit returns one commit.
func (s *Service) GetCommit(ctx context.Context, p *authn.Principal, repoID, oid string) (*CommitView, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var row db.VersioningRepoCommit
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		row, err = q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: oid})
		return notFound(err, "commit")
	}); err != nil {
		return nil, err
	}
	c, err := s.Git.Open(ctx, p.TenantID, repoID).ReadCommit(oid)
	if err != nil {
		return nil, err
	}
	return &CommitView{Row: row, Commit: c}, nil
}

// ListCommits walks history from a branch or commit, newest first.
func (s *Service) ListCommits(ctx context.Context, p *authn.Principal, repoID, ref string, offset, limit int) ([]*CommitView, bool, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, false, err
	}
	var head string
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		head, err = resolveRef(ctx, q, repoID, ref)
		return err
	}); err != nil {
		return nil, false, err
	}
	if offset+limit > s.Cfg.MaxWalkDepth {
		return nil, false, errf(http.StatusRequestEntityTooLarge, "too_large", "history page beyond the walk depth limit")
	}
	g := s.Git.Open(ctx, p.TenantID, repoID)
	oids, err := g.Log(head, offset, limit+1, s.Cfg.MaxWalkDepth)
	if err != nil && !errors.Is(err, gitengine.ErrWalkTooDeep) {
		return nil, false, err
	}
	more := len(oids) > limit
	if more {
		oids = oids[:limit]
	}
	out := make([]*CommitView, 0, len(oids))
	err = s.read(ctx, p.TenantID, func(q *db.Queries) error {
		for _, oid := range oids {
			row, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: oid})
			if err != nil {
				return err
			}
			c, err := g.ReadCommit(oid)
			if err != nil {
				return err
			}
			out = append(out, &CommitView{Row: row, Commit: c})
		}
		return nil
	})
	return out, more, err
}

// resolveRef maps a branch name or commit oid to a commit oid.
func resolveRef(ctx context.Context, q *db.Queries, repoID, ref string) (string, error) {
	if oidRE.MatchString(ref) {
		if _, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: ref}); err == nil {
			return ref, nil
		}
	}
	b, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: ref})
	if err != nil || b.DeletedAt != nil {
		return "", errf(http.StatusNotFound, "not_found", "ref not found")
	}
	return b.CommitOid, nil
}
