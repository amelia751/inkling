// Package merge implements the three-way semantic dataset merge (spec §8).
// go-git only fast-forwards, so the merge of manifests is computed here and
// the two-parent commit is written by gitengine.
package merge

import (
	"context"
	"fmt"
	"reflect"
	"sort"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/semanticdiff"
)

// Situation names a row of the spec §8 table.
type Situation string

// Spec §8 rows, verbatim.
const (
	IndependentAdditions        Situation = "Independent additions at different sample IDs"
	DistinctAnnotationsOneImage Situation = "Distinct annotations on one image"
	SameAnnotationDiffLabels    Situation = "Same annotation changed to different labels"
	DeletedSampleVsUpdatedAnn   Situation = "Deleted sample vs updated annotation"
	OntologyRenameVsAnnEdits    Situation = "Ontology rename/mapping vs annotation edits"
	TwoRevisionsSameRawSample   Situation = "Two revisions of same raw sample"
	IdenticalChanges            Situation = "Identical changes on both sides"
)

// Behavior is the default behavior column of the table.
type Behavior string

// Spec §8 behaviors, verbatim.
const (
	AutoMerge             Behavior = "Auto-merge"
	MergeIfAllowed        Behavior = "Merge if IDs/geometry constraints allow"
	Conflict              Behavior = "Conflict"
	RevalidateMaybeConfl  Behavior = "Revalidation + possible conflict"
	ConflictOrReplacement Behavior = "Conflict or explicit versioned replacement"
	Deduplicate           Behavior = "Deduplicate"
)

// Rule is one row of the table.
type Rule struct {
	Situation Situation
	Behavior  Behavior
}

// Table is spec §8 as data; the merge consults it for every decision and
// merge_test.go has one test per row.
var Table = []Rule{
	{IndependentAdditions, AutoMerge},
	{DistinctAnnotationsOneImage, MergeIfAllowed},
	{SameAnnotationDiffLabels, Conflict},
	{DeletedSampleVsUpdatedAnn, Conflict},
	{OntologyRenameVsAnnEdits, RevalidateMaybeConfl},
	{TwoRevisionsSameRawSample, ConflictOrReplacement},
	{IdenticalChanges, Deduplicate},
}

// BehaviorFor looks a situation up in the table.
func BehaviorFor(s Situation) Behavior {
	for _, r := range Table {
		if r.Situation == s {
			return r.Behavior
		}
	}
	panic("merge: situation not in spec table: " + string(s))
}

// ConflictRecord is a first-class conflict with a stable key:
// sample:<id>, annotation:<id>:<field> or ontology:<class_id>.
type ConflictRecord struct {
	Key          string    `json:"conflict_key"`
	Situation    Situation `json:"kind"`
	SampleID     string    `json:"sample_id,omitempty"`
	AnnotationID string    `json:"annotation_id,omitempty"`
	Field        string    `json:"field,omitempty"`
	BaseRef      string    `json:"base_ref,omitempty"`
	OursRef      string    `json:"ours_ref,omitempty"`
	TheirsRef    string    `json:"theirs_ref,omitempty"`

	ours, theirs, base any // candidate values for resolution
}

// Decision records how a non-conflicting entry was merged (for audit/tests).
type Decision struct {
	Key       string
	Situation Situation
	Behavior  Behavior
}

// Outcome is the merged (partial) manifest plus conflicts.
type Outcome struct {
	Merged       *manifests.Manifest
	Ontology     manifests.Ontology
	Conflicts    []ConflictRecord
	Decisions    []Decision
	NewRevisions map[string]*manifests.AnnotationRevision // field-merged revisions to persist
}

// Input are the three sides. Manifests may be partial (same buckets on every
// side); ontologies are always whole.
type Input struct {
	Base, Ours, Theirs *manifests.Manifest
	Revisions          semanticdiff.RevisionLoader
	Rules              *semanticdiff.Rules
}

type merger struct {
	in  Input
	out *Outcome
	ctx context.Context
}

// ThreeWay merges theirs (the review source) into ours (the target).
func ThreeWay(ctx context.Context, in Input) (*Outcome, error) {
	if in.Rules == nil {
		in.Rules = semanticdiff.DefaultRules()
	}
	m := &merger{in: in, ctx: ctx, out: &Outcome{NewRevisions: map[string]*manifests.AnnotationRevision{}}}
	m.out.Ontology = m.mergeOntology()
	samples, deleted := m.mergeSamples()
	anns, err := m.mergeAnnotations(samples, deleted)
	if err != nil {
		return nil, err
	}
	if err := m.revalidate(anns); err != nil {
		return nil, err
	}
	merged := &manifests.Manifest{SchemaVersion: manifests.SchemaVersion, Ontology: m.out.Ontology,
		Samples: make([]manifests.Sample, 0, len(samples)), Annotations: make([]manifests.Annotation, 0, len(anns))}
	for _, s := range samples {
		merged.Samples = append(merged.Samples, *s)
	}
	for _, a := range anns {
		merged.Annotations = append(merged.Annotations, *a)
	}
	merged.Sort()
	m.out.Merged = merged
	sort.Slice(m.out.Conflicts, func(i, j int) bool { return m.out.Conflicts[i].Key < m.out.Conflicts[j].Key })
	return m.out, nil
}

func (m *merger) decide(key string, s Situation) Behavior {
	b := BehaviorFor(s)
	m.out.Decisions = append(m.out.Decisions, Decision{key, s, b})
	return b
}

func (m *merger) conflict(c ConflictRecord) {
	m.decide(c.Key, c.Situation)
	m.out.Conflicts = append(m.out.Conflicts, c)
}

// ---- samples ----

func sampleMap(mf *manifests.Manifest) map[string]*manifests.Sample {
	out := map[string]*manifests.Sample{}
	if mf == nil {
		return out
	}
	for i := range mf.Samples {
		out[mf.Samples[i].SampleID] = &mf.Samples[i]
	}
	return out
}

func sampleEq(a, b *manifests.Sample) bool {
	if a == nil || b == nil {
		return a == b
	}
	return semanticdiff.SampleEqual(a, b)
}

func sref(s *manifests.Sample) string {
	if s == nil {
		return ""
	}
	return manifests.EntryHash(s)
}

// mergeSamples returns the merged sample set and the ids deleted by one side.
func (m *merger) mergeSamples() (map[string]*manifests.Sample, map[string]bool) {
	b, o, t := sampleMap(m.in.Base), sampleMap(m.in.Ours), sampleMap(m.in.Theirs)
	out := map[string]*manifests.Sample{}
	deleted := map[string]bool{}
	for _, id := range unionKeys(b, o, t) {
		bs, os, ts := b[id], o[id], t[id]
		key := "sample:" + id
		oChanged, tChanged := !sampleEq(bs, os), !sampleEq(bs, ts)
		switch {
		case !oChanged && !tChanged:
			if bs != nil {
				out[id] = bs
			}
		case oChanged && !tChanged, !oChanged && tChanged:
			pick := os
			if tChanged {
				pick = ts
			}
			if bs == nil {
				m.decide(key, IndependentAdditions)
			}
			if pick != nil {
				out[id] = pick
			} else {
				deleted[id] = true
			}
		case sampleEq(os, ts): // both changed identically (incl. both deleted)
			m.decide(key, IdenticalChanges)
			if os != nil {
				out[id] = os
			} else {
				deleted[id] = true
			}
		case os == nil || ts == nil: // one deleted, the other replaced
			m.conflict(ConflictRecord{Key: key, Situation: TwoRevisionsSameRawSample, SampleID: id,
				BaseRef: sref(bs), OursRef: sref(os), TheirsRef: sref(ts), ours: os, theirs: ts, base: bs})
			if os != nil {
				out[id] = os // provisional: ours until resolved
			}
		default:
			m.conflict(ConflictRecord{Key: key, Situation: TwoRevisionsSameRawSample, SampleID: id,
				BaseRef: sref(bs), OursRef: sref(os), TheirsRef: sref(ts), ours: os, theirs: ts, base: bs})
			out[id] = os
		}
	}
	return out, deleted
}

// ---- annotations ----

func annMap(mf *manifests.Manifest) map[string]*manifests.Annotation {
	out := map[string]*manifests.Annotation{}
	if mf == nil {
		return out
	}
	for i := range mf.Annotations {
		out[mf.Annotations[i].AnnotationID] = &mf.Annotations[i]
	}
	return out
}

func aref(a *manifests.Annotation) string {
	if a == nil {
		return ""
	}
	return a.Ref
}

func annEq(a, b *manifests.Annotation) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func (m *merger) mergeAnnotations(samples map[string]*manifests.Sample, deletedSamples map[string]bool) (map[string]*manifests.Annotation, error) {
	b, o, t := annMap(m.in.Base), annMap(m.in.Ours), annMap(m.in.Theirs)
	out := map[string]*manifests.Annotation{}
	addedBy := map[string][]*manifests.Annotation{"ours": nil, "theirs": nil}
	for _, id := range unionKeys(b, o, t) {
		ba, oa, ta := b[id], o[id], t[id]
		oChanged, tChanged := !annEq(ba, oa), !annEq(ba, ta)
		var pick *manifests.Annotation
		switch {
		case !oChanged && !tChanged:
			pick = ba
		case oChanged && !tChanged:
			pick = oa
			if ba == nil {
				addedBy["ours"] = append(addedBy["ours"], oa)
			}
		case !oChanged && tChanged:
			pick = ta
			if ba == nil {
				addedBy["theirs"] = append(addedBy["theirs"], ta)
			}
		case annEq(oa, ta) || (oa != nil && ta != nil && oa.Ref == ta.Ref):
			m.decide("annotation:"+id, IdenticalChanges)
			pick = oa
		case oa == nil || ta == nil:
			sid := firstNonNil(oa, ta, ba).SampleID
			field := "deleted"
			if _, ok := samples[sid]; !ok && deletedSamples[sid] {
				field = "sample_deleted" // the deleting side removed the whole sample
			}
			m.conflict(ConflictRecord{Key: "annotation:" + id + ":" + field, Situation: DeletedSampleVsUpdatedAnn,
				AnnotationID: id, SampleID: sid, Field: field,
				BaseRef: aref(ba), OursRef: aref(oa), TheirsRef: aref(ta), ours: oa, theirs: ta, base: ba})
			pick = oa
		default:
			merged, err := m.mergeAnnotationFields(ba, oa, ta)
			if err != nil {
				return nil, err
			}
			pick = merged
		}
		if pick == nil {
			continue
		}
		// The annotation survives but one side deleted its sample.
		if _, ok := samples[pick.SampleID]; !ok && deletedSamples[pick.SampleID] && !conflicted(m.out, id) {
			if annEq(pick, ba) {
				continue // unchanged annotation: cascades with its sample
			}
			m.conflict(ConflictRecord{Key: "annotation:" + id + ":sample_deleted", Situation: DeletedSampleVsUpdatedAnn,
				AnnotationID: id, SampleID: pick.SampleID, Field: "sample_deleted",
				BaseRef: aref(ba), OursRef: aref(oa), TheirsRef: aref(ta), ours: oa, theirs: ta, base: ba})
			continue
		}
		out[id] = pick
	}
	if err := m.checkDistinctAdditions(addedBy["ours"], addedBy["theirs"]); err != nil {
		return nil, err
	}
	return out, nil
}

func conflicted(o *Outcome, annID string) bool {
	for _, c := range o.Conflicts {
		if c.AnnotationID == annID {
			return true
		}
	}
	return false
}

func firstNonNil(as ...*manifests.Annotation) *manifests.Annotation {
	for _, a := range as {
		if a != nil {
			return a
		}
	}
	return &manifests.Annotation{}
}

// checkDistinctAdditions applies "merge if IDs/geometry constraints allow":
// distinct ids on one image merge, unless both sides added the same class
// with equal geometry (the same object annotated twice).
func (m *merger) checkDistinctAdditions(ours, theirs []*manifests.Annotation) error {
	bySample := map[string][]*manifests.Annotation{}
	for _, a := range ours {
		bySample[a.SampleID] = append(bySample[a.SampleID], a)
	}
	for _, ta := range theirs {
		others := bySample[ta.SampleID]
		key := "annotation:" + ta.AnnotationID
		if len(others) == 0 {
			continue
		}
		m.decide(key, DistinctAnnotationsOneImage)
		if m.in.Revisions == nil {
			continue
		}
		tr, err := m.in.Revisions.LoadRevision(m.ctx, ta.Ref)
		if err != nil {
			return err
		}
		rule := m.in.Rules.For(ta.Kind)
		for _, oa := range others {
			if oa.Kind != ta.Kind || oa.ClassID != ta.ClassID {
				continue
			}
			or, err := m.in.Revisions.LoadRevision(m.ctx, oa.Ref)
			if err != nil {
				return err
			}
			if semanticdiff.GeometryEqual(rule, &or.Geometry, &tr.Geometry) {
				m.out.Conflicts = append(m.out.Conflicts, ConflictRecord{Key: key + ":duplicate_geometry",
					Situation: DistinctAnnotationsOneImage, AnnotationID: ta.AnnotationID, SampleID: ta.SampleID,
					Field: "duplicate_geometry", OursRef: oa.Ref, TheirsRef: ta.Ref, ours: nil, theirs: ta})
			}
		}
	}
	return nil
}

func (m *merger) load(ref string) (*manifests.AnnotationRevision, error) {
	if m.in.Revisions == nil {
		return nil, fmt.Errorf("merge: revision loader required for field-level merge")
	}
	return m.in.Revisions.LoadRevision(m.ctx, ref)
}

// mergeAnnotationFields merges two edits of one annotation field by field.
func (m *merger) mergeAnnotationFields(ba, oa, ta *manifests.Annotation) (*manifests.Annotation, error) {
	or, err := m.load(oa.Ref)
	if err != nil {
		return nil, err
	}
	tr, err := m.load(ta.Ref)
	if err != nil {
		return nil, err
	}
	br := &manifests.AnnotationRevision{}
	if ba != nil {
		if br, err = m.load(ba.Ref); err != nil {
			return nil, err
		}
	}
	rule := m.in.Rules.For(oa.Kind)
	conflictable := map[string]bool{}
	for _, f := range rule.ConflictFields {
		conflictable[f] = true
	}
	merged := *or
	conflicted := false
	for _, f := range rule.CompareFields {
		oc := ba == nil || !semanticdiff.FieldEqual(rule, f, br, or)
		tc := ba == nil || !semanticdiff.FieldEqual(rule, f, br, tr)
		switch {
		case !tc:
			// keep ours
		case !oc:
			semanticdiff.SetField(&merged, tr, f)
		case semanticdiff.FieldEqual(rule, f, or, tr):
			// both changed to the same value
		case conflictable[f]:
			// Divergent edits of one field; for class_id this is exactly the
			// "same annotation changed to different labels" row.
			m.conflict(ConflictRecord{Key: "annotation:" + oa.AnnotationID + ":" + f, Situation: SameAnnotationDiffLabels,
				AnnotationID: oa.AnnotationID, SampleID: oa.SampleID, Field: f,
				BaseRef: aref(ba), OursRef: oa.Ref, TheirsRef: ta.Ref, ours: oa, theirs: ta, base: ba})
			conflicted = true
		default:
			semanticdiff.SetField(&merged, tr, f) // non-conflicting field: the reviewed source wins
		}
	}
	if conflicted {
		return oa, nil // provisional until resolved
	}
	m.decide("annotation:"+oa.AnnotationID, DistinctAnnotationsOneImage)
	return m.materialise(oa, &merged, or, tr, ta)
}

// materialise returns the manifest entry for a merged revision, reusing an
// existing ref when the merge equals one side.
func (m *merger) materialise(oa *manifests.Annotation, merged, or, tr *manifests.AnnotationRevision, ta *manifests.Annotation) (*manifests.Annotation, error) {
	if reflect.DeepEqual(merged, or) {
		return oa, nil
	}
	if reflect.DeepEqual(merged, tr) {
		return ta, nil
	}
	merged.Provenance = manifests.Provenance{ActorID: "merge", Tool: "versioning.merge", ParentRevision: oa.Ref}
	_, ref, err := manifests.EncodeRevision(merged)
	if err != nil {
		return nil, err
	}
	m.out.NewRevisions[ref] = merged
	e := *oa
	e.Ref = ref
	e.RevisionID = "m" + manifests.RefHex(ref)[:25]
	e.ClassID = merged.ClassID
	e.OntologyRev = merged.OntologyRev
	return &e, nil
}

// ---- ontology ----

func classMap(o manifests.Ontology) map[string]*manifests.OntologyClass {
	out := map[string]*manifests.OntologyClass{}
	for i := range o.Classes {
		out[o.Classes[i].ClassID] = &o.Classes[i]
	}
	return out
}

func classEq(a, b *manifests.OntologyClass) bool {
	if a == nil || b == nil {
		return a == b
	}
	return reflect.DeepEqual(*a, *b)
}

func (m *merger) mergeOntology() manifests.Ontology {
	var bo, oo, to manifests.Ontology
	if m.in.Base != nil {
		bo = m.in.Base.Ontology
	}
	if m.in.Ours != nil {
		oo = m.in.Ours.Ontology
	}
	if m.in.Theirs != nil {
		to = m.in.Theirs.Ontology
	}
	if reflect.DeepEqual(oo, to) {
		return oo
	}
	b, o, t := classMap(bo), classMap(oo), classMap(to)
	var classes []manifests.OntologyClass
	for _, id := range unionKeys(b, o, t) {
		bc, oc, tc := b[id], o[id], t[id]
		ochg, tchg := !classEq(bc, oc), !classEq(bc, tc)
		var pick *manifests.OntologyClass
		switch {
		case !ochg && !tchg:
			pick = bc
		case ochg && !tchg:
			pick = oc
		case !ochg && tchg:
			pick = tc
		case classEq(oc, tc):
			m.decide("ontology:"+id, IdenticalChanges)
			pick = oc
		default:
			m.conflict(ConflictRecord{Key: "ontology:" + id, Situation: OntologyRenameVsAnnEdits,
				Field: "class", BaseRef: classRef(bc), OursRef: classRef(oc), TheirsRef: classRef(tc),
				ours: oc, theirs: tc, base: bc})
			pick = oc
		}
		if pick != nil {
			classes = append(classes, *pick)
		}
	}
	out := manifests.Ontology{Classes: classes}
	sort.Slice(out.Classes, func(i, j int) bool { return out.Classes[i].ClassID < out.Classes[j].ClassID })
	switch {
	case reflect.DeepEqual(out.Classes, oo.Classes):
		out.RevisionID = oo.RevisionID
	case reflect.DeepEqual(out.Classes, to.Classes):
		out.RevisionID = to.RevisionID
	default:
		out.RevisionID = "merged-" + manifests.EntryHash(out.Classes)[:24]
	}
	return out
}

func classRef(c *manifests.OntologyClass) string {
	if c == nil {
		return ""
	}
	return "sha256:" + manifests.EntryHash(c)
}

// revalidate checks annotation edits against the merged ontology: an edit
// whose class was removed, or which lacks a newly required field, conflicts.
func (m *merger) revalidate(anns map[string]*manifests.Annotation) error {
	classes := classMap(m.out.Ontology)
	if len(classes) == 0 {
		return nil
	}
	b := annMap(m.in.Base)
	for _, id := range sortedKeys(anns) {
		a := anns[id]
		if annEq(a, b[id]) {
			continue // untouched annotations are revalidated by checks, not merge
		}
		c := classes[a.ClassID]
		key := "annotation:" + id + ":class_id"
		if c == nil {
			m.conflict(ConflictRecord{Key: key, Situation: OntologyRenameVsAnnEdits, AnnotationID: id,
				SampleID: a.SampleID, Field: semanticdiff.FieldClass, OursRef: a.Ref, theirs: a, ours: a})
			delete(anns, id)
			continue
		}
		if len(c.RequiredFields) == 0 || m.in.Revisions == nil {
			m.decide("annotation:"+id+":revalidated", OntologyRenameVsAnnEdits)
			continue
		}
		rev, err := m.in.Revisions.LoadRevision(m.ctx, a.Ref)
		if err != nil {
			return err
		}
		for _, f := range c.RequiredFields {
			if _, ok := rev.Attributes[f]; !ok {
				m.conflict(ConflictRecord{Key: "annotation:" + id + ":attributes", Situation: OntologyRenameVsAnnEdits,
					AnnotationID: id, SampleID: a.SampleID, Field: semanticdiff.FieldAttributes, OursRef: a.Ref,
					ours: a, theirs: a})
				break
			}
		}
	}
	return nil
}

func unionKeys[V any](ms ...map[string]V) []string {
	set := map[string]bool{}
	for _, m := range ms {
		for k := range m {
			set[k] = true
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedKeys[V any](m map[string]V) []string { return unionKeys(m) }
