package publication

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"

	"studio.local/pipeline/internal/contracts"
	"studio.local/pipeline/internal/domain"
)

func sha(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

// ProposeInput is what a run proposes.
type ProposeInput struct {
	RunID        string
	RepoID       string
	TargetBranch string
	ManifestRoot string // versioning manifest root of the candidate dataset
	// OutputDigest is the staged output manifest's digest; approvals bind to it.
	OutputDigest string
	Title        string
	Description  string
	ItemCount    *int
}

// ProposeCandidate creates branch pipeline/<run_id> at the target head,
// commits the candidate on it and opens a review into the target. Every call
// carries a key derived from the run, so a retried engine step replays the
// same branch, commit and review instead of making new ones.
func (c *Client) ProposeCandidate(ctx context.Context, sc Scope, in ProposeInput) (*contracts.Candidate, error) {
	branch, err := domain.CandidateBranch(in.RunID)
	if err != nil {
		return nil, err
	}
	b, err := c.CreateBranch(ctx, sc, in.RepoID, branch, in.TargetBranch, idemKey("pipeline", in.RunID, "branch"))
	if err != nil {
		return nil, fmt.Errorf("candidate branch: %w", err)
	}
	commit, err := c.Commit(ctx, sc, in.RepoID, branch, b.CommitOID, in.ManifestRoot, "pipeline run "+in.RunID,
		idemKey("pipeline", in.RunID, "candidate"))
	if err != nil {
		return nil, fmt.Errorf("candidate commit: %w", err)
	}
	title := in.Title
	if title == "" {
		title = "Pipeline run " + in.RunID
	}
	rv, err := c.CreateReview(ctx, sc, in.RepoID, title, in.Description, branch, in.TargetBranch, idemKey("pipeline", in.RunID, "review"))
	if err != nil {
		return nil, fmt.Errorf("candidate review: %w", err)
	}
	return &contracts.Candidate{RepoID: in.RepoID, Branch: branch, TargetBranch: in.TargetBranch, Commit: commit.CommitOID,
		BaseCommit: b.CommitOID, ReviewID: rv.ID, OutputManifestDigest: in.OutputDigest, ItemCount: in.ItemCount}, nil
}

// Publish outcomes.
const (
	OutcomeMerged = "merged"
	// OutcomeStale: the target moved after the approval. Versioning re-checks
	// the same review against the new head (the rebase review); it needs a
	// fresh approval, which starts a new PublishWorkflow.
	OutcomeStale = "stale"
)

// PublishResult is what a publish attempt did.
type PublishResult struct {
	Outcome     string
	MergeCommit string
	// CurrentHead is the target head after a stale outcome.
	CurrentHead string
}

// ErrApprovalNotCurrent means the approval isn't on the review, isn't bound to
// this candidate's digest, or predates the review's current source or target.
var ErrApprovalNotCurrent = errors.New("approval is not current for this candidate")

// CheckApproval verifies the approval against the review and the candidate
// (docs/pipeline.md §5.2: bound to the candidate's digest and still current).
func CheckApproval(rv *Review, cand *contracts.Candidate, approvalID, digest string) error {
	if digest != cand.OutputManifestDigest {
		return fmt.Errorf("%w: digest %s, candidate is %s", ErrApprovalNotCurrent, digest, cand.OutputManifestDigest)
	}
	if rv.SourceOID != cand.Commit {
		return fmt.Errorf("%w: the review's source moved to %s", ErrApprovalNotCurrent, rv.SourceOID)
	}
	for _, a := range rv.Approvals {
		if a.ID != approvalID {
			continue
		}
		switch {
		case a.ReviewerID == ActorID:
			return fmt.Errorf("%w: self approval", ErrApprovalNotCurrent)
		case a.ApprovedSourceOID != rv.SourceOID:
			return fmt.Errorf("%w: approved another source", ErrApprovalNotCurrent)
		case a.CandidateDigest != digest:
			return fmt.Errorf("%w: approved another digest", ErrApprovalNotCurrent)
		}
		return nil
	}
	return fmt.Errorf("%w: approval %s not on review %s", ErrApprovalNotCurrent, approvalID, rv.ID)
}

// Publish merges an approved candidate through versioning's CAS. A review
// already merged returns its merge commit (a replay publishes nothing new);
// a stale approval or a moved target returns OutcomeStale.
func (c *Client) Publish(ctx context.Context, sc Scope, cand *contracts.Candidate, approvalID, digest string) (*PublishResult, error) {
	rv, err := c.GetReview(ctx, sc, cand.RepoID, cand.ReviewID)
	if err != nil {
		return nil, err
	}
	if rv.Status == "MERGED" && rv.MergeOID != "" {
		return &PublishResult{Outcome: OutcomeMerged, MergeCommit: rv.MergeOID}, nil
	}
	if err := CheckApproval(rv, cand, approvalID, digest); err != nil {
		return nil, err
	}
	for _, a := range rv.Approvals {
		if a.ID == approvalID && a.ApprovedTargetOID != rv.CheckedTargetOID {
			return &PublishResult{Outcome: OutcomeStale, CurrentHead: rv.CheckedTargetOID}, nil
		}
	}
	m, err := c.MergeReview(ctx, sc, cand.RepoID, cand.ReviewID, idemKey("publish", approvalID), "publish pipeline candidate")
	var p *Problem
	switch {
	case err == nil:
		return &PublishResult{Outcome: OutcomeMerged, MergeCommit: m.MergeOID}, nil
	case errors.As(err, &p) && p.Code == "stale_head":
		return &PublishResult{Outcome: OutcomeStale, CurrentHead: p.CurrentHead}, nil
	}
	return nil, err
}
