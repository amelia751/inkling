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
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/merge"
	"studio.local/versioning/internal/semanticdiff"
)

// mergePlan is a computed three-way merge of theirs (source) into ours (target).
type mergePlan struct {
	tenant, repo                string
	base, ours, theirs          string // commit oids
	baseRoot, oursRoot, theirsR *manifests.Root
	buckets                     []int // nil: whole manifests were merged
	input                       merge.Input
	outcome                     *merge.Outcome
}

func (s *Service) commitRoot(ctx context.Context, tenant, repoID, oid string) (string, error) {
	var root string
	err := s.read(ctx, tenant, func(q *db.Queries) error {
		c, err := q.GetCommitRow(ctx, db.GetCommitRowParams{RepoID: repoID, Oid: oid})
		root = c.ManifestRoot
		return notFound(err, "commit")
	})
	return root, err
}

func unionBuckets(a, b []int) []int {
	if a == nil || b == nil {
		return nil
	}
	set := map[int]bool{}
	for _, x := range append(append([]int{}, a...), b...) {
		set[x] = true
	}
	out := make([]int, 0, len(set))
	for i := 0; i < manifests.NumBuckets; i++ {
		if set[i] {
			out = append(out, i)
		}
	}
	return out
}

// planMerge finds the single merge base and merges the changed partitions.
func (s *Service) planMerge(ctx context.Context, tenant, repoID, ours, theirs string) (*mergePlan, error) {
	g := s.Git.Open(ctx, tenant, repoID)
	base, err := g.MergeBase(ours, theirs)
	if errors.Is(err, gitengine.ErrMultipleMergeBases) {
		return nil, errf(http.StatusConflict, "multiple_merge_bases", "criss-cross history: rebase the source onto the target")
	}
	if err != nil {
		return nil, err
	}
	pl := &mergePlan{tenant: tenant, repo: repoID, base: base, ours: ours, theirs: theirs}
	roots := make([]*manifests.Root, 3)
	for i, oid := range []string{base, ours, theirs} {
		h, err := s.commitRoot(ctx, tenant, repoID, oid)
		if err != nil {
			return nil, err
		}
		if roots[i], err = s.Manifests.LoadRoot(ctx, tenant, repoID, h); err != nil {
			return nil, err
		}
	}
	pl.baseRoot, pl.oursRoot, pl.theirsR = roots[0], roots[1], roots[2]
	pl.buckets = unionBuckets(semanticdiff.ChangedBuckets(roots[0], roots[1]), semanticdiff.ChangedBuckets(roots[0], roots[2]))
	load := func(r *manifests.Root) (*manifests.Manifest, error) {
		if pl.buckets == nil {
			return s.Manifests.Load(ctx, tenant, repoID, r.Hash)
		}
		m, err := s.Manifests.LoadBuckets(ctx, tenant, repoID, r, pl.buckets)
		if m != nil {
			m.Ontology = r.Ontology
		}
		return m, err
	}
	var sides [3]*manifests.Manifest
	for i, r := range roots {
		if sides[i], err = load(r); err != nil {
			return nil, err
		}
	}
	pl.input = merge.Input{Base: sides[0], Ours: sides[1], Theirs: sides[2], Revisions: s.revisions(tenant), Rules: s.Rules}
	if pl.outcome, err = merge.ThreeWay(ctx, pl.input); err != nil {
		return nil, err
	}
	return pl, nil
}

// finalManifest applies resolutions, re-validates and returns the complete
// merged manifest (unchanged partitions come from the target unchanged).
func (s *Service) finalManifest(ctx context.Context, p *authn.Principal, pl *mergePlan, res []merge.Resolution) (*manifests.Manifest, error) {
	merged := pl.outcome.Merged
	if len(pl.outcome.Conflicts) > 0 {
		var err error
		merged, err = merge.Apply(ctx, pl.input, pl.outcome, res)
		if errors.Is(err, merge.ErrUnresolved) {
			return nil, errf(http.StatusConflict, "unresolved_conflicts", "%v", err)
		}
		if err != nil {
			return nil, errf(http.StatusUnprocessableEntity, "validation_failed", "%v", err)
		}
	}
	full := merged
	if pl.buckets != nil {
		in := map[int]bool{}
		for _, b := range pl.buckets {
			in[b] = true
		}
		var rest []int
		for b := range pl.oursRoot.Buckets {
			if !in[b] {
				rest = append(rest, b)
			}
		}
		unchanged, err := s.Manifests.LoadBuckets(ctx, pl.tenant, pl.repo, pl.oursRoot, rest)
		if err != nil {
			return nil, err
		}
		full = manifests.Merge(merged.Ontology, unchanged, merged)
	}
	if err := manifests.Validate(full, s.Cfg.MaxCommitEntries); err != nil {
		return nil, validationErr(err)
	}
	return full, nil
}

func (s *Service) checkCustomRefs(ctx context.Context, p *authn.Principal, res []merge.Resolution) error {
	for _, r := range res {
		if r.Choice != merge.ChooseCustom {
			continue
		}
		kind, _, _ := merge.KeyParts(r.Key)
		if kind != "annotation" {
			continue
		}
		var a manifests.Annotation
		if err := json.Unmarshal(r.Custom, &a); err != nil {
			return errf(http.StatusBadRequest, "bad_request", "custom annotation resolution: %v", err)
		}
		if _, err := s.revisions(p.TenantID).LoadRevision(ctx, a.Ref); err != nil {
			return errf(http.StatusUnprocessableEntity, "validation_failed", "custom resolution references an unknown annotation revision")
		}
	}
	return nil
}

// MergeReview merges an approved, READY review into its target: a two-parent
// merge commit (built with plumbing) and a CAS on the target head. A stale
// target sends the review back to CHECKING and returns 409 (spec §8).
func (s *Service) MergeReview(ctx context.Context, p *authn.Principal, repoID, reviewID, idemKey, message string) (*ReviewView, error) {
	if err := require(p, authn.ScopeMerge); err != nil {
		return nil, err
	}
	if err := authz.CanMerge(p); err != nil {
		return nil, errf(http.StatusForbidden, "forbidden", "%v", err)
	}
	k, err := newIdem(repoID, "@op/merge/"+reviewID, idemKey, map[string]string{"review": reviewID})
	if err != nil {
		return nil, err
	}
	var (
		r          db.VersioningReviewRequest
		repo       db.VersioningDatasetRepository
		replayed   bool
		staleAfter *Error
	)
	err = s.tx(ctx, p.TenantID, func(q *db.Queries, tx pgx.Tx) error {
		var err error
		if repo, err = s.repo(ctx, q, p, repoID); err != nil {
			return err
		}
		if _, ok, err := lookupIdem(ctx, q, p.TenantID, k); err != nil || ok {
			replayed = ok
			return err
		}
		if r, err = s.reviewRow(ctx, q, repoID, reviewID, true); err != nil {
			return err
		}
		if r.Status != StReady {
			return errf(http.StatusConflict, "not_ready", "review is %s, not READY", r.Status)
		}
		apps, err := q.ListApprovals(ctx, r.ID)
		if err != nil {
			return err
		}
		n := 0
		for _, a := range apps {
			if a.ApprovedSourceOid == r.SourceOid {
				n++
			}
		}
		checks, err := q.ListChecks(ctx, db.ListChecksParams{ReviewID: r.ID, SourceOid: r.SourceOid, TargetOid: deref(r.CheckedTargetOid)})
		if err != nil {
			return err
		}
		passed := map[string]bool{}
		for _, c := range checks {
			passed[c.Name] = c.Outcome == outcomePassed
		}
		allPassed := true
		for _, m := range MandatoryChecks {
			allPassed = allPassed && passed[m]
		}
		if !MergeAllowed(r.Status, n, int(r.RequiredApprovals), allPassed) {
			return errf(http.StatusConflict, "not_ready", "%d of %d required approvals on the current source; mandatory checks passed: %v",
				n, r.RequiredApprovals, allPassed)
		}
		tgt, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.TargetBranch})
		if err != nil {
			return err
		}
		if tgt.CommitOid != deref(r.CheckedTargetOid) {
			if _, err := s.startChecks(ctx, q, tx, p, r, r.SourceOid, tgt.CommitOid, true); err != nil {
				return err
			}
			staleAfter = staleHead(tgt)
			return nil
		}
		r, err = s.transition(ctx, q, p, r, StMerging, nil)
		return err
	})
	if err != nil {
		return nil, err
	}
	if replayed {
		return s.GetReview(ctx, p, repoID, reviewID)
	}
	if staleAfter != nil {
		return nil, staleAfter
	}
	view, err := s.completeMerge(ctx, p, repo, r, k, message)
	if err != nil {
		s.abortMerge(ctx, p, repoID, reviewID)
		return nil, err
	}
	return view, nil
}

func (s *Service) completeMerge(ctx context.Context, p *authn.Principal, repo db.VersioningDatasetRepository, r db.VersioningReviewRequest, k idem, message string) (*ReviewView, error) {
	target := deref(r.CheckedTargetOid)
	pl, err := s.planMerge(ctx, p.TenantID, repo.ID, target, r.SourceOid)
	if err != nil {
		return nil, err
	}
	var res []merge.Resolution
	if err := s.read(ctx, p.TenantID, func(q *db.Queries) error {
		var err error
		res, err = s.storedResolutions(ctx, q, r)
		return err
	}); err != nil {
		return nil, err
	}
	full, err := s.finalManifest(ctx, p, pl, res)
	if err != nil {
		return nil, err
	}
	if err := s.storeRevisions(ctx, p, pl.outcome.NewRevisions); err != nil {
		return nil, err
	}
	w, err := s.Manifests.Write(ctx, p.TenantID, repo.ID, full)
	if err != nil {
		return nil, err
	}
	if err := s.tx(ctx, p.TenantID, func(q *db.Queries, _ pgx.Tx) error { return s.registerRoot(ctx, q, p, repo.ID, w) }); err != nil {
		return nil, err
	}
	if message == "" {
		message = "Merge review " + r.ID
	}
	snap := s.snapshot(repo.ID, repo.PolicyID, w, p, "merge", "", []string{target, r.SourceOid}, r.ID)
	var trees [3]string
	for i, c := range []string{pl.base, target, r.SourceOid} {
		if trees[i], err = s.studioOf(ctx, p.TenantID, repo.ID, c); err != nil {
			return nil, err
		}
	}
	snap.Studio.OID = mergeStudio(trees[0], trees[1], trees[2])
	oid, err := s.Git.Open(ctx, p.TenantID, repo.ID).WriteCommit(snap, []string{target, r.SourceOid}, p.Actor.ID, message, s.Now())
	if err != nil {
		return nil, err
	}
	if err := s.failpoint("merge.after-git-write"); err != nil {
		return nil, err
	}
	mctx := context.WithValue(ctx, mergingReviewKey{}, r.ID)
	_, err = s.advance(mctx, p, advanceArgs{repoID: repo.ID, branch: r.TargetBranch, expected: target, newOID: oid,
		root: w.RootHash, studio: snap.Studio.OID, parents: []string{target, r.SourceOid}, message: message, event: "review.merge_commit",
		idem: &k, allowProtected: true,
		extra: func(q *db.Queries, _ pgx.Tx, _ int64) error {
			cur, err := s.reviewRow(ctx, q, repo.ID, r.ID, true)
			if err != nil {
				return err
			}
			if _, err := s.transition(ctx, q, p, cur, StMerged, func(u *db.UpdateReviewStateParams) {
				u.MergeOid, u.BaseOid = &oid, &pl.base
			}); err != nil {
				return err
			}
			return s.emit(ctx, q, p, repo.ID, EvReviewMerged, r.ID, map[string]string{
				"review_id": r.ID, "merge_oid": oid, "source_oid": r.SourceOid, "target_oid": target, "target_branch": r.TargetBranch})
		}})
	if err != nil {
		return nil, err
	}
	return s.GetReview(ctx, p, repo.ID, r.ID)
}

// abortMerge returns a MERGING review to CHECKING after a failure; checks are
// re-run against whatever the heads are now.
func (s *Service) abortMerge(ctx context.Context, p *authn.Principal, repoID, reviewID string) {
	ctx = context.WithoutCancel(ctx)
	_ = s.tx(ctx, p.TenantID, func(q *db.Queries, tx pgx.Tx) error {
		r, err := s.reviewRow(ctx, q, repoID, reviewID, true)
		if err != nil || r.Status != StMerging {
			return err
		}
		tgt, err := q.GetBranch(ctx, db.GetBranchParams{RepoID: repoID, Name: r.TargetBranch})
		if err != nil {
			return err
		}
		_, err = s.startChecks(ctx, q, tx, p, r, r.SourceOid, tgt.CommitOid, true)
		return err
	})
}
