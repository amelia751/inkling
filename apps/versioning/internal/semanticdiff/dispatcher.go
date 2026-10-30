package semanticdiff

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"studio.local/versioning/internal/manifests"
)

// Change is one logical change record. Refs are content hashes, never text.
type Change struct {
	Type         string   `json:"type"`
	SampleID     string   `json:"sample_id,omitempty"`
	AnnotationID string   `json:"annotation_id,omitempty"`
	ClassID      string   `json:"class_id,omitempty"`
	Kind         string   `json:"kind,omitempty"`
	Fields       []string `json:"fields,omitempty"`
	BaseRef      string   `json:"base_ref,omitempty"`
	HeadRef      string   `json:"head_ref,omitempty"`
	FromClass    string   `json:"from_class_id,omitempty"`
	ToClass      string   `json:"to_class_id,omitempty"`
}

// Counts summarises one side.
type Counts struct {
	Samples     int `json:"samples"`
	Annotations int `json:"annotations"`
}

// DuplicateGroup is a raw object referenced by several samples in the head.
type DuplicateGroup struct {
	SHA256    string   `json:"sha256"`
	SampleIDs []string `json:"sample_ids"`
}

// Aggregates are computed over changed partitions; balance and split values
// are deltas (head minus base), which is exact because unchanged partitions
// contribute equally to both sides.
type Aggregates struct {
	Base                 Counts           `json:"base"`
	Head                 Counts           `json:"head"`
	ClassBalanceDelta    map[string]int   `json:"class_balance_delta"`
	SplitDelta           map[string]int   `json:"split_delta"`
	SuspiciousDuplicates []DuplicateGroup `json:"suspicious_duplicates"`
}

// Result is a complete diff.
type Result struct {
	BaseRoot       string         `json:"base_root"`
	HeadRoot       string         `json:"head_root"`
	ChangedBuckets int            `json:"changed_buckets"`
	Summary        map[string]int `json:"summary"`
	Aggregates     Aggregates     `json:"aggregates"`
	Changes        []Change       `json:"changes"`
}

// RootLoader is the slice of manifests.Store the differ needs.
type RootLoader interface {
	LoadRoot(ctx context.Context, tenant, repo, rootHash string) (*manifests.Root, error)
	LoadBuckets(ctx context.Context, tenant, repo string, r *manifests.Root, buckets []int) (*manifests.Manifest, error)
}

// Differ computes diffs.
type Differ struct {
	Roots     RootLoader
	Revisions RevisionLoader
	Rules     *Rules
}

// Scope is the minimal slice of two manifests that differ.
type Scope struct {
	BaseRoot, HeadRoot *manifests.Root
	Buckets            []int // nil means "all" (json-v1 involved)
}

// ChangedBuckets compares chunk hashes. For json-v1 roots every bucket is
// potentially changed and nil is returned.
func ChangedBuckets(a, b *manifests.Root) []int {
	if a.Format != manifests.FormatChunked || b.Format != manifests.FormatChunked {
		return nil
	}
	set := map[int]bool{}
	for k, v := range a.Buckets {
		if b.Buckets[k] != v {
			set[k] = true
		}
	}
	for k, v := range b.Buckets {
		if a.Buckets[k] != v {
			set[k] = true
		}
	}
	out := make([]int, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// LoadScope loads both roots and the changed partitions.
func (d *Differ) LoadScope(ctx context.Context, tenant, repo, baseRoot, headRoot string) (*Scope, *manifests.Manifest, *manifests.Manifest, error) {
	br, err := d.Roots.LoadRoot(ctx, tenant, repo, baseRoot)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("base root: %w", err)
	}
	hr, err := d.Roots.LoadRoot(ctx, tenant, repo, headRoot)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("head root: %w", err)
	}
	sc := &Scope{BaseRoot: br, HeadRoot: hr, Buckets: ChangedBuckets(br, hr)}
	if baseRoot == headRoot {
		empty := &manifests.Manifest{Ontology: br.Ontology}
		return sc, empty, empty, nil
	}
	load := func(r *manifests.Root) (*manifests.Manifest, error) {
		if sc.Buckets == nil {
			if r.Full != nil {
				return r.Full, nil
			}
			all := make([]int, 0, len(r.Buckets))
			for b := range r.Buckets {
				all = append(all, b)
			}
			return d.Roots.LoadBuckets(ctx, tenant, repo, r, all)
		}
		return d.Roots.LoadBuckets(ctx, tenant, repo, r, sc.Buckets)
	}
	bm, err := load(br)
	if err != nil {
		return nil, nil, nil, err
	}
	hm, err := load(hr)
	if err != nil {
		return nil, nil, nil, err
	}
	return sc, bm, hm, nil
}

// Estimate returns roughly how many entries a diff will touch, so callers
// can choose between a synchronous answer and a background job.
func Estimate(base, head *manifests.Root) int {
	total := max(base.Samples+base.Annots, head.Samples+head.Annots)
	cb := ChangedBuckets(base, head)
	if cb == nil {
		return total
	}
	return total * len(cb) / manifests.NumBuckets
}

// Diff computes the full diff between two manifest roots.
func (d *Differ) Diff(ctx context.Context, tenant, repo, baseRoot, headRoot string) (*Result, error) {
	sc, bm, hm, err := d.LoadScope(ctx, tenant, repo, baseRoot, headRoot)
	if err != nil {
		return nil, err
	}
	res, err := d.DiffManifests(ctx, bm, hm)
	if err != nil {
		return nil, err
	}
	res.BaseRoot, res.HeadRoot = baseRoot, headRoot
	res.Changes = append(DiffOntology(sc.BaseRoot.Ontology, sc.HeadRoot.Ontology), res.Changes...)
	res.Summary = summarise(res.Changes)
	res.Aggregates.Base = Counts{sc.BaseRoot.Samples, sc.BaseRoot.Annots}
	res.Aggregates.Head = Counts{sc.HeadRoot.Samples, sc.HeadRoot.Annots}
	if sc.Buckets == nil {
		res.ChangedBuckets = -1
	} else {
		res.ChangedBuckets = len(sc.Buckets)
	}
	return res, nil
}

// DiffManifests diffs entries of two (possibly partial) manifests.
func (d *Differ) DiffManifests(ctx context.Context, base, head *manifests.Manifest) (*Result, error) {
	res := &Result{Aggregates: Aggregates{ClassBalanceDelta: map[string]int{}, SplitDelta: map[string]int{},
		SuspiciousDuplicates: []DuplicateGroup{}}, Changes: []Change{}}
	bs := map[string]*manifests.Sample{}
	for i := range base.Samples {
		bs[base.Samples[i].SampleID] = &base.Samples[i]
		res.Aggregates.SplitDelta[base.Samples[i].Split]--
	}
	hs := map[string]*manifests.Sample{}
	for i := range head.Samples {
		hs[head.Samples[i].SampleID] = &head.Samples[i]
		res.Aggregates.SplitDelta[head.Samples[i].Split]++
	}
	for id, h := range hs {
		b, ok := bs[id]
		if !ok {
			res.Changes = append(res.Changes, Change{Type: SampleAdded, SampleID: id, HeadRef: manifests.EntryHash(h)})
			continue
		}
		if SampleEqual(b, h) {
			continue
		}
		content, grouping := SampleFields(b, h)
		if len(content) > 0 {
			res.Changes = append(res.Changes, Change{Type: SampleReplaced, SampleID: id, Fields: content,
				BaseRef: manifests.EntryHash(b), HeadRef: manifests.EntryHash(h)})
		}
		if len(grouping) > 0 {
			res.Changes = append(res.Changes, Change{Type: GroupingChanged, SampleID: id, Fields: grouping})
		}
	}
	for id, b := range bs {
		if _, ok := hs[id]; !ok {
			res.Changes = append(res.Changes, Change{Type: SampleRemoved, SampleID: id, BaseRef: manifests.EntryHash(b)})
		}
	}

	ba := map[string]*manifests.Annotation{}
	for i := range base.Annotations {
		a := &base.Annotations[i]
		ba[a.AnnotationID] = a
		res.Aggregates.ClassBalanceDelta[a.ClassID]--
	}
	ha := map[string]*manifests.Annotation{}
	for i := range head.Annotations {
		a := &head.Annotations[i]
		ha[a.AnnotationID] = a
		res.Aggregates.ClassBalanceDelta[a.ClassID]++
	}
	for id, h := range ha {
		b, ok := ba[id]
		if !ok {
			res.Changes = append(res.Changes, Change{Type: AnnotationAdded, AnnotationID: id, SampleID: h.SampleID,
				Kind: h.Kind, ClassID: h.ClassID, HeadRef: h.Ref})
			continue
		}
		if b.Ref == h.Ref {
			continue
		}
		fields, err := d.annotationFields(ctx, b, h)
		if err != nil {
			return nil, err
		}
		if len(fields) == 0 {
			continue // within tolerance: unchanged geometry and fields
		}
		c := Change{Type: AnnotationChanged, AnnotationID: id, SampleID: h.SampleID, Kind: h.Kind,
			Fields: fields, BaseRef: b.Ref, HeadRef: h.Ref}
		if b.ClassID != h.ClassID {
			c.FromClass, c.ToClass = b.ClassID, h.ClassID
		}
		res.Changes = append(res.Changes, c)
	}
	for id, b := range ba {
		if _, ok := ha[id]; !ok {
			res.Changes = append(res.Changes, Change{Type: AnnotationRemoved, AnnotationID: id, SampleID: b.SampleID,
				Kind: b.Kind, ClassID: b.ClassID, BaseRef: b.Ref})
		}
	}
	prune(res.Aggregates.ClassBalanceDelta)
	prune(res.Aggregates.SplitDelta)
	res.Aggregates.SuspiciousDuplicates = duplicates(head)
	sortChanges(res.Changes)
	return res, nil
}

func (d *Differ) annotationFields(ctx context.Context, b, h *manifests.Annotation) ([]string, error) {
	if d.Revisions == nil {
		return []string{"ref"}, nil
	}
	br, err := d.Revisions.LoadRevision(ctx, b.Ref)
	if err != nil {
		return nil, fmt.Errorf("annotation %s base revision: %w", b.AnnotationID, err)
	}
	hr, err := d.Revisions.LoadRevision(ctx, h.Ref)
	if err != nil {
		return nil, fmt.Errorf("annotation %s head revision: %w", h.AnnotationID, err)
	}
	return ChangedFields(d.Rules, br, hr), nil
}

func prune(m map[string]int) {
	for k, v := range m {
		if v == 0 {
			delete(m, k)
		}
	}
}

func duplicates(m *manifests.Manifest) []DuplicateGroup {
	by := map[string][]string{}
	for _, s := range m.Samples {
		for _, o := range s.Objects {
			by[o.SHA256] = append(by[o.SHA256], s.SampleID)
		}
	}
	out := []DuplicateGroup{}
	for h, ids := range by {
		if len(ids) > 1 {
			sort.Strings(ids)
			out = append(out, DuplicateGroup{SHA256: h, SampleIDs: ids})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SHA256 < out[j].SHA256 })
	return out
}

var typeOrder = map[string]int{
	OntologyClassAdded: 0, OntologyClassRemove: 1, OntologyClassRename: 2, OntologyRequiredAdd: 3,
	SampleAdded: 10, SampleRemoved: 11, SampleReplaced: 12, GroupingChanged: 13,
	AnnotationAdded: 20, AnnotationRemoved: 21, AnnotationChanged: 22,
}

// SortKey is the stable order used for pagination.
func SortKey(c Change) string {
	return fmt.Sprintf("%s\x00%02d\x00%s\x00%s", c.SampleID, typeOrder[c.Type], c.AnnotationID, c.ClassID)
}

func sortChanges(cs []Change) {
	sort.Slice(cs, func(i, j int) bool { return SortKey(cs[i]) < SortKey(cs[j]) })
}

func summarise(cs []Change) map[string]int {
	m := map[string]int{}
	for _, c := range cs {
		m[c.Type]++
	}
	return m
}

// ErrBadCursor is returned for malformed cursors.
var ErrBadCursor = errors.New("invalid cursor")

// Page returns changes[offset:offset+limit] and the next cursor ("" at end).
func Page(r *Result, cursor string, limit int) ([]Change, string, error) {
	off := 0
	if cursor != "" {
		b, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return nil, "", ErrBadCursor
		}
		off, err = strconv.Atoi(string(b))
		if err != nil || off < 0 || off > len(r.Changes) {
			return nil, "", ErrBadCursor
		}
	}
	end := min(off+limit, len(r.Changes))
	next := ""
	if end < len(r.Changes) {
		next = base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(end)))
	}
	return r.Changes[off:end], next, nil
}
