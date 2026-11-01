package compiler

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"studio.local/pipeline/internal/contracts"
)

// Signers that never resolve (packages/contracts lockfile.ts).
const (
	SignerFirstParty = "first-party"
	SignerUnsigned   = "unsigned"
)

// Resolution is the one immutable, signed version a `uses` resolved to.
type Resolution struct {
	Contract contracts.StepContract
	Resolved contracts.ResolvedStep
}

// Resolver errors.
var (
	ErrUnresolved = errors.New("no approved version")
	ErrUnsigned   = errors.New("version is not signed")
)

// Resolver maps `<id>@<major>` to a signed version. Implementations see only
// installed, approved versions: the workspace's plugin pins plus the
// platform's own steps (docs/pipeline.md §13).
type Resolver interface {
	Resolve(id string, major int) (Resolution, error)
}

// Entry is one candidate version a StaticResolver may choose.
type Entry struct {
	Contract contracts.StepContract
	// Digest is the plugin artifact digest; empty for platform steps, whose
	// digest is that of their canonical contract.
	Digest string
	Signer string
}

// StaticResolver resolves from a fixed list: the highest version within the
// requested major wins. An unsigned entry is a hard error, never skipped, so
// an agent can't sneak an unsigned build in under a signed major.
type StaticResolver struct {
	byID map[string][]Entry
}

// NewStaticResolver indexes entries.
func NewStaticResolver(entries ...Entry) (*StaticResolver, error) {
	r := &StaticResolver{byID: map[string][]Entry{}}
	for _, e := range entries {
		if _, err := parseSemver(e.Contract.Version); err != nil {
			return nil, fmt.Errorf("%s: %w", e.Contract.ID, err)
		}
		if e.Digest == "" {
			d, err := Digest(e.Contract)
			if err != nil {
				return nil, err
			}
			e.Digest = d
		}
		r.byID[e.Contract.ID] = append(r.byID[e.Contract.ID], e)
	}
	for id := range r.byID {
		es := r.byID[id]
		sort.Slice(es, func(i, j int) bool { return semverLess(es[j].Contract.Version, es[i].Contract.Version) })
	}
	return r, nil
}

// Resolve picks the newest version of id within major.
func (r *StaticResolver) Resolve(id string, major int) (Resolution, error) {
	for _, e := range r.byID[id] {
		v, _ := parseSemver(e.Contract.Version)
		if v[0] != major || v[3] != 0 { // pre-releases never resolve by major
			continue
		}
		if e.Signer == "" || e.Signer == SignerUnsigned {
			return Resolution{}, fmt.Errorf("%s@%s: %w", id, e.Contract.Version, ErrUnsigned)
		}
		return Resolution{Contract: e.Contract, Resolved: contracts.ResolvedStep{ID: id, Version: e.Contract.Version,
			Digest: e.Digest, Signer: e.Signer}}, nil
	}
	return Resolution{}, fmt.Errorf("%s@%d: %w", id, major, ErrUnresolved)
}

// Chain tries resolvers in order; the first that knows the id answers.
type Chain []Resolver

// Resolve implements Resolver.
func (c Chain) Resolve(id string, major int) (Resolution, error) {
	last := fmt.Errorf("%s@%d: %w", id, major, ErrUnresolved)
	for _, r := range c {
		res, err := r.Resolve(id, major)
		if err == nil || errors.Is(err, ErrUnsigned) {
			return res, err
		}
		last = err
	}
	return Resolution{}, last
}

// BuiltinResolver resolves the platform's own steps (first-party signed).
func BuiltinResolver() (*StaticResolver, error) {
	steps, err := contracts.BuiltinSteps()
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(steps))
	for _, s := range steps {
		entries = append(entries, Entry{Contract: s, Signer: SignerFirstParty})
	}
	return NewStaticResolver(entries...)
}

// parseSemver returns major, minor, patch and 1 if it has a pre-release.
func parseSemver(v string) ([4]int, error) {
	var out [4]int
	core := v
	if i := strings.IndexAny(core, "+"); i >= 0 {
		core = core[:i]
	}
	if i := strings.IndexByte(core, '-'); i >= 0 {
		core, out[3] = core[:i], 1
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return out, fmt.Errorf("bad semver %q", v)
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, fmt.Errorf("bad semver %q", v)
		}
		out[i] = n
	}
	return out, nil
}

func semverLess(a, b string) bool {
	va, _ := parseSemver(a)
	vb, _ := parseSemver(b)
	for i := 0; i < 3; i++ {
		if va[i] != vb[i] {
			return va[i] < vb[i]
		}
	}
	return va[3] > vb[3] // a pre-release sorts before its release
}
