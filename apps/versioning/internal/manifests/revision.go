package manifests

import (
	"fmt"
	"math"
)

// AnnotationRevision is an immutable annotation-revision document, stored as
// canonical JSON in object storage and referenced from manifests by hash.
// schemas/versioning/annotation-revision.schema.json describes it.
type AnnotationRevision struct {
	SchemaVersion   string            `json:"schema_version"`
	AnnotationID    string            `json:"annotation_id"`
	SampleID        string            `json:"sample_id"`
	Kind            string            `json:"kind"`
	ClassID         string            `json:"class_id"`
	OntologyRev     string            `json:"ontology_rev"`
	Geometry        Geometry          `json:"geometry"`
	CoordinateFrame string            `json:"coordinate_frame"`
	Calibration     *Calibration      `json:"calibration,omitempty"`
	Confidence      *float64          `json:"confidence,omitempty"`
	Status          string            `json:"status"`
	ReviewerID      string            `json:"reviewer_id,omitempty"`
	Attributes      map[string]string `json:"attributes,omitempty"`
	Provenance      Provenance        `json:"provenance"`
}

// Geometry holds the kind-specific coordinates; only the fields for the
// revision's kind are set.
type Geometry struct {
	Box    []float64   `json:"box,omitempty"`    // box2d: x, y, w, h
	Points [][]float64 `json:"points,omitempty"` // polygon2d, measurement
	Mask   *RLE        `json:"mask,omitempty"`   // mask2d
	Box3D  []float64   `json:"box3d,omitempty"`  // region3d: x0, y0, z0, x1, y1, z1
	Start  *float64    `json:"start,omitempty"`  // timespan (s), textspan (offset)
	End    *float64    `json:"end,omitempty"`
	Value  *float64    `json:"value,omitempty"` // measurement
	Unit   string      `json:"unit,omitempty"`
}

// RLE is an uncompressed column-major run-length mask: runs alternate
// background/foreground starting with background.
type RLE struct {
	Size   [2]int `json:"size"` // height, width
	Counts []int  `json:"counts"`
}

// Calibration is versioned with the geometry (spec §3.3).
type Calibration struct {
	PixelSpacing   []float64 `json:"pixel_spacing,omitempty"`
	SliceThickness float64   `json:"slice_thickness,omitempty"`
	Units          string    `json:"units,omitempty"`
}

// Provenance records who produced the revision; ids only.
type Provenance struct {
	ActorID        string `json:"actor_id"`
	Tool           string `json:"tool,omitempty"`
	ParentRevision string `json:"parent_revision,omitempty"`
}

// Revision statuses.
var revisionStatuses = map[string]bool{"draft": true, "submitted": true, "accepted": true, "rejected": true}

// ValidateRevision checks that a revision is well formed for its kind.
func ValidateRevision(r *AnnotationRevision) error {
	var p []string
	add := func(f string, a ...any) { p = append(p, fmt.Sprintf(f, a...)) }
	if r.SchemaVersion != SchemaVersion {
		add("schema_version must be %q", SchemaVersion)
	}
	if !idRE.MatchString(r.AnnotationID) {
		add("annotation_id invalid")
	}
	if !idRE.MatchString(r.SampleID) {
		add("sample_id invalid")
	}
	if !validKind(r.Kind) {
		add("kind invalid")
	}
	if !idRE.MatchString(r.ClassID) {
		add("class_id invalid")
	}
	if !revisionStatuses[r.Status] {
		add("status invalid")
	}
	if r.Confidence != nil && (*r.Confidence < 0 || *r.Confidence > 1) {
		add("confidence out of [0,1]")
	}
	if !tokenRE.MatchString(r.CoordinateFrame) {
		add("coordinate_frame invalid")
	}
	for k, v := range r.Attributes {
		if !tokenRE.MatchString(k) || !tokenRE.MatchString(v) {
			add("attributes must be enum-like tokens")
			break
		}
	}
	if err := geometryShape(r.Kind, &r.Geometry); err != "" {
		add("geometry: %s", err)
	}
	if len(p) > 0 {
		return &ValidationError{Problems: p}
	}
	return nil
}

func finite(xs ...float64) bool {
	for _, x := range xs {
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return false
		}
	}
	return true
}

func geometryShape(kind string, g *Geometry) string {
	switch kind {
	case KindBox2D:
		if len(g.Box) != 4 || !finite(g.Box...) {
			return "box2d needs box [x, y, w, h]"
		}
	case KindPolygon2D:
		if len(g.Points) < 3 {
			return "polygon2d needs at least 3 points"
		}
		for _, pt := range g.Points {
			if len(pt) != 2 || !finite(pt...) {
				return "polygon2d points are [x, y]"
			}
		}
	case KindMask2D:
		if g.Mask == nil || g.Mask.Size[0] <= 0 || g.Mask.Size[1] <= 0 {
			return "mask2d needs mask.size"
		}
		total := 0
		for _, c := range g.Mask.Counts {
			if c < 0 {
				return "mask2d counts must be non-negative"
			}
			total += c
		}
		if total != g.Mask.Size[0]*g.Mask.Size[1] {
			return "mask2d counts must sum to height*width"
		}
	case KindRegion3D:
		if len(g.Box3D) != 6 || !finite(g.Box3D...) {
			return "region3d needs box3d [x0, y0, z0, x1, y1, z1]"
		}
	case KindTimespan, KindTextspan:
		if g.Start == nil || g.End == nil || !finite(*g.Start, *g.End) {
			return kind + " needs start and end"
		}
	case KindMeasurement:
		if len(g.Points) < 1 || g.Value == nil {
			return "measurement needs points and value"
		}
	}
	return ""
}
