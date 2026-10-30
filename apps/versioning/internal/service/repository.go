package service

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
)

// RepoView is a repository plus its default-branch head.
type RepoView struct {
	Repo       db.VersioningDatasetRepository `json:"repo"`
	Head       string                         `json:"head"`
	Generation int64                          `json:"generation"`
}

// CreateRepoInput are the creation parameters.
type CreateRepoInput struct {
	Name              string `json:"name"`
	PolicyID          string `json:"policy_id"`
	RequiredApprovals *int   `json:"required_approvals"`
}

// CreateRepo creates a repository, writes an empty root commit and creates
// the protected default branch at it, in one flow (todo4 1.6).
func (s *Service) CreateRepo(ctx context.Context, p *authn.Principal, in CreateRepoInput, idemKey string) (*RepoView, error) {
	if err := require(p, authn.ScopeAdmin); err != nil {
		return nil, err
	}
	k, err := newIdem(zeroRepo, "@op/create-repo/"+p.ProjectID, idemKey, in)
	if err != nil {
		return nil, err
	}
	if in.PolicyID == "" {
		in.PolicyID = "default"
	}
	approvals := 1
	if in.RequiredApprovals != nil {
		approvals = *in.RequiredApprovals
	}
	// Replays must not write a second root commit, so check first.
	var replay *RepoView
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		raw, ok, err := lookupIdem(ctx, q, p.TenantID, k)
		if ok {
			replay = &RepoView{}
			return jsonUnmarshal(raw, replay)
		}
		return err
	}); err != nil || replay != nil {
		return replay, err
	}

	repoID := ids.New()
	empty := &manifests.Manifest{SchemaVersion: manifests.SchemaVersion, Ontology: manifests.Ontology{RevisionID: "empty"},
		Samples: []manifests.Sample{}, Annotations: []manifests.Annotation{}}
	written, err := s.Manifests.Write(ctx, p.TenantID, repoID, empty)
	if err != nil {
		return nil, err
	}
	snap := s.snapshot(repoID, in.PolicyID, written, p, "init", "", nil, "")
	now := s.Now()
	oid, err := s.Git.Open(ctx, p.TenantID, repoID).WriteCommit(snap, nil, p.Actor.ID, "Initialize dataset repository", now)
	if err != nil {
		return nil, err
	}
	branch := s.Cfg.DefaultBranch
	return idempotent(ctx, s, p, k, http.StatusCreated, func(q *db.Queries, tx pgx.Tx) (*RepoView, error) {
		if err := q.EnsureTenant(ctx, p.TenantID); err != nil {
			return nil, err
		}
		r, err := q.CreateRepo(ctx, db.CreateRepoParams{ID: repoID, TenantID: p.TenantID, ProjectID: p.ProjectID,
			Name: in.Name, DefaultBranch: branch, PolicyID: in.PolicyID, RequiredApprovals: int32(approvals), CreatedBy: p.Actor.ID})
		if err != nil {
			return nil, err
		}
		if err := s.registerRoot(ctx, q, p, repoID, written); err != nil {
			return nil, err
		}
		if err := q.InsertCommit(ctx, db.InsertCommitParams{TenantID: p.TenantID, RepoID: repoID, Oid: oid,
			ManifestRoot: written.RootHash, AuthorID: p.Actor.ID, OnBehalfOf: strOrNil(p.Actor.OnBehalfOf),
			ParentOids: []string{}, Message: "Initialize dataset repository"}); err != nil {
			return nil, err
		}
		b, err := q.CreateBranch(ctx, db.CreateBranchParams{TenantID: p.TenantID, RepoID: repoID, Name: branch,
			CommitOid: oid, Protected: true, CreatedBy: p.Actor.ID})
		if err != nil {
			return nil, err
		}
		if err := q.UpsertRefProjection(ctx, db.UpsertRefProjectionParams{TenantID: p.TenantID, RepoID: repoID,
			Name: "refs/heads/" + branch, Target: oid}); err != nil {
			return nil, err
		}
		if err := s.audit(ctx, q, p, repoID, "repo.created", repoID, oid, map[string]string{"name_hash": manifests.HashHex([]byte(in.Name))[:16]}); err != nil {
			return nil, err
		}
		if err := s.emit(ctx, q, p, repoID, EvCommitCreated, oid, map[string]string{"branch": branch, "commit_oid": oid}); err != nil {
			return nil, err
		}
		return &RepoView{Repo: r, Head: oid, Generation: b.Generation}, nil
	})
}

// GetRepo returns a repository.
func (s *Service) GetRepo(ctx context.Context, p *authn.Principal, repoID string) (*RepoView, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var out RepoView
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		r, err := s.repo(ctx, q, p, repoID)
		if err != nil {
			return err
		}
		b, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.DefaultBranch})
		if err != nil {
			return err
		}
		out = RepoView{Repo: r, Head: b.CommitOid, Generation: b.Generation}
		return nil
	})
	return &out, err
}

// snapshot builds the commit tree documents.
func (s *Service) snapshot(repoID, policyID string, w *manifests.Written, p *authn.Principal, op, tool string, inputs []string, reviewID string) gitengine.Snapshot {
	return gitengine.Snapshot{
		Dataset: gitengine.DatasetDoc{RepoID: repoID, SchemaVersion: manifests.SchemaVersion, ManifestRoot: w.RootHash,
			ManifestFormat: w.Format, SampleCount: w.Samples, AnnotationCount: w.Annots},
		Ontology:   gitengine.OntologyDoc{RevisionID: w.Manifest.Ontology.RevisionID, Hash: "sha256:" + manifests.EntryHash(w.Manifest.Ontology)},
		Policy:     gitengine.PolicyDoc{PolicyID: policyID},
		Provenance: gitengine.ProvenanceDoc{Operation: op, ActorID: p.Actor.ID, ActorKind: p.Actor.Kind, OnBehalfOf: p.Actor.OnBehalfOf, Tool: tool, Inputs: inputs, ReviewID: reviewID},
	}
}

func timePtr(t time.Time) *time.Time { return &t }
