package merge_test

import (
	"context"
	"encoding/json"
	"testing"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/merge"
	tu "studio.local/versioning/internal/testutil"
)

type sides struct{ base, ours, theirs *manifests.Manifest }

func run(t *testing.T, revs *tu.Revisions, s sides) *merge.Outcome {
	t.Helper()
	out, err := merge.ThreeWay(context.Background(), merge.Input{Base: s.base, Ours: s.ours, Theirs: s.theirs, Revisions: revs})
	if err != nil {
		t.Fatal(err)
	}
	if err := manifests.Validate(out.Merged, 0); err != nil && len(out.Conflicts) == 0 {
		t.Fatalf("merged manifest invalid: %v", err)
	}
	return out
}

func hasDecision(out *merge.Outcome, s merge.Situation) bool {
	for _, d := range out.Decisions {
		if d.Situation == s {
			return true
		}
	}
	return false
}

func conflictKeys(out *merge.Outcome) []string { return merge.Keys(out.Conflicts) }

func TestTableIsSpec(t *testing.T) {
	want := map[merge.Situation]merge.Behavior{
		"Independent additions at different sample IDs": "Auto-merge",
		"Distinct annotations on one image":             "Merge if IDs/geometry constraints allow",
		"Same annotation changed to different labels":   "Conflict",
		"Deleted sample vs updated annotation":          "Conflict",
		"Ontology rename/mapping vs annotation edits":   "Revalidation + possible conflict",
		"Two revisions of same raw sample":              "Conflict or explicit versioned replacement",
		"Identical changes on both sides":               "Deduplicate",
	}
	if len(merge.Table) != len(want) {
		t.Fatalf("table has %d rows, spec has %d", len(merge.Table), len(want))
	}
	for _, r := range merge.Table {
		if want[r.Situation] != r.Behavior {
			t.Errorf("row %q: got %q want %q", r.Situation, r.Behavior, want[r.Situation])
		}
	}
}

// Row 1: independent additions at different sample IDs → auto-merge.
func TestRowIndependentAdditions(t *testing.T) {
	revs := tu.NewRevisions()
	base := tu.Manifest([]manifests.Sample{tu.Sample("s0")})
	ours := tu.Manifest([]manifests.Sample{tu.Sample("s0"), tu.Sample("s1")})
	theirs := tu.Manifest([]manifests.Sample{tu.Sample("s0"), tu.Sample("s2")})
	out := run(t, revs, sides{base, ours, theirs})
	if len(out.Conflicts) != 0 || len(out.Merged.Samples) != 3 || !hasDecision(out, merge.IndependentAdditions) {
		t.Fatalf("want 3 samples, no conflicts; got %d samples, %v", len(out.Merged.Samples), conflictKeys(out))
	}
}

// Row 2: distinct annotations on one image → merge if ids/geometry allow.
func TestRowDistinctAnnotationsOneImage(t *testing.T) {
	revs := tu.NewRevisions()
	s := []manifests.Sample{tu.Sample("s1")}
	base := tu.Manifest(s)
	ours := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	theirs := tu.Manifest(s, tu.Ann(revs, tu.Box("a2", "s1", "dog", 50, 50, 10, 10)))
	out := run(t, revs, sides{base, ours, theirs})
	if len(out.Conflicts) != 0 || len(out.Merged.Annotations) != 2 || !hasDecision(out, merge.DistinctAnnotationsOneImage) {
		t.Fatalf("distinct annotations should merge: %v", conflictKeys(out))
	}
	// Geometry constraint: the same object (same class, equal geometry) added twice conflicts.
	theirs2 := tu.Manifest(s, tu.Ann(revs, tu.Box("a3", "s1", "cat", 0, 0, 10, 10.05)))
	out = run(t, revs, sides{base, ours, theirs2})
	if len(out.Conflicts) != 1 || out.Conflicts[0].Key != "annotation:a3:duplicate_geometry" {
		t.Fatalf("duplicate geometry should conflict: %v", conflictKeys(out))
	}
}

// Row 3: same annotation changed to different labels → conflict.
func TestRowSameAnnotationDifferentLabels(t *testing.T) {
	revs := tu.NewRevisions()
	s := []manifests.Sample{tu.Sample("s1")}
	base := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	ours := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "dog", 0, 0, 10, 10)))
	o2 := tu.Box("a1", "s1", "cat", 0, 0, 10, 10)
	o2.ClassID = "bird"
	theirs := tu.Manifest(s, tu.Ann(revs, o2))
	theirs.Ontology.Classes = append(theirs.Ontology.Classes, manifests.OntologyClass{ClassID: "bird", Name: "Bird"})
	ours.Ontology = theirs.Ontology
	base.Ontology = theirs.Ontology
	out := run(t, revs, sides{base, ours, theirs})
	if len(out.Conflicts) != 1 || out.Conflicts[0].Key != "annotation:a1:class_id" ||
		out.Conflicts[0].Situation != merge.SameAnnotationDiffLabels {
		t.Fatalf("want label conflict, got %v", conflictKeys(out))
	}
	// Resolution: choose theirs, then the result is valid and labelled bird.
	final, err := merge.Apply(context.Background(), merge.Input{Base: base, Ours: ours, Theirs: theirs, Revisions: revs},
		out, []merge.Resolution{{Key: "annotation:a1:class_id", Choice: merge.ChooseTheirs}})
	if err != nil {
		t.Fatal(err)
	}
	if final.Annotations[0].ClassID != "bird" || manifests.Validate(final, 0) != nil {
		t.Fatalf("resolution not applied: %+v", final.Annotations[0])
	}
	// Non-conflicting field edits on the same annotation merge field by field.
	g := tu.Box("a1", "s1", "cat", 30, 30, 10, 10)
	conf := 0.9
	c := tu.Box("a1", "s1", "cat", 0, 0, 10, 10)
	c.Confidence = &conf
	out = run(t, revs, sides{base, tu.Manifest(s, tu.Ann(revs, g)), tu.Manifest(s, tu.Ann(revs, c))})
	if len(out.Conflicts) != 0 || len(out.NewRevisions) != 1 {
		t.Fatalf("field-level merge expected, got conflicts %v", conflictKeys(out))
	}
}

// Row 4: deleted sample vs updated annotation → conflict.
func TestRowDeletedSampleVsUpdatedAnnotation(t *testing.T) {
	revs := tu.NewRevisions()
	s := []manifests.Sample{tu.Sample("s1"), tu.Sample("s2")}
	base := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	ours := tu.Manifest([]manifests.Sample{tu.Sample("s2")}) // deleted s1
	theirs := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "dog", 0, 0, 10, 10)))
	out := run(t, revs, sides{base, ours, theirs})
	if len(out.Conflicts) != 1 || out.Conflicts[0].Key != "annotation:a1:sample_deleted" ||
		out.Conflicts[0].Situation != merge.DeletedSampleVsUpdatedAnn {
		t.Fatalf("want delete-vs-edit conflict, got %v", conflictKeys(out))
	}
	final, err := merge.Apply(context.Background(), merge.Input{Base: base, Ours: ours, Theirs: theirs, Revisions: revs},
		out, []merge.Resolution{{Key: "annotation:a1:sample_deleted", Choice: merge.ChooseTheirs}})
	if err != nil {
		t.Fatal(err)
	}
	if len(final.Samples) != 2 || len(final.Annotations) != 1 || manifests.Validate(final, 0) != nil {
		t.Fatalf("choosing theirs should restore the sample: %d samples", len(final.Samples))
	}
	// An untouched annotation simply cascades with the deleted sample.
	out = run(t, revs, sides{base, ours, base})
	if len(out.Conflicts) != 0 || len(out.Merged.Annotations) != 0 {
		t.Fatalf("cascade expected, got %v", conflictKeys(out))
	}
}

// Row 5: ontology rename/mapping vs annotation edits → revalidate.
func TestRowOntologyRenameVsAnnotationEdits(t *testing.T) {
	revs := tu.NewRevisions()
	s := []manifests.Sample{tu.Sample("s1")}
	base := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	ours := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	ours.Ontology.Classes[0].Name = "Feline" // rename keeps class_id
	theirs := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 2, 2, 10, 10)))
	out := run(t, revs, sides{base, ours, theirs})
	if len(out.Conflicts) != 0 || !hasDecision(out, merge.OntologyRenameVsAnnEdits) {
		t.Fatalf("rename vs edit should revalidate cleanly: %v", conflictKeys(out))
	}
	if out.Merged.Ontology.Classes[0].Name != "Feline" {
		t.Fatal("rename lost")
	}
	// Removing the class while the other side edits an annotation of it conflicts.
	ours2 := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	ours2.Ontology.Classes = ours2.Ontology.Classes[1:]
	out = run(t, revs, sides{base, ours2, theirs})
	if len(out.Conflicts) != 1 || out.Conflicts[0].Key != "annotation:a1:class_id" {
		t.Fatalf("removed class vs edit should conflict: %v", conflictKeys(out))
	}
	// A newly required field the edit lacks conflicts too.
	ours3 := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	ours3.Ontology.Classes[0].RequiredFields = []string{"occluded"}
	out = run(t, revs, sides{base, ours3, theirs})
	if len(out.Conflicts) != 1 || out.Conflicts[0].Key != "annotation:a1:attributes" {
		t.Fatalf("required field should conflict: %v", conflictKeys(out))
	}
}

// Row 6: two revisions of the same raw sample → conflict (or explicit replacement).
func TestRowTwoRevisionsSameRawSample(t *testing.T) {
	revs := tu.NewRevisions()
	base := tu.Manifest([]manifests.Sample{tu.Sample("s1")})
	a, b := tu.Sample("s1"), tu.Sample("s1")
	a.Objects[0].SHA256 = tu.SHA("v2")
	b.Objects[0].SHA256 = tu.SHA("v3")
	out := run(t, revs, sides{base, tu.Manifest([]manifests.Sample{a}), tu.Manifest([]manifests.Sample{b})})
	if len(out.Conflicts) != 1 || out.Conflicts[0].Key != "sample:s1" || out.Conflicts[0].Situation != merge.TwoRevisionsSameRawSample {
		t.Fatalf("want sample conflict, got %v", conflictKeys(out))
	}
	custom := tu.Sample("s1")
	custom.Objects[0].SHA256 = tu.SHA("v4")
	raw, _ := json.Marshal(custom)
	final, err := merge.Apply(context.Background(), merge.Input{Revisions: revs}, out,
		[]merge.Resolution{{Key: "sample:s1", Choice: merge.ChooseCustom, Custom: raw}})
	if err != nil {
		t.Fatal(err)
	}
	if final.Samples[0].Objects[0].SHA256 != tu.SHA("v4") {
		t.Fatal("explicit versioned replacement not applied")
	}
}

// Row 7: identical changes on both sides → deduplicate.
func TestRowIdenticalChanges(t *testing.T) {
	revs := tu.NewRevisions()
	s := []manifests.Sample{tu.Sample("s1")}
	base := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)))
	edit := tu.Manifest(s, tu.Ann(revs, tu.Box("a1", "s1", "dog", 0, 0, 10, 10)))
	out := run(t, revs, sides{base, edit, edit})
	if len(out.Conflicts) != 0 || len(out.Merged.Annotations) != 1 || !hasDecision(out, merge.IdenticalChanges) {
		t.Fatalf("identical edits should dedupe: %v", conflictKeys(out))
	}
}

func TestApplyRequiresAllResolutions(t *testing.T) {
	revs := tu.NewRevisions()
	base := tu.Manifest([]manifests.Sample{tu.Sample("s1")})
	a, b := tu.Sample("s1"), tu.Sample("s1")
	a.Split, b.Split = "train", "test"
	out := run(t, revs, sides{base, tu.Manifest([]manifests.Sample{a}), tu.Manifest([]manifests.Sample{b})})
	if _, err := merge.Apply(context.Background(), merge.Input{}, out, nil); err == nil {
		t.Fatal("expected ErrUnresolved")
	}
}
