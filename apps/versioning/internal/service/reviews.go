package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/authz"
	"studio.local/versioning/internal/db"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/merge"
)

// Review statuses (spec §9).
const (
	StDraft      = "DRAFT"
	StOpen       = "OPEN"
	StChecking   = "CHECKING"
	StReady      = "READY"
	StBlocked    = "BLOCKED"
	StConflicted = "CONFLICTED"
	StMerging    = "MERGING"
	StMerged     = "MERGED"
	StClosed     = "CLOSED"
)

// Transitions is the review state machine as an explicit table:
//
//	DRAFT -> OPEN -> CHECKING -> READY -> MERGING -> MERGED
//	                    |           |
//	                  BLOCKED     CONFLICTED
//	OPEN/READY/BLOCKED/CONFLICTED -> CLOSED
//
// plus the re-check edges the spec implies: any head change sends a review
// back to CHECKING, and a stale target during MERGING does too.
var Transitions = map[string][]string{
	StDraft:      {StOpen},
	StOpen:       {StChecking, StClosed},
	StChecking:   {StChecking, StReady, StBlocked, StConflicted},
	StReady:      {StMerging, StChecking, StConflicted, StClosed},
	StBlocked:    {StChecking, StClosed},
	StConflicted: {StChecking, StClosed},
	StMerging:    {StMerged, StChecking},
	StMerged:     {},
	StClosed:     {},
}

// CanTransition reports whether from -> to is in the table.
func CanTransition(from, to string) bool {
	for _, t := range Transitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// MergeAllowed is the merge guard: only a READY review whose current source
// oid has the required approvals and whose mandatory checks all passed.
func MergeAllowed(status string, approvalsOnSource, required int, mandatoryPassed bool) bool {
	return status == StReady && approvalsOnSource >= required && mandatoryPassed
}

// Check names. Mandatory checks block merging; optional ones only report.
const (
	CheckMergeBase       = "merge_base"
	CheckReferential     = "referential_integrity"
	CheckArtifacts       = "artifact_checksum"
	CheckSchema          = "schema_compatibility"
	CheckGeometry        = "geometry_validity"
	CheckDeidentify      = "deidentification"
	CheckLeakage         = "leakage"
	CheckClassBalance    = "class_balance"
	outcomePending       = "pending"
	outcomePassed        = "passed"
	outcomeFailed        = "failed"
	outcomeError         = "error"
	systemActor          = "versioning"
	maxCheckDetailsBytes = 16 << 10
)

// MandatoryChecks gate READY.
var MandatoryChecks = []string{CheckMergeBase, CheckReferential, CheckArtifacts, CheckSchema, CheckGeometry, CheckDeidentify}

// ExternalChecks are reported by workers rather than computed here.
var ExternalChecks = map[string]bool{CheckDeidentify: true}

func isMandatory(name string) bool {
	for _, m := range MandatoryChecks {
		if m == name {
			return true
		}
	}
	return false
}

// ReviewView is a review with approvals, checks and conflicts for its current
// (source, target) pair.
type ReviewView struct {
	Row       db.VersioningReviewRequest
	Approvals []db.VersioningReviewApproval
	Checks    []db.VersioningReviewCheck
	Conflicts []db.VersioningMergeConflict
}

func systemPrincipal(tenant string) *authn.Principal {
	return &authn.Principal{TenantID: tenant, Actor: authn.Actor{ID: systemActor, Kind: authn.KindService}, Scopes: map[string]bool{}}
}

func (s *Service) view(ctx context.Context, q *db.Queries, r db.VersioningReviewRequest) (*ReviewView, error) {
	v := &ReviewView{Row: r}
	var err error
	if v.Approvals, err = q.ListApprovals(ctx, r.ID); err != nil {
		return nil, err
	}
	target := deref(r.CheckedTargetOid)
	if v.Checks, err = q.ListChecks(ctx, db.ListChecksParams{ReviewID: r.ID, SourceOid: r.SourceOid, TargetOid: target}); err != nil {
		return nil, err
	}
	if v.Conflicts, err = q.ListConflicts(ctx, db.ListConflictsParams{ReviewID: r.ID, SourceOid: r.SourceOid, TargetOid: target}); err != nil {
		return nil, err
	}
	return v, nil
}

// transition moves a review along the table with optimistic concurrency and
// writes the audit and outbox records (todo4 2.4).
func (s *Service) transition(ctx context.Context, q *db.Queries, p *authn.Principal, r db.VersioningReviewRequest, to string,
	mut func(*db.UpdateReviewStateParams)) (db.VersioningReviewRequest, error) {
	if !CanTransition(r.Status, to) {
		return r, errf(http.StatusConflict, "invalid_transition", "cannot move review from %s to %s", r.Status, to)
	}
	u := db.UpdateReviewStateParams{Status: to, SourceOid: r.SourceOid, CheckedTargetOid: r.CheckedTargetOid,
		BaseOid: r.BaseOid, MergeOid: r.MergeOid, ID: r.ID, Version: r.Version}
	if mut != nil {
		mut(&u)
	}
	nr, err := q.UpdateReviewState(ctx, u)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, errf(http.StatusConflict, "conflict", "review changed concurrently; retry")
	}
	if err != nil {
		return r, err
	}
	payload := map[string]string{"from": r.Status, "to": to, "source_oid": nr.SourceOid, "target_oid": deref(nr.CheckedTargetOid)}
	commit := nr.SourceOid
	if to == StMerged {
		commit = deref(nr.MergeOid)
		payload["merge_oid"], payload["base_oid"] = commit, deref(nr.BaseOid)
	}
	if err := s.audit(ctx, q, p, r.RepoID, "review."+lower(to), r.ID, commit, payload); err != nil {
		return r, err
	}
	if r.Status == StChecking && to != StChecking {
		if err := emitAs(ctx, q, s.Now(), r.TenantID, p.Actor.ID, r.RepoID, EvReviewChecksDone, r.ID, payload); err != nil {
			return r, err
		}
	}
	return nr, nil
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// CreateReviewInput opens a review request.
type CreateReviewInput struct {
	Title        string `json:"title"`
	Description  string `json:"description"`
	SourceBranch string `json:"source_branch"`
	TargetBranch string `json:"target_branch"`
	Draft        bool   `json:"draft"`
}

// CreateReview opens (or drafts) a review and schedules its checks.
func (s *Service) CreateReview(ctx context.Context, p *authn.Principal, repoID string, in CreateReviewInput, idemKey string) (*ReviewView, error) {
	if err := require(p, authn.ScopeReview); err != nil {
		return nil, err
	}
	if in.SourceBranch == in.TargetBranch {
		return nil, errf(http.StatusBadRequest, "bad_request", "source and target must differ")
	}
	k, err := newIdem(repoID, "@op/review/"+in.SourceBranch+"->"+in.TargetBranch, idemKey, in)
	if err != nil {
		return nil, err
	}
	row, err := idempotent(ctx, s, p, k, http.StatusCreated, func(q *db.Queries, tx pgx.Tx) (db.VersioningReviewRequest, error) {
		repo, err := s.repo(ctx, q, p, repoID)
		if err != nil {
			return db.VersioningReviewRequest{}, err
		}
		src, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: in.SourceBranch})
		if err != nil || src.DeletedAt != nil {
			return db.VersioningReviewRequest{}, errf(http.StatusNotFound, "not_found", "source branch not found")
		}
		tgt, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: in.TargetBranch})
		if err != nil || tgt.DeletedAt != nil {
			return db.VersioningReviewRequest{}, errf(http.StatusNotFound, "not_found", "target branch not found")
		}
		approvals := repo.RequiredApprovals
		if tgt.Protected && approvals < 1 {
			approvals = 1 // protected targets always require review
		}
		status := StOpen
		if in.Draft {
			status = StDraft
		}
		r, err := q.InsertReview(ctx, db.InsertReviewParams{ID: ids.New(), TenantID: p.TenantID, RepoID: repoID,
			Title: in.Title, Description: in.Description, AuthorID: p.Actor.ID, AuthorOnBehalfOf: strOrNil(p.Actor.OnBehalfOf),
			SourceBranch: in.SourceBranch, SourceOid: src.CommitOid, TargetBranch: in.TargetBranch, Status: status,
			RequiredApprovals: approvals})
		if err != nil {
			return r, err
		}
		if err := s.audit(ctx, q, p, repoID, "review.created", r.ID, r.SourceOid, map[string]string{"status": status}); err != nil {
			return r, err
		}
		if in.Draft {
			return r, nil
		}
		return s.open(ctx, q, tx, p, r, tgt.CommitOid)
	})
	if err != nil {
		return nil, err
	}
	return s.GetReview(ctx, p, repoID, row.ID)
}

// open moves OPEN -> CHECKING, announces the review and schedules checks.
func (s *Service) open(ctx context.Context, q *db.Queries, tx pgx.Tx, p *authn.Principal, r db.VersioningReviewRequest, targetOID string) (db.VersioningReviewRequest, error) {
	if err := s.emit(ctx, q, p, r.RepoID, EvReviewOpened, r.ID, map[string]string{
		"review_id": r.ID, "source_oid": r.SourceOid, "target_oid": targetOID,
		"source_branch": r.SourceBranch, "target_branch": r.TargetBranch}); err != nil {
		return r, err
	}
	return s.startChecks(ctx, q, tx, p, r, r.SourceOid, targetOID, false)
}

// startChecks moves a review to CHECKING for (source, target) and enqueues
// the built-in checks; approvals for other source oids are cleared (V8).
func (s *Service) startChecks(ctx context.Context, q *db.Queries, tx pgx.Tx, p *authn.Principal, r db.VersioningReviewRequest,
	source, target string, announce bool) (db.VersioningReviewRequest, error) {
	nr, err := s.transition(ctx, q, p, r, StChecking, func(u *db.UpdateReviewStateParams) {
		u.SourceOid, u.CheckedTargetOid, u.BaseOid = source, &target, nil
	})
	if err != nil {
		return r, err
	}
	if err := q.DeleteStaleApprovals(ctx, db.DeleteStaleApprovalsParams{ReviewID: r.ID, ApprovedSourceOid: source}); err != nil {
		return r, err
	}
	for name := range ExternalChecks {
		if err := q.InsertPendingCheck(ctx, db.InsertPendingCheckParams{TenantID: r.TenantID, ReviewID: r.ID, SourceOid: source,
			TargetOid: target, Name: name, Mandatory: isMandatory(name)}); err != nil {
			return r, err
		}
	}
	if announce {
		if err := emitAs(ctx, q, s.Now(), r.TenantID, p.Actor.ID, r.RepoID, EvReviewChecksRequest, r.ID,
			map[string]string{"review_id": r.ID, "source_oid": source, "target_oid": target}); err != nil {
			return r, err
		}
	}
	return nr, s.enqueue(ctx, tx, ReviewChecksArgs{TenantID: r.TenantID, RepoID: r.RepoID, ReviewID: r.ID, SourceOID: source, TargetOID: target})
}

// invalidateReviews runs inside the head-moving transaction: reviews whose
// source moved get the new source oid and lose approvals; reviews whose
// target moved are re-checked. Rebase counts as a change (V8).
func (s *Service) invalidateReviews(ctx context.Context, q *db.Queries, tx pgx.Tx, p *authn.Principal, repoID, branch, newOID string) error {
	rows, err := q.OpenReviewsForBranch(ctx, db.OpenReviewsForBranchParams{RepoID: repoID, SourceBranch: branch})
	if err != nil {
		return err
	}
	skip, _ := ctx.Value(mergingReviewKey{}).(string)
	for _, r := range rows {
		if r.ID == skip || r.Status == StMerging {
			continue
		}
		source, target := r.SourceOid, deref(r.CheckedTargetOid)
		if r.SourceBranch == branch {
			source = newOID
		}
		if r.TargetBranch == branch {
			target = newOID
		}
		if r.Status == StOpen && target == "" {
			continue
		}
		if _, err := s.startChecks(ctx, q, tx, p, r, source, target, true); err != nil {
			return err
		}
	}
	return nil
}

type mergingReviewKey struct{}

// GetReview returns a review.
func (s *Service) GetReview(ctx context.Context, p *authn.Principal, repoID, reviewID string) (*ReviewView, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var v *ReviewView
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		r, err := s.reviewRow(ctx, q, repoID, reviewID, false)
		if err != nil {
			return err
		}
		v, err = s.view(ctx, q, r)
		return err
	})
	return v, err
}

func (s *Service) reviewRow(ctx context.Context, q *db.Queries, repoID, reviewID string, lock bool) (db.VersioningReviewRequest, error) {
	if !ids.Valid(reviewID) {
		return db.VersioningReviewRequest{}, errf(http.StatusNotFound, "not_found", "review not found")
	}
	var r db.VersioningReviewRequest
	var err error
	if lock {
		r, err = q.GetReviewForUpdate(ctx, db.GetReviewForUpdateParams{RepoID: repoID, ID: reviewID})
	} else {
		r, err = q.GetReview(ctx, db.GetReviewParams{RepoID: repoID, ID: reviewID})
	}
	return r, notFound(err, "review")
}

// ListReviews pages reviews by id.
func (s *Service) ListReviews(ctx context.Context, p *authn.Principal, repoID, status, after string, limit int) ([]*ReviewView, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	if after == "" {
		after = zeroRepo
	}
	var out []*ReviewView
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		rows, err := q.ListReviews(ctx, db.ListReviewsParams{RepoID: repoID, Status: strOrNil(status), After: after, Lim: int32(limit)})
		if err != nil {
			return err
		}
		for _, r := range rows {
			v, err := s.view(ctx, q, r)
			if err != nil {
				return err
			}
			out = append(out, v)
		}
		return nil
	})
	return out, err
}

// mutateReview locks a review and runs fn in one transaction, then returns
// the fresh view.
func (s *Service) mutateReview(ctx context.Context, p *authn.Principal, repoID, reviewID string,
	fn func(q *db.Queries, tx pgx.Tx, r db.VersioningReviewRequest) error) (*ReviewView, error) {
	var v *ReviewView
	err := s.tx(ctx, p.TenantID, func(q *db.Queries, tx pgx.Tx) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		r, err := s.reviewRow(ctx, q, repoID, reviewID, true)
		if err != nil {
			return err
		}
		if err := fn(q, tx, r); err != nil {
			return err
		}
		r, err = s.reviewRow(ctx, q, repoID, reviewID, false)
		if err != nil {
			return err
		}
		v, err = s.view(ctx, q, r)
		return err
	})
	return v, err
}

// PublishReview moves a draft to OPEN and starts checks.
func (s *Service) PublishReview(ctx context.Context, p *authn.Principal, repoID, reviewID string) (*ReviewView, error) {
	if err := require(p, authn.ScopeReview); err != nil {
		return nil, err
	}
	return s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, tx pgx.Tx, r db.VersioningReviewRequest) error {
		if r.AuthorID != p.Actor.ID {
			return errf(http.StatusForbidden, "forbidden", "only the author can publish a draft")
		}
		src, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.SourceBranch})
		if err != nil {
			return err
		}
		tgt, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.TargetBranch})
		if err != nil {
			return err
		}
		r, err = s.transition(ctx, q, p, r, StOpen, func(u *db.UpdateReviewStateParams) { u.SourceOid = src.CommitOid })
		if err != nil {
			return err
		}
		_, err = s.open(ctx, q, tx, p, r, tgt.CommitOid)
		return err
	})
}

// Approve records an approval bound to the reviewed source oid.
func (s *Service) Approve(ctx context.Context, p *authn.Principal, repoID, reviewID, sourceOID string) (*ReviewView, error) {
	if err := require(p, authn.ScopeApprove); err != nil {
		return nil, err
	}
	return s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, _ pgx.Tx, r db.VersioningReviewRequest) error {
		switch r.Status {
		case StOpen, StChecking, StReady, StBlocked, StConflicted:
		default:
			return errf(http.StatusConflict, "invalid_transition", "cannot approve a %s review", r.Status)
		}
		if err := authz.CanApprove(p, r.AuthorID, deref(r.AuthorOnBehalfOf)); err != nil {
			return errf(http.StatusForbidden, "self_approval", "%v", err)
		}
		if sourceOID != r.SourceOid {
			return &Error{Status: http.StatusConflict, Code: "stale_head", Detail: "the source changed since you reviewed it", CurrentHead: r.SourceOid}
		}
		if err := q.InsertApproval(ctx, db.InsertApprovalParams{TenantID: p.TenantID, ReviewID: r.ID, ReviewerID: p.Actor.ID,
			ApprovedSourceOid: sourceOID}); err != nil {
			return err
		}
		return s.audit(ctx, q, p, repoID, "review.approved", r.ID, sourceOID, nil)
	})
}

// AddComment anchors a comment to a sample/annotation id and the source oid.
func (s *Service) AddComment(ctx context.Context, p *authn.Principal, repoID, reviewID, sampleID, annotationID, body string) (*db.VersioningReviewComment, error) {
	if err := require(p, authn.ScopeReview); err != nil {
		return nil, err
	}
	var out db.VersioningReviewComment
	_, err := s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, _ pgx.Tx, r db.VersioningReviewRequest) error {
		c, err := q.InsertComment(ctx, db.InsertCommentParams{ID: ids.New(), TenantID: p.TenantID, ReviewID: r.ID, AuthorID: p.Actor.ID,
			SampleID: strOrNil(sampleID), AnnotationID: strOrNil(annotationID), SourceOid: r.SourceOid, Body: body})
		out = c
		return err
	})
	return &out, err
}

// ListComments lists a review's comments.
func (s *Service) ListComments(ctx context.Context, p *authn.Principal, repoID, reviewID string) ([]db.VersioningReviewComment, error) {
	if err := require(p, authn.ScopeRead); err != nil {
		return nil, err
	}
	var out []db.VersioningReviewComment
	err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		r, err := s.reviewRow(ctx, q, repoID, reviewID, false)
		if err != nil {
			return err
		}
		out, err = q.ListComments(ctx, r.ID)
		return err
	})
	return out, err
}

// ReportCheck stores a worker-computed check result for immutable oids.
func (s *Service) ReportCheck(ctx context.Context, p *authn.Principal, repoID, reviewID, name, source, target, outcome string, details map[string]any) (*ReviewView, error) {
	if err := require(p, authn.ScopeChecks); err != nil {
		return nil, err
	}
	if !ExternalChecks[name] {
		return nil, errf(http.StatusBadRequest, "bad_request", "%s is computed by the service, not reported", name)
	}
	if outcome != outcomePassed && outcome != outcomeFailed && outcome != outcomeError {
		return nil, errf(http.StatusBadRequest, "bad_request", "invalid outcome")
	}
	b, err := json.Marshal(details)
	if err != nil || len(b) > maxCheckDetailsBytes {
		return nil, errf(http.StatusBadRequest, "bad_request", "details too large")
	}
	if details == nil {
		b = []byte(`{}`)
	}
	return s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, _ pgx.Tx, r db.VersioningReviewRequest) error {
		if r.SourceOid != source || deref(r.CheckedTargetOid) != target {
			return &Error{Status: http.StatusConflict, Code: "stale_head", Detail: "result is for superseded oids", CurrentHead: r.SourceOid}
		}
		if err := q.UpsertCheck(ctx, db.UpsertCheckParams{TenantID: p.TenantID, ReviewID: r.ID, SourceOid: source, TargetOid: target,
			Name: name, Mandatory: isMandatory(name), Outcome: outcome, Details: b}); err != nil {
			return err
		}
		if err := s.audit(ctx, q, p, repoID, "review.check_reported", r.ID, source, map[string]string{"check": name, "outcome": outcome}); err != nil {
			return err
		}
		_, err := s.evaluate(ctx, q, p, r)
		return err
	})
}

// Recheck re-runs checks for the current heads.
func (s *Service) Recheck(ctx context.Context, p *authn.Principal, repoID, reviewID string) (*ReviewView, error) {
	if err := require(p, authn.ScopeReview); err != nil {
		return nil, err
	}
	return s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, tx pgx.Tx, r db.VersioningReviewRequest) error {
		src, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.SourceBranch})
		if err != nil {
			return err
		}
		tgt, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.TargetBranch})
		if err != nil {
			return err
		}
		_, err = s.startChecks(ctx, q, tx, p, r, src.CommitOid, tgt.CommitOid, true)
		return err
	})
}

// CloseReview closes a review without merging.
func (s *Service) CloseReview(ctx context.Context, p *authn.Principal, repoID, reviewID string) (*ReviewView, error) {
	if err := require(p, authn.ScopeReview); err != nil {
		return nil, err
	}
	return s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, _ pgx.Tx, r db.VersioningReviewRequest) error {
		if r.AuthorID != p.Actor.ID && !p.Has(authn.ScopeAdmin) {
			return errf(http.StatusForbidden, "forbidden", "only the author or an admin can close a review")
		}
		_, err := s.transition(ctx, q, p, r, StClosed, nil)
		return err
	})
}

// evaluate settles a CHECKING review once every mandatory check has a result:
// unresolved conflicts -> CONFLICTED, failed mandatory checks -> BLOCKED,
// otherwise READY.
func (s *Service) evaluate(ctx context.Context, q *db.Queries, p *authn.Principal, r db.VersioningReviewRequest) (db.VersioningReviewRequest, error) {
	if r.Status != StChecking {
		return r, nil
	}
	target := deref(r.CheckedTargetOid)
	checks, err := q.ListChecks(ctx, db.ListChecksParams{ReviewID: r.ID, SourceOid: r.SourceOid, TargetOid: target})
	if err != nil {
		return r, err
	}
	have := map[string]db.VersioningReviewCheck{}
	for _, c := range checks {
		have[c.Name] = c
	}
	failed := false
	for _, name := range MandatoryChecks {
		c, ok := have[name]
		if !ok || c.Outcome == outcomePending {
			return r, nil // still waiting
		}
		if c.Outcome != outcomePassed {
			failed = true
		}
	}
	conflicts, err := q.ListConflicts(ctx, db.ListConflictsParams{ReviewID: r.ID, SourceOid: r.SourceOid, TargetOid: target})
	if err != nil {
		return r, err
	}
	unresolved := 0
	for _, c := range conflicts {
		if c.Resolution == nil {
			unresolved++
		}
	}
	switch {
	case failed:
		return s.transition(ctx, q, p, r, StBlocked, nil)
	case unresolved > 0:
		return s.transition(ctx, q, p, r, StConflicted, nil)
	default:
		return s.transition(ctx, q, p, r, StReady, nil)
	}
}

// ResolveConflicts stores resolutions for the current (source, target) pair
// and, once every conflict is resolved and the result validates, re-checks.
func (s *Service) ResolveConflicts(ctx context.Context, p *authn.Principal, repoID, reviewID, source, target string, res []merge.Resolution) (*ReviewView, error) {
	if err := require(p, authn.ScopeReview); err != nil {
		return nil, err
	}
	// Validate the resolutions against a fresh merge before storing them.
	var r db.VersioningReviewRequest
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		if _, err := s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		var err error
		r, err = s.reviewRow(ctx, q, repoID, reviewID, false)
		return err
	}); err != nil {
		return nil, err
	}
	if r.SourceOid != source || deref(r.CheckedTargetOid) != target {
		return nil, &Error{Status: http.StatusConflict, Code: "stale_head", Detail: "resolutions are for superseded oids", CurrentHead: r.SourceOid}
	}
	plan, err := s.planMerge(ctx, p.TenantID, repoID, target, source)
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for _, c := range plan.outcome.Conflicts {
		known[c.Key] = true
	}
	for _, x := range res {
		if !known[x.Key] {
			return nil, errf(http.StatusUnprocessableEntity, "validation_failed", "unknown conflict key %s", x.Key)
		}
	}
	if err := s.checkCustomRefs(ctx, p, res); err != nil {
		return nil, err
	}
	return s.mutateReview(ctx, p, repoID, reviewID, func(q *db.Queries, _ pgx.Tx, r db.VersioningReviewRequest) error {
		if r.SourceOid != source || deref(r.CheckedTargetOid) != target {
			return &Error{Status: http.StatusConflict, Code: "stale_head", Detail: "review moved", CurrentHead: r.SourceOid}
		}
		for _, x := range res {
			b, _ := json.Marshal(x)
			if _, err := q.ResolveConflict(ctx, db.ResolveConflictParams{ReviewID: r.ID, SourceOid: source, TargetOid: target,
				ConflictKey: x.Key, Resolution: b, ResolvedBy: &p.Actor.ID}); err != nil {
				return err
			}
		}
		if err := s.audit(ctx, q, p, repoID, "review.conflicts_resolved", r.ID, source, map[string]any{"keys": merge.Keys(plan.outcome.Conflicts)}); err != nil {
			return err
		}
		all, err := s.storedResolutions(ctx, q, r)
		if err != nil {
			return err
		}
		if len(all) < len(plan.outcome.Conflicts) || r.Status != StConflicted {
			return nil
		}
		if _, err := s.finalManifest(ctx, p, plan, all); err != nil {
			return err
		}
		nr, err := s.transition(ctx, q, p, r, StChecking, nil)
		if err != nil {
			return err
		}
		_, err = s.evaluate(ctx, q, p, nr)
		return err
	})
}

func (s *Service) storedResolutions(ctx context.Context, q *db.Queries, r db.VersioningReviewRequest) ([]merge.Resolution, error) {
	rows, err := q.ListConflicts(ctx, db.ListConflictsParams{ReviewID: r.ID, SourceOid: r.SourceOid, TargetOid: deref(r.CheckedTargetOid)})
	if err != nil {
		return nil, err
	}
	var out []merge.Resolution
	for _, c := range rows {
		if c.Resolution == nil {
			continue
		}
		var x merge.Resolution
		if err := json.Unmarshal(c.Resolution, &x); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, nil
}
