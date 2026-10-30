// Package semanticdiff computes logical dataset diffs (spec §7) without
// reading raw objects: manifest roots first, then chunk hashes, then only the
// entries in changed partitions. Output carries ids and enums only.
package semanticdiff

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"studio.local/versioning/internal/manifests"
)

// Change types.
const (
	SampleAdded         = "sample.added"
	SampleRemoved       = "sample.removed"
	SampleReplaced      = "sample.replaced"
	AnnotationAdded     = "annotation.added"
	AnnotationRemoved   = "annotation.removed"
	AnnotationChanged   = "annotation.changed"
	OntologyClassAdded  = "ontology.class_added"
	OntologyClassRemove = "ontology.class_removed"
	OntologyClassRename = "ontology.class_renamed"
	OntologyRequiredAdd = "ontology.required_field_added"
	GroupingChanged     = "grouping.changed"
)

// Revision fields compared per annotation.
const (
	FieldClass       = "class_id"
	FieldGeometry    = "geometry"
	FieldConfidence  = "confidence"
	FieldStatus      = "status"
	FieldReviewer    = "reviewer_id"
	FieldAttributes  = "attributes"
	FieldFrame       = "coordinate_frame"
	FieldCalibration = "calibration"
	FieldOntologyRev = "ontology_rev"
)

// AllFields lists every comparable revision field in canonical order.
var AllFields = []string{FieldClass, FieldGeometry, FieldConfidence, FieldStatus, FieldReviewer,
	FieldAttributes, FieldFrame, FieldCalibration, FieldOntologyRev}

// GeometryRule is a plugin-declared tolerance (todo4 V13).
type GeometryRule struct {
	Metric    string  `json:"metric"` // iou | max_vertex_delta_px | abs_delta | exact
	Threshold float64 `json:"threshold"`
}

// KindRule declares diff and merge semantics for one annotation kind.
type KindRule struct {
	Kind           string       `json:"kind"`
	CompareFields  []string     `json:"compare_fields,omitempty"`
	ConflictFields []string     `json:"conflict_fields,omitempty"`
	Geometry       GeometryRule `json:"geometry"`
}

// Rules maps kinds to their rule.
type Rules struct{ byKind map[string]KindRule }

// DefaultRules returns the built-in rules used when no plugin overrides them.
func DefaultRules() *Rules {
	r := &Rules{byKind: map[string]KindRule{}}
	for _, k := range []KindRule{
		{Kind: manifests.KindBox2D, Geometry: GeometryRule{"iou", 0.98}},
		{Kind: manifests.KindPolygon2D, Geometry: GeometryRule{"max_vertex_delta_px", 0.5}},
		{Kind: manifests.KindMask2D, Geometry: GeometryRule{"iou", 0.98}},
		{Kind: manifests.KindRegion3D, Geometry: GeometryRule{"iou", 0.98}},
		{Kind: manifests.KindTimespan, Geometry: GeometryRule{"abs_delta", 0.01}},
		{Kind: manifests.KindMeasurement, Geometry: GeometryRule{"max_vertex_delta_px", 0.5}},
		{Kind: manifests.KindTextspan, Geometry: GeometryRule{"exact", 0}},
	} {
		r.set(k)
	}
	return r
}

func (r *Rules) set(k KindRule) {
	if len(k.CompareFields) == 0 {
		k.CompareFields = AllFields
	}
	if len(k.ConflictFields) == 0 {
		k.ConflictFields = k.CompareFields
	}
	r.byKind[k.Kind] = k
}

// For returns the rule for kind (defaults for unknown kinds).
func (r *Rules) For(kind string) KindRule {
	if k, ok := r.byKind[kind]; ok {
		return k
	}
	return KindRule{Kind: kind, CompareFields: AllFields, ConflictFields: AllFields, Geometry: GeometryRule{"exact", 0}}
}

// PluginRulesFile is the shape of a plugin's annotations.diff declaration,
// extracted from plugin.yaml by the build (schemas/versioning/
// annotation-diff-rules.schema.json).
type PluginRulesFile struct {
	Plugin string     `json:"plugin"`
	Rules  []KindRule `json:"rules"`
}

var validMetrics = map[string]bool{"iou": true, "max_vertex_delta_px": true, "abs_delta": true, "exact": true}

// ValidateRule checks a declared rule against the contract.
func ValidateRule(k KindRule) error {
	known := false
	for _, x := range manifests.Kinds {
		if x == k.Kind {
			known = true
		}
	}
	if !known {
		return fmt.Errorf("unknown kind %q", k.Kind)
	}
	if !validMetrics[k.Geometry.Metric] {
		return fmt.Errorf("kind %s: unknown metric %q", k.Kind, k.Geometry.Metric)
	}
	if k.Geometry.Metric == "iou" && (k.Geometry.Threshold <= 0 || k.Geometry.Threshold > 1) {
		return fmt.Errorf("kind %s: iou threshold must be in (0,1]", k.Kind)
	}
	if k.Geometry.Threshold < 0 {
		return fmt.Errorf("kind %s: negative threshold", k.Kind)
	}
	fields := map[string]bool{}
	for _, f := range AllFields {
		fields[f] = true
	}
	for _, f := range append(append([]string{}, k.CompareFields...), k.ConflictFields...) {
		if !fields[f] {
			return fmt.Errorf("kind %s: unknown field %q", k.Kind, f)
		}
	}
	return nil
}

// LoadRules reads every *.json rules file in dir over the defaults. Files are
// applied in name order; a later plugin overriding a kind wins.
func LoadRules(dir string) (*Rules, error) {
	r := DefaultRules()
	if dir == "" {
		return r, nil
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	for _, f := range files {
		b, err := os.ReadFile(f) // #nosec G304 -- operator-provided rules dir
		if err != nil {
			return nil, err
		}
		var pf PluginRulesFile
		if err := json.Unmarshal(b, &pf); err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(f), err)
		}
		for _, k := range pf.Rules {
			if err := ValidateRule(k); err != nil {
				return nil, fmt.Errorf("%s: %w", filepath.Base(f), err)
			}
			r.set(k)
		}
	}
	return r, nil
}
