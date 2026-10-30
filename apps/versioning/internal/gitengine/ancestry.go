package gitengine

import (
	"errors"
	"fmt"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
)

// ErrMultipleMergeBases is returned for criss-cross histories (todo4 V8).
var ErrMultipleMergeBases = errors.New("multiple merge bases")

// ErrNoMergeBase is returned when histories are unrelated.
var ErrNoMergeBase = errors.New("no merge base")

// ErrWalkTooDeep is returned when a walk exceeds the per-request depth cap.
var ErrWalkTooDeep = errors.New("commit walk exceeds depth limit")

// MergeBase returns the single best common ancestor of a and b.
func (r *Repo) MergeBase(a, b string) (string, error) {
	ca, err := r.commitObject(a)
	if err != nil {
		return "", err
	}
	cb, err := r.commitObject(b)
	if err != nil {
		return "", err
	}
	bases, err := ca.MergeBase(cb)
	if err != nil {
		return "", fmt.Errorf("merge base: %w", err)
	}
	switch len(bases) {
	case 0:
		return "", ErrNoMergeBase
	case 1:
		return bases[0].Hash.String(), nil
	default:
		return "", ErrMultipleMergeBases
	}
}

// IsAncestor reports whether a is an ancestor of (or equal to) b.
func (r *Repo) IsAncestor(a, b string) (bool, error) {
	if a == b {
		return true, nil
	}
	ca, err := r.commitObject(a)
	if err != nil {
		return false, err
	}
	cb, err := r.commitObject(b)
	if err != nil {
		return false, err
	}
	return ca.IsAncestor(cb)
}

// Log returns up to limit commit ids reachable from head in topological
// pre-order, after skipping `skip` commits; walking beyond maxDepth fails.
func (r *Repo) Log(head string, skip, limit, maxDepth int) ([]string, error) {
	c, err := r.commitObject(head)
	if err != nil {
		return nil, err
	}
	it := object.NewCommitPreorderIter(c, nil, nil)
	defer it.Close()
	var out []string
	seen := 0
	err = it.ForEach(func(c *object.Commit) error {
		seen++
		if seen > maxDepth {
			return ErrWalkTooDeep
		}
		if seen <= skip {
			return nil
		}
		out = append(out, c.Hash.String())
		if len(out) >= limit {
			return storer.ErrStop
		}
		return nil
	})
	return out, err
}

// Walk visits every commit reachable from heads once (GC marking).
func (r *Repo) Walk(heads []string, fn func(oid string) error) error {
	seen := map[plumbing.Hash]bool{}
	for _, h := range heads {
		c, err := r.commitObject(h)
		if err != nil {
			return fmt.Errorf("walk %s: %w", h, err)
		}
		it := object.NewCommitPreorderIter(c, seen, nil)
		err = it.ForEach(func(c *object.Commit) error {
			seen[c.Hash] = true
			return fn(c.Hash.String())
		})
		it.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
