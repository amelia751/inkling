package semanticdiff_test

import (
	"context"
	"testing"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/semanticdiff"
	tu "studio.local/versioning/internal/testutil"
)

func TestDiffManifests(t *testing.T) {
	revs := tu.NewRevisions()
	s1, s2, s3 := tu.Sample("s1"), tu.Sample("s2"), tu.Sample("s3")
	base := tu.Manifest([]manifests.Sample{s1, s2},
		tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10)),
		tu.Ann(revs, tu.Box("a2", "s2", "cat", 0, 0, 10, 10)))
	s2b := s2
	s2b.Split = "test"
	head := tu.Manifest([]manifests.Sample{s1, s2b, s3},
		tu.Ann(revs, tu.Box("a1", "s1", "cat", 0, 0, 10, 10.01)), // within IoU tolerance
		tu.Ann(revs, tu.Box("a2", "s2", "dog", 0, 0, 10, 10)))    // label change
	d := &semanticdiff.Differ{Revisions: revs, Rules: semanticdiff.DefaultRules()}
	res, err := d.DiffManifests(context.Background(), base, head)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	for _, c := range res.Changes {
		got[c.Type]++
		if c.Type == semanticdiff.AnnotationChanged && (c.AnnotationID != "a2" || c.FromClass != "cat" || c.ToClass != "dog") {
			t.Fatalf("unexpected change %+v", c)
		}
	}
	want := map[string]int{semanticdiff.SampleAdded: 1, semanticdiff.GroupingChanged: 1, semanticdiff.AnnotationChanged: 1}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: got %d want %d (all: %v)", k, got[k], v, got)
		}
	}
	if res.Aggregates.ClassBalanceDelta["cat"] != -1 || res.Aggregates.ClassBalanceDelta["dog"] != 1 {
		t.Fatalf("class balance: %v", res.Aggregates.ClassBalanceDelta)
	}
	page, next, err := semanticdiff.Page(res, "", 2)
	if err != nil || len(page) != 2 || next == "" {
		t.Fatalf("paging: %d %q %v", len(page), next, err)
	}
	rest, end, err := semanticdiff.Page(res, next, 2)
	if err != nil || len(rest) != 1 || end != "" {
		t.Fatalf("paging 2: %d %q %v", len(rest), end, err)
	}
}

func TestOntologyDiff(t *testing.T) {
	a := tu.Ontology()
	b := tu.Ontology()
	b.Classes[0].Name = "Feline"
	b.Classes[1].RequiredFields = []string{"breed"}
	b.Classes = append(b.Classes, manifests.OntologyClass{ClassID: "bird", Name: "Bird"})
	cs := semanticdiff.DiffOntology(a, b)
	types := map[string]bool{}
	for _, c := range cs {
		types[c.Type] = true
	}
	for _, w := range []string{semanticdiff.OntologyClassAdded, semanticdiff.OntologyClassRename, semanticdiff.OntologyRequiredAdd} {
		if !types[w] {
			t.Fatalf("missing %s in %+v", w, cs)
		}
	}
}

func TestGeometryTolerances(t *testing.T) {
	r := semanticdiff.DefaultRules()
	m1 := &manifests.Geometry{Mask: &manifests.RLE{Size: [2]int{10, 10}, Counts: []int{10, 50, 40}}}
	m2 := &manifests.Geometry{Mask: &manifests.RLE{Size: [2]int{10, 10}, Counts: []int{10, 49, 41}}}
	if !semanticdiff.GeometryEqual(r.For("mask2d"), m1, m2) {
		t.Fatal("masks with IoU 0.98 should be equal")
	}
	m3 := &manifests.Geometry{Mask: &manifests.RLE{Size: [2]int{10, 10}, Counts: []int{20, 40, 40}}}
	if semanticdiff.GeometryEqual(r.For("mask2d"), m1, m3) {
		t.Fatal("masks with IoU 0.8 should differ")
	}
	s, e := 1.0, 2.0
	s2, e2 := 1.005, 2.0
	if !semanticdiff.GeometryEqual(r.For("timespan"), &manifests.Geometry{Start: &s, End: &e}, &manifests.Geometry{Start: &s2, End: &e2}) {
		t.Fatal("timespan within 10ms should be equal")
	}
	if err := semanticdiff.ValidateRule(semanticdiff.KindRule{Kind: "mask2d", Geometry: semanticdiff.GeometryRule{Metric: "iou", Threshold: 1.5}}); err == nil {
		t.Fatal("iou > 1 must be rejected")
	}
}
