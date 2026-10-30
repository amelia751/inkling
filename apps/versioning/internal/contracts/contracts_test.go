package contracts_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/semanticdiff"
	"studio.local/versioning/internal/service"
	tu "studio.local/versioning/internal/testutil"
)

const dir = "../../../../schemas/versioning"

func compile(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	abs, _ := filepath.Abs(filepath.Join(dir, name))
	s, err := c.Compile(abs)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return s
}

func validate(t *testing.T, schema string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytesReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if err := compile(t, schema).Validate(inst); err != nil {
		t.Fatalf("%s rejects a Go-produced document: %v\n%s", schema, err, b)
	}
}

func fixtures() (*tu.Revisions, *manifests.Manifest, *manifests.Manifest) {
	revs := tu.NewRevisions()
	s1, s2 := tu.Sample("s1"), tu.Sample("s2")
	s2.Group = &manifests.Grouping{StudyUIDHash: tu.SHA("study"), SeriesUIDHash: tu.SHA("series"), Sequence: 2}
	s2.Split = "test"
	base := tu.Manifest([]manifests.Sample{s1, s2}, tu.Ann(revs, tu.Box("a1", "s1", "cat", 1, 1, 5, 5)))
	head := tu.Manifest([]manifests.Sample{s1, tu.Sample("s3")}, tu.Ann(revs, tu.Box("a1", "s1", "dog", 1, 1, 5, 5)))
	head.Ontology.Classes[0].RequiredFields = []string{"occluded"}
	return revs, base, head
}

func TestManifestMatchesSchema(t *testing.T) {
	_, base, head := fixtures()
	validate(t, "dataset-manifest.schema.json", base)
	validate(t, "dataset-manifest.schema.json", head)
}

func TestRevisionMatchesSchema(t *testing.T) {
	conf := 0.7
	start, end := 1.0, 2.5
	for _, r := range []*manifests.AnnotationRevision{
		tu.Box("a", "s", "cat", 0, 0, 1, 1),
		{SchemaVersion: "1", AnnotationID: "m", SampleID: "s", Kind: "mask2d", ClassID: "c", OntologyRev: "o", CoordinateFrame: "pixel",
			Status: "accepted", Confidence: &conf, Geometry: manifests.Geometry{Mask: &manifests.RLE{Size: [2]int{2, 2}, Counts: []int{1, 3}}},
			Calibration: &manifests.Calibration{PixelSpacing: []float64{0.5, 0.5}}, Attributes: map[string]string{"occluded": "no"},
			Provenance: manifests.Provenance{ActorID: "u", Tool: "brush"}},
		{SchemaVersion: "1", AnnotationID: "t", SampleID: "s", Kind: "timespan", ClassID: "c", OntologyRev: "o", CoordinateFrame: "seconds",
			Status: "draft", Geometry: manifests.Geometry{Start: &start, End: &end}, Provenance: manifests.Provenance{ActorID: "u"}},
	} {
		if err := manifests.ValidateRevision(r); err != nil {
			t.Fatal(err)
		}
		validate(t, "annotation-revision.schema.json", r)
	}
}

func TestDiffMatchesSchema(t *testing.T) {
	revs, base, head := fixtures()
	d := &semanticdiff.Differ{Revisions: revs, Rules: semanticdiff.DefaultRules()}
	res, err := d.DiffManifests(context.Background(), base, head)
	if err != nil {
		t.Fatal(err)
	}
	res.BaseRoot, res.HeadRoot = "sha256:"+tu.SHA("b"), "sha256:"+tu.SHA("h")
	res.Changes = append(semanticdiff.DiffOntology(base.Ontology, head.Ontology), res.Changes...)
	res.Summary = map[string]int{"x": 1}
	validate(t, "semantic-diff.schema.json", res)
}

func TestEventMatchesSchema(t *testing.T) {
	ev := service.Event{EventID: "01a18aa9-cc7a-2b99-1c0c-e9f48d60a6cd", EventType: service.EvReviewMerged, Version: 1,
		TenantID: "01a18aa9-cc7a-2b99-1c0c-e9f48d60a6cd", RepoID: "r", EntityID: "e", ActorID: "a", OccurredAt: time.Now().UTC(),
		Data: map[string]string{"merge_oid": tu.SHA("m")[:40]}}
	validate(t, "events.schema.json", ev)
}

func TestDiffRulesMatchSchema(t *testing.T) {
	f := semanticdiff.PluginRulesFile{Plugin: "segmentation", Rules: []semanticdiff.KindRule{
		{Kind: "mask2d", Geometry: semanticdiff.GeometryRule{Metric: "iou", Threshold: 0.95}, ConflictFields: []string{"class_id", "geometry"}}}}
	validate(t, "annotation-diff-rules.schema.json", f)
}

// The OpenAPI components that mirror the JSON Schemas must list the same
// properties, so the Python client and the Go types cannot drift apart.
func TestOpenAPIMirrorsJSONSchemas(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(dir, "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]any `yaml:"properties"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	props := func(schemaFile string, path ...string) []string {
		b, _ := os.ReadFile(filepath.Join(dir, schemaFile))
		var v map[string]any
		_ = json.Unmarshal(b, &v)
		for _, p := range path {
			v = v[p].(map[string]any)
		}
		var out []string
		for k := range v["properties"].(map[string]any) {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	keys := func(name string) []string {
		var out []string
		for k := range spec.Components.Schemas[name].Properties {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	pairs := []struct {
		component string
		got       []string
	}{
		{"Manifest", props("dataset-manifest.schema.json")},
		{"Sample", props("dataset-manifest.schema.json", "$defs", "sample")},
		{"ManifestAnnotation", props("dataset-manifest.schema.json", "$defs", "annotation")},
		{"AnnotationRevision", props("annotation-revision.schema.json")},
		{"Repository", props("dataset-repository.schema.json")},
		{"Commit", props("dataset-commit.schema.json")},
		{"Review", props("review-request.schema.json")},
		{"DiffChange", props("semantic-diff.schema.json", "$defs", "change")},
	}
	for _, p := range pairs {
		if a, b := keys(p.component), p.got; !equal(a, b) {
			t.Errorf("%s: openapi %v != json schema %v", p.component, a, b)
		}
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
