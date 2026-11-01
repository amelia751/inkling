package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"studio.local/versioning/internal/api"
	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/merge"
	"studio.local/versioning/internal/service"
)

// Handlers implements api.StrictServerInterface on top of the service.
type Handlers struct {
	Svc           *service.Service
	Ready         func(ctx context.Context) map[string]string
	GitSHA        string
	SchemaVersion func(ctx context.Context) int64
}

var _ api.StrictServerInterface = (*Handlers)(nil)

func principal(ctx context.Context) *authn.Principal { return authn.FromContext(ctx) }

func uid(s string) uuid.UUID { return uuid.MustParse(s) }

func limitOr(l *api.Limit, def int) int {
	if l == nil || *l <= 0 {
		return def
	}
	return min(*l, 1000)
}

func offsetCursor(c *api.Cursor) (int, error) {
	if c == nil || *c == "" {
		return 0, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(*c)
	if err != nil {
		return 0, &service.Error{Status: http.StatusBadRequest, Code: "bad_request", Detail: "invalid cursor"}
	}
	n, err := strconv.Atoi(string(b))
	if err != nil || n < 0 {
		return 0, &service.Error{Status: http.StatusBadRequest, Code: "bad_request", Detail: "invalid cursor"}
	}
	return n, nil
}

func encodeOffset(n int) *string {
	s := base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(n)))
	return &s
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

func jsonMap(b []byte) *map[string]any {
	if len(b) == 0 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return &m
}

// ---- ops ----

// Healthz reports process liveness only.
func (h *Handlers) Healthz(context.Context, api.HealthzRequestObject) (api.HealthzResponseObject, error) {
	return api.Healthz200JSONResponse{Status: "ok"}, nil
}

// Readyz checks Postgres and object storage with bounded timeouts.
func (h *Handlers) Readyz(ctx context.Context, _ api.ReadyzRequestObject) (api.ReadyzResponseObject, error) {
	checks := h.Ready(ctx)
	for _, v := range checks {
		if v != "ok" {
			return api.Readyz503JSONResponse{Status: "degraded", Checks: &checks}, nil
		}
	}
	return api.Readyz200JSONResponse{Status: "ok", Checks: &checks}, nil
}

// Version reports build and library versions.
func (h *Handlers) Version(ctx context.Context, _ api.VersionRequestObject) (api.VersionResponseObject, error) {
	return api.Version200JSONResponse{GitSha: h.GitSHA, GitLibrary: gitengine.Version, SchemaVersion: h.SchemaVersion(ctx)}, nil
}

// ---- repos and branches ----

func repoOut(v *service.RepoView) api.Repository {
	r := v.Repo
	return api.Repository{Id: uid(r.ID), TenantId: uid(r.TenantID), ProjectId: uid(r.ProjectID), Name: r.Name,
		DefaultBranch: r.DefaultBranch, PolicyId: r.PolicyID, ObjectFormat: api.RepositoryObjectFormat(r.ObjectFormat),
		Head: v.Head, HeadGeneration: v.Generation, CreatedAt: r.CreatedAt}
}

// CreateRepo creates a repository with a protected default branch.
func (h *Handlers) CreateRepo(ctx context.Context, req api.CreateRepoRequestObject) (api.CreateRepoResponseObject, error) {
	in := service.CreateRepoInput{Name: req.Body.Name, PolicyID: deref(req.Body.PolicyId), RequiredApprovals: req.Body.RequiredApprovals}
	v, err := h.Svc.CreateRepo(ctx, principal(ctx), in, req.Params.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return api.CreateRepo201JSONResponse(repoOut(v)), nil
}

// GetRepo returns a repository.
func (h *Handlers) GetRepo(ctx context.Context, req api.GetRepoRequestObject) (api.GetRepoResponseObject, error) {
	v, err := h.Svc.GetRepo(ctx, principal(ctx), req.RepoId.String())
	if err != nil {
		return nil, err
	}
	return api.GetRepo200JSONResponse(repoOut(v)), nil
}

func branchOut(b db.VersioningRepoBranch) api.Branch {
	return api.Branch{Name: b.Name, CommitOid: b.CommitOid, Generation: b.Generation, Protected: b.Protected,
		UpdatedAt: b.UpdatedAt, DeletedAt: b.DeletedAt}
}

// CreateBranch creates a branch at a commit.
func (h *Handlers) CreateBranch(ctx context.Context, req api.CreateBranchRequestObject) (api.CreateBranchResponseObject, error) {
	b, err := h.Svc.CreateBranch(ctx, principal(ctx), req.RepoId.String(), req.Body.Name, req.Body.From,
		deref(req.Body.Protected), req.Params.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return api.CreateBranch201JSONResponse(branchOut(*b)), nil
}

// ListBranches pages branches by name; the cursor is the last name seen.
func (h *Handlers) ListBranches(ctx context.Context, req api.ListBranchesRequestObject) (api.ListBranchesResponseObject, error) {
	limit := limitOr(req.Params.Limit, 100)
	after := ""
	if req.Params.Cursor != nil {
		b, err := base64.RawURLEncoding.DecodeString(*req.Params.Cursor)
		if err != nil {
			return nil, &service.Error{Status: http.StatusBadRequest, Code: "bad_request", Detail: "invalid cursor"}
		}
		after = string(b)
	}
	rows, err := h.Svc.ListBranches(ctx, principal(ctx), req.RepoId.String(), after, limit+1)
	if err != nil {
		return nil, err
	}
	out := api.ListBranches200JSONResponse{Items: []api.Branch{}}
	for i, b := range rows {
		if i == limit {
			c := base64.RawURLEncoding.EncodeToString([]byte(rows[limit-1].Name))
			out.NextCursor = &c
			break
		}
		out.Items = append(out.Items, branchOut(b))
	}
	return out, nil
}

// DeleteBranch tombstones a branch.
func (h *Handlers) DeleteBranch(ctx context.Context, req api.DeleteBranchRequestObject) (api.DeleteBranchResponseObject, error) {
	b, err := h.Svc.DeleteBranch(ctx, principal(ctx), req.RepoId.String(), req.Params.Name, req.Params.ExpectedHead)
	if err != nil {
		return nil, err
	}
	return api.DeleteBranch200JSONResponse(branchOut(*b)), nil
}

// ---- artifacts and manifests ----

func artifactOut(a *db.VersioningArtifact) api.Artifact {
	hold := a.LegalHold
	return api.Artifact{Sha256: a.ContentSha256, SizeBytes: a.SizeBytes, MediaType: a.MediaType,
		Status: api.ArtifactStatus(a.Status), LegalHold: &hold}
}

// PutArtifact streams raw bytes into staging.
func (h *Handlers) PutArtifact(ctx context.Context, req api.PutArtifactRequestObject) (api.PutArtifactResponseObject, error) {
	a, created, err := h.Svc.PutArtifact(ctx, principal(ctx), req.Sha256, req.Params.XMediaType, contentLength(ctx), req.Body)
	if err != nil {
		return nil, err
	}
	if created {
		return api.PutArtifact201JSONResponse(artifactOut(a)), nil
	}
	return api.PutArtifact200JSONResponse(artifactOut(a)), nil
}

// GetArtifact returns artifact metadata.
func (h *Handlers) GetArtifact(ctx context.Context, req api.GetArtifactRequestObject) (api.GetArtifactResponseObject, error) {
	a, err := h.Svc.GetArtifact(ctx, principal(ctx), req.Sha256)
	if err != nil {
		return nil, err
	}
	return api.GetArtifact200JSONResponse(artifactOut(a)), nil
}

// PurgeArtifact deletes withdrawn bytes (gated).
func (h *Handlers) PurgeArtifact(ctx context.Context, req api.PurgeArtifactRequestObject) (api.PurgeArtifactResponseObject, error) {
	a, err := h.Svc.Purge(ctx, principal(ctx), req.Sha256, req.Body.ReasonCode, req.Params.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return api.PurgeArtifact200JSONResponse(artifactOut(a)), nil
}

// PutAnnotationRevision stores a revision document.
func (h *Handlers) PutAnnotationRevision(ctx context.Context, req api.PutAnnotationRevisionRequestObject) (api.PutAnnotationRevisionResponseObject, error) {
	r := manifests.AnnotationRevision(*req.Body)
	ref, err := h.Svc.PutAnnotationRevision(ctx, principal(ctx), &r)
	if err != nil {
		return nil, err
	}
	return api.PutAnnotationRevision201JSONResponse{Ref: ref}, nil
}

// CreateLegalHold places a hold.
func (h *Handlers) CreateLegalHold(ctx context.Context, req api.CreateLegalHoldRequestObject) (api.CreateLegalHoldResponseObject, error) {
	hd, err := h.Svc.CreateLegalHold(ctx, principal(ctx), req.RepoId.String(), deref(req.Body.ArtifactSha256), req.Body.ReasonCode)
	if err != nil {
		return nil, err
	}
	return api.CreateLegalHold201JSONResponse{Id: uid(hd.ID), ReasonCode: hd.ReasonCode, CreatedAt: hd.CreatedAt,
		ArtifactSha256: req.Body.ArtifactSha256}, nil
}

// PutManifest stores a manifest and returns its root.
func (h *Handlers) PutManifest(ctx context.Context, req api.PutManifestRequestObject) (api.PutManifestResponseObject, error) {
	m := manifests.Manifest(*req.Body)
	w, err := h.Svc.PutManifest(ctx, principal(ctx), req.RepoId.String(), &m)
	if err != nil {
		return nil, err
	}
	return api.PutManifest201JSONResponse{ManifestRoot: w.RootHash, Format: api.ManifestRootFormat(w.Format),
		SampleCount: w.Samples, AnnotationCount: w.Annots}, nil
}

// ---- commits ----

func commitResult(r *service.CommitResult) api.CommitResult {
	return api.CommitResult{CommitOid: r.CommitOID, Branch: r.Branch, HeadGeneration: r.HeadGeneration,
		ManifestRoot: r.ManifestRoot, StudioTree: strp(r.StudioTree), RequestId: r.RequestID}
}

// CreateCommit runs the commit protocol.
func (h *Handlers) CreateCommit(ctx context.Context, req api.CreateCommitRequestObject) (api.CreateCommitResponseObject, error) {
	b := req.Body
	in := service.CommitInput{Branch: b.Branch, ExpectedHead: b.ExpectedHead,
		ManifestRoot: b.ManifestRoot, Message: b.Message, IdempotencyKey: b.IdempotencyKey, Tool: deref(b.Tool), Inputs: deref(b.Inputs)}
	if b.Studio != nil {
		files := b.Studio.Files
		if files == nil {
			files = map[string]string{}
		}
		in.Studio = &service.StudioInput{Files: files}
	}
	r, err := h.Svc.Commit(ctx, principal(ctx), req.RepoId.String(), in)
	if err != nil {
		return nil, err
	}
	return api.CreateCommit201JSONResponse(commitResult(r)), nil
}

// Revert restores a previous manifest as a new commit.
func (h *Handlers) Revert(ctx context.Context, req api.RevertRequestObject) (api.RevertResponseObject, error) {
	b := req.Body
	r, err := h.Svc.Revert(ctx, principal(ctx), req.RepoId.String(), b.Branch, b.ExpectedHead, b.TargetOid, deref(b.Message), b.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return api.Revert201JSONResponse(commitResult(r)), nil
}

func commitOut(v *service.CommitView) api.Commit {
	c := v.Commit
	ds := c.Snapshot.Dataset
	return api.Commit{Oid: c.OID, Parents: append([]string{}, c.Parents...), ManifestRoot: v.Row.ManifestRoot,
		ManifestFormat: strp(ds.ManifestFormat), SampleCount: &ds.SampleCount, AnnotationCount: &ds.AnnotationCount,
		AuthorId: v.Row.AuthorID, OnBehalfOf: v.Row.OnBehalfOf, Message: v.Row.Message,
		Operation: api.CommitOperation(c.Snapshot.Provenance.Operation), CreatedAt: v.Row.CreatedAt,
		StudioTree: strp(c.Snapshot.Studio.OID)}
}

// GetStudio returns the `.studio/` files at a ref (todo10 §3.2).
func (h *Handlers) GetStudio(ctx context.Context, req api.GetStudioRequestObject) (api.GetStudioResponseObject, error) {
	v, err := h.Svc.GetStudio(ctx, principal(ctx), req.RepoId.String(), req.Params.Ref)
	if err != nil {
		return nil, err
	}
	return api.GetStudio200JSONResponse(api.Studio{CommitOid: v.CommitOID, StudioTree: strp(v.StudioTree), Files: v.Files}), nil
}

// GetCommit returns one commit.
func (h *Handlers) GetCommit(ctx context.Context, req api.GetCommitRequestObject) (api.GetCommitResponseObject, error) {
	v, err := h.Svc.GetCommit(ctx, principal(ctx), req.RepoId.String(), req.CommitOid)
	if err != nil {
		return nil, err
	}
	return api.GetCommit200JSONResponse(commitOut(v)), nil
}

// ListCommits pages history.
func (h *Handlers) ListCommits(ctx context.Context, req api.ListCommitsRequestObject) (api.ListCommitsResponseObject, error) {
	off, err := offsetCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit := limitOr(req.Params.Limit, 50)
	vs, more, err := h.Svc.ListCommits(ctx, principal(ctx), req.RepoId.String(), req.Params.Ref, off, limit)
	if err != nil {
		return nil, err
	}
	out := api.ListCommits200JSONResponse{Items: []api.Commit{}}
	for _, v := range vs {
		out.Items = append(out.Items, commitOut(v))
	}
	if more {
		out.NextCursor = encodeOffset(off + limit)
	}
	return out, nil
}

// ---- diff ----

func diffOut(base, head string, p *service.DiffPage) api.DiffPage {
	r := p.Result
	cb := r.ChangedBuckets
	return api.DiffPage{Base: base, Head: head, BaseRoot: r.BaseRoot, HeadRoot: r.HeadRoot, ChangedBuckets: &cb,
		Summary: r.Summary, Aggregates: r.Aggregates, Changes: p.Page, NextCursor: strp(p.Next)}
}

// GetDiff returns a diff page or a job.
func (h *Handlers) GetDiff(ctx context.Context, req api.GetDiffRequestObject) (api.GetDiffResponseObject, error) {
	pr := req.Params
	p, err := h.Svc.Diff(ctx, principal(ctx), req.RepoId.String(), pr.Base, pr.Head, deref(pr.Cursor), limitOr(pr.Limit, 100))
	if err != nil {
		return nil, err
	}
	if p.Result == nil {
		return api.GetDiff202JSONResponse{JobId: uid(p.JobID), Status: api.DiffJobStatus(p.Status)}, nil
	}
	return api.GetDiff200JSONResponse(diffOut(pr.Base, pr.Head, p)), nil
}

// GetDiffJob returns a background diff.
func (h *Handlers) GetDiffJob(ctx context.Context, req api.GetDiffJobRequestObject) (api.GetDiffJobResponseObject, error) {
	p, err := h.Svc.GetDiffJob(ctx, principal(ctx), req.RepoId.String(), req.JobId.String(), deref(req.Params.Cursor), limitOr(req.Params.Limit, 100))
	if err != nil {
		return nil, err
	}
	if p.Result == nil {
		return api.GetDiffJob202JSONResponse{JobId: req.JobId, Status: api.DiffJobStatus(p.Status)}, nil
	}
	return api.GetDiffJob200JSONResponse(diffOut("", "", p)), nil
}

// ---- reviews ----

func reviewOut(v *service.ReviewView) api.Review {
	r := v.Row
	out := api.Review{Id: uid(r.ID), RepoId: uid(r.RepoID), Title: r.Title, Description: strp(r.Description), AuthorId: r.AuthorID,
		AuthorOnBehalfOf: r.AuthorOnBehalfOf, SourceBranch: r.SourceBranch, SourceOid: r.SourceOid, TargetBranch: r.TargetBranch,
		CheckedTargetOid: r.CheckedTargetOid, BaseOid: r.BaseOid, Status: api.ReviewStatus(r.Status),
		RequiredApprovals: int(r.RequiredApprovals), MergeOid: r.MergeOid, Version: r.Version, CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt, Approvals: []api.ReviewApproval{}, Checks: []api.ReviewCheck{}, Conflicts: []api.MergeConflict{}}
	for _, a := range v.Approvals {
		out.Approvals = append(out.Approvals, api.ReviewApproval{ReviewerId: a.ReviewerID, ApprovedSourceOid: a.ApprovedSourceOid, CreatedAt: a.CreatedAt})
	}
	for _, c := range v.Checks {
		out.Checks = append(out.Checks, api.ReviewCheck{Name: c.Name, Mandatory: c.Mandatory, Outcome: api.ReviewCheckOutcome(c.Outcome),
			SourceOid: c.SourceOid, TargetOid: c.TargetOid, Details: jsonMap(c.Details)})
	}
	for _, c := range v.Conflicts {
		out.Conflicts = append(out.Conflicts, api.MergeConflict{ConflictKey: c.ConflictKey, Kind: c.Kind, SampleId: c.SampleID,
			AnnotationId: c.AnnotationID, Field: c.Field, BaseRef: c.BaseRef, OursRef: c.OursRef, TheirsRef: c.TheirsRef,
			Resolution: jsonMap(c.Resolution)})
	}
	return out
}

// CreateReview opens a review.
func (h *Handlers) CreateReview(ctx context.Context, req api.CreateReviewRequestObject) (api.CreateReviewResponseObject, error) {
	b := req.Body
	v, err := h.Svc.CreateReview(ctx, principal(ctx), req.RepoId.String(), service.CreateReviewInput{Title: b.Title,
		Description: deref(b.Description), SourceBranch: b.SourceBranch, TargetBranch: b.TargetBranch, Draft: deref(b.Draft)},
		req.Params.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return api.CreateReview201JSONResponse(reviewOut(v)), nil
}

// GetReview returns a review.
func (h *Handlers) GetReview(ctx context.Context, req api.GetReviewRequestObject) (api.GetReviewResponseObject, error) {
	v, err := h.Svc.GetReview(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String())
	if err != nil {
		return nil, err
	}
	return api.GetReview200JSONResponse(reviewOut(v)), nil
}

// ListReviews pages reviews; the cursor is the last id seen.
func (h *Handlers) ListReviews(ctx context.Context, req api.ListReviewsRequestObject) (api.ListReviewsResponseObject, error) {
	limit := limitOr(req.Params.Limit, 50)
	after := ""
	if req.Params.Cursor != nil {
		after = *req.Params.Cursor
	}
	status := ""
	if req.Params.Status != nil {
		status = string(*req.Params.Status)
	}
	vs, err := h.Svc.ListReviews(ctx, principal(ctx), req.RepoId.String(), status, after, limit+1)
	if err != nil {
		return nil, err
	}
	out := api.ListReviews200JSONResponse{Items: []api.Review{}}
	for i, v := range vs {
		if i == limit {
			out.NextCursor = &vs[limit-1].Row.ID
			break
		}
		out.Items = append(out.Items, reviewOut(v))
	}
	return out, nil
}

// PublishReview publishes a draft.
func (h *Handlers) PublishReview(ctx context.Context, req api.PublishReviewRequestObject) (api.PublishReviewResponseObject, error) {
	v, err := h.Svc.PublishReview(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String())
	if err != nil {
		return nil, err
	}
	return api.PublishReview200JSONResponse(reviewOut(v)), nil
}

// ApproveReview approves the current source oid.
func (h *Handlers) ApproveReview(ctx context.Context, req api.ApproveReviewRequestObject) (api.ApproveReviewResponseObject, error) {
	v, err := h.Svc.Approve(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String(), req.Body.SourceOid)
	if err != nil {
		return nil, err
	}
	return api.ApproveReview200JSONResponse(reviewOut(v)), nil
}

func commentOut(c db.VersioningReviewComment) api.Comment {
	return api.Comment{Id: uid(c.ID), AuthorId: c.AuthorID, SampleId: c.SampleID, AnnotationId: c.AnnotationID,
		SourceOid: c.SourceOid, Body: c.Body, CreatedAt: c.CreatedAt}
}

// AddReviewComment anchors a comment.
func (h *Handlers) AddReviewComment(ctx context.Context, req api.AddReviewCommentRequestObject) (api.AddReviewCommentResponseObject, error) {
	c, err := h.Svc.AddComment(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String(),
		deref(req.Body.SampleId), deref(req.Body.AnnotationId), req.Body.Body)
	if err != nil {
		return nil, err
	}
	return api.AddReviewComment201JSONResponse(commentOut(*c)), nil
}

// ListReviewComments lists comments.
func (h *Handlers) ListReviewComments(ctx context.Context, req api.ListReviewCommentsRequestObject) (api.ListReviewCommentsResponseObject, error) {
	cs, err := h.Svc.ListComments(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String())
	if err != nil {
		return nil, err
	}
	out := api.ListReviewComments200JSONResponse{}
	for _, c := range cs {
		out = append(out, commentOut(c))
	}
	return out, nil
}

// ResolveConflicts stores resolutions.
func (h *Handlers) ResolveConflicts(ctx context.Context, req api.ResolveConflictsRequestObject) (api.ResolveConflictsResponseObject, error) {
	var res []merge.Resolution
	for _, r := range req.Body.Resolutions {
		x := merge.Resolution{Key: r.ConflictKey, Choice: string(r.Choice)}
		if r.Custom != nil {
			b, err := json.Marshal(*r.Custom)
			if err != nil {
				return nil, err
			}
			x.Custom = b
		}
		res = append(res, x)
	}
	v, err := h.Svc.ResolveConflicts(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String(), req.Body.SourceOid, req.Body.TargetOid, res)
	if err != nil {
		return nil, err
	}
	return api.ResolveConflicts200JSONResponse(reviewOut(v)), nil
}

// ReportCheck stores a worker-computed check.
func (h *Handlers) ReportCheck(ctx context.Context, req api.ReportCheckRequestObject) (api.ReportCheckResponseObject, error) {
	b := req.Body
	v, err := h.Svc.ReportCheck(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String(), req.CheckName,
		b.SourceOid, b.TargetOid, string(b.Outcome), deref(b.Details))
	if err != nil {
		return nil, err
	}
	return api.ReportCheck200JSONResponse(reviewOut(v)), nil
}

// RecheckReview re-runs checks.
func (h *Handlers) RecheckReview(ctx context.Context, req api.RecheckReviewRequestObject) (api.RecheckReviewResponseObject, error) {
	v, err := h.Svc.Recheck(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String())
	if err != nil {
		return nil, err
	}
	return api.RecheckReview200JSONResponse(reviewOut(v)), nil
}

// MergeReview merges a READY review.
func (h *Handlers) MergeReview(ctx context.Context, req api.MergeReviewRequestObject) (api.MergeReviewResponseObject, error) {
	v, err := h.Svc.MergeReview(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String(), req.Body.IdempotencyKey, deref(req.Body.Message))
	if err != nil {
		return nil, err
	}
	return api.MergeReview200JSONResponse(reviewOut(v)), nil
}

// CloseReview closes a review.
func (h *Handlers) CloseReview(ctx context.Context, req api.CloseReviewRequestObject) (api.CloseReviewResponseObject, error) {
	v, err := h.Svc.CloseReview(ctx, principal(ctx), req.RepoId.String(), req.ReviewId.String())
	if err != nil {
		return nil, err
	}
	return api.CloseReview200JSONResponse(reviewOut(v)), nil
}

// ---- releases ----

func releaseOut(r db.VersioningDatasetRelease) api.Release {
	att := []map[string]any{}
	_ = json.Unmarshal(r.Attestations, &att)
	return api.Release{Tag: r.Tag, CommitOid: r.CommitOid, ManifestRoot: r.ManifestRoot, CreatedBy: r.CreatedBy,
		CreatedAt: r.CreatedAt, RetentionPolicy: r.RetentionPolicy, RetainUntil: r.RetainUntil, Attestations: att, StudioTree: r.StudioTree}
}

// CreateRelease publishes a release.
func (h *Handlers) CreateRelease(ctx context.Context, req api.CreateReleaseRequestObject) (api.CreateReleaseResponseObject, error) {
	b := req.Body
	policy := ""
	if b.RetentionPolicy != nil {
		policy = string(*b.RetentionPolicy)
	}
	r, err := h.Svc.CreateRelease(ctx, principal(ctx), req.RepoId.String(), b.Tag, b.CommitOid, policy, b.RetainUntil, req.Params.IdempotencyKey)
	if err != nil {
		return nil, err
	}
	return api.CreateRelease201JSONResponse(releaseOut(*r)), nil
}

// GetRelease returns a release.
func (h *Handlers) GetRelease(ctx context.Context, req api.GetReleaseRequestObject) (api.GetReleaseResponseObject, error) {
	r, err := h.Svc.GetRelease(ctx, principal(ctx), req.RepoId.String(), req.Tag)
	if err != nil {
		return nil, err
	}
	return api.GetRelease200JSONResponse(releaseOut(*r)), nil
}

// ListReleases lists releases.
func (h *Handlers) ListReleases(ctx context.Context, req api.ListReleasesRequestObject) (api.ListReleasesResponseObject, error) {
	rs, err := h.Svc.ListReleases(ctx, principal(ctx), req.RepoId.String())
	if err != nil {
		return nil, err
	}
	out := api.ListReleases200JSONResponse{}
	for _, r := range rs {
		out = append(out, releaseOut(r))
	}
	return out, nil
}

// DeleteRelease deletes a release past retention.
func (h *Handlers) DeleteRelease(ctx context.Context, req api.DeleteReleaseRequestObject) (api.DeleteReleaseResponseObject, error) {
	if err := h.Svc.DeleteRelease(ctx, principal(ctx), req.RepoId.String(), req.Tag); err != nil {
		return nil, err
	}
	return api.DeleteRelease204Response{}, nil
}

// ---- checkouts ----

// CreateCheckout returns a scoped manifest page with signed URLs.
func (h *Handlers) CreateCheckout(ctx context.Context, req api.CreateCheckoutRequestObject) (api.CreateCheckoutResponseObject, error) {
	b := req.Body
	in := service.CheckoutInput{Ref: b.Ref, Cursor: deref(b.Cursor), Limit: deref(b.Limit), IncludeURLs: b.IncludeUrls == nil || *b.IncludeUrls}
	if f := b.Filter; f != nil {
		in.Filter = manifests.Filter{SampleIDs: deref(f.SampleIds), Splits: deref(f.Splits), StudyUIDHashes: deref(f.StudyUidHashes)}
	}
	c, err := h.Svc.CreateCheckout(ctx, principal(ctx), req.RepoId.String(), in)
	if err != nil {
		return nil, err
	}
	out := api.CreateCheckout200JSONResponse{CommitOid: c.CommitOID, ManifestRoot: c.ManifestRoot, Ontology: c.Manifest.Ontology,
		Samples: c.Manifest.Samples, Annotations: c.Manifest.Annotations, Objects: []api.SignedObject{},
		ExpiresAt: c.ExpiresAt.UTC().Truncate(time.Second), BucketsRead: c.BucketsRead, NextCursor: strp(c.Next)}
	for _, o := range c.Objects {
		out.Objects = append(out.Objects, api.SignedObject{Sha256: o.SHA256, SizeBytes: o.SizeBytes,
			Status: api.SignedObjectStatus(o.Status), Url: strp(o.URL)})
	}
	return out, nil
}
