package authz

import (
	"errors"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"studio.local/versioning/internal/authn"
)

// Policy errors.
var (
	ErrSelfApproval = errors.New("authors cannot approve their own review")
	ErrAgentAction  = errors.New("agent actors cannot approve or merge reviews")
)

// CanApprove applies the approval rules (spec §9, §16C; todo4 2.4):
//   - an author cannot approve their own review;
//   - an agent cannot approve a review authored by itself, or by anyone acting
//     for the same user it acts for;
//   - nobody approves a review that was authored on their behalf.
//
// Agents are additionally never allowed to approve at all.
func CanApprove(reviewer *authn.Principal, authorID, authorOnBehalfOf string) error {
	if reviewer.Actor.Kind == authn.KindAgent {
		return ErrAgentAction
	}
	if reviewer.Actor.ID == authorID {
		return ErrSelfApproval
	}
	author := authorID
	if authorOnBehalfOf != "" {
		author = authorOnBehalfOf
	}
	if reviewer.Effective() == author || reviewer.Actor.ID == authorOnBehalfOf {
		return ErrSelfApproval
	}
	return nil
}

// CanMerge forbids agents from merging (approve and merge are never exposed
// to agents, todo4 Phase 6).
func CanMerge(p *authn.Principal) error {
	if p.Actor.Kind == authn.KindAgent {
		return ErrAgentAction
	}
	return nil
}

// AgentBranchAllowed reports whether an agent may commit to branch: only its
// own work/agent-* branches.
func AgentBranchAllowed(p *authn.Principal, branch string) bool {
	if p.Actor.Kind != authn.KindAgent {
		return true
	}
	return strings.HasPrefix(branch, "work/agent-")
}

// RateLimiter is a per-actor, per-operation token bucket (spec §14). It is
// per process; with N replicas the effective limit is N times higher, which
// is acceptable as a backstop behind the API gateway's own limits.
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*rate.Limiter
}

// NewRateLimiter returns an empty limiter.
func NewRateLimiter() *RateLimiter { return &RateLimiter{buckets: map[string]*rate.Limiter{}} }

// Allow consumes one token for (op, actor) at perMinute.
func (l *RateLimiter) Allow(op, actor string, perMinute int) bool {
	key := op + "\x00" + actor
	l.mu.Lock()
	b, ok := l.buckets[key]
	if !ok {
		b = rate.NewLimiter(rate.Every(time.Minute/time.Duration(perMinute)), perMinute)
		l.buckets[key] = b
	}
	l.mu.Unlock()
	return b.Allow()
}
