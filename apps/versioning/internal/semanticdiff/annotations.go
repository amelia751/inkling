package semanticdiff

import (
	"context"
	"math"
	"reflect"

	"studio.local/versioning/internal/manifests"
)

// RevisionLoader fetches immutable annotation-revision documents by ref.
type RevisionLoader interface {
	LoadRevision(ctx context.Context, ref string) (*manifests.AnnotationRevision, error)
}

// GeometryEqual applies the kind's tolerance: true means "unchanged geometry".
func GeometryEqual(rule KindRule, a, b *manifests.Geometry) bool {
	if reflect.DeepEqual(a, b) {
		return true
	}
	t := rule.Geometry.Threshold
	switch rule.Geometry.Metric {
	case "iou":
		var iou float64
		switch {
		case len(a.Box) == 4 && len(b.Box) == 4:
			iou = boxIoU(a.Box, b.Box)
		case len(a.Box3D) == 6 && len(b.Box3D) == 6:
			iou = box3DIoU(a.Box3D, b.Box3D)
		case a.Mask != nil && b.Mask != nil:
			iou = maskIoU(a.Mask, b.Mask)
		default:
			return false
		}
		return iou >= t
	case "max_vertex_delta_px":
		if len(a.Points) != len(b.Points) || !floatPtrClose(a.Value, b.Value, 1e-9) || a.Unit != b.Unit {
			return false
		}
		for i := range a.Points {
			if len(a.Points[i]) != len(b.Points[i]) {
				return false
			}
			var d2 float64
			for k := range a.Points[i] {
				d := a.Points[i][k] - b.Points[i][k]
				d2 += d * d
			}
			if math.Sqrt(d2) > t {
				return false
			}
		}
		return true
	case "abs_delta":
		if a.Start == nil || b.Start == nil || a.End == nil || b.End == nil {
			return false
		}
		return math.Abs(*a.Start-*b.Start) <= t && math.Abs(*a.End-*b.End) <= t
	default:
		return false
	}
}

func floatPtrClose(a, b *float64, eps float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return math.Abs(*a-*b) <= eps
}

func boxIoU(a, b []float64) float64 {
	ix := math.Max(0, math.Min(a[0]+a[2], b[0]+b[2])-math.Max(a[0], b[0]))
	iy := math.Max(0, math.Min(a[1]+a[3], b[1]+b[3])-math.Max(a[1], b[1]))
	inter := ix * iy
	union := a[2]*a[3] + b[2]*b[3] - inter
	if union <= 0 {
		return 0
	}
	return inter / union
}

func box3DIoU(a, b []float64) float64 {
	inter, va, vb := 1.0, 1.0, 1.0
	for k := 0; k < 3; k++ {
		inter *= math.Max(0, math.Min(a[k+3], b[k+3])-math.Max(a[k], b[k]))
		va *= math.Max(0, a[k+3]-a[k])
		vb *= math.Max(0, b[k+3]-b[k])
	}
	union := va + vb - inter
	if union <= 0 {
		return 0
	}
	return inter / union
}

// rleRuns converts RLE counts into foreground [start, end) intervals.
func rleRuns(m *manifests.RLE) [][2]int {
	var out [][2]int
	pos := 0
	for i, c := range m.Counts {
		if i%2 == 1 && c > 0 {
			out = append(out, [2]int{pos, pos + c})
		}
		pos += c
	}
	return out
}

func maskIoU(a, b *manifests.RLE) float64 {
	if a.Size != b.Size {
		return 0
	}
	ra, rb := rleRuns(a), rleRuns(b)
	var inter, sa, sb int
	for _, r := range ra {
		sa += r[1] - r[0]
	}
	for _, r := range rb {
		sb += r[1] - r[0]
	}
	i, j := 0, 0
	for i < len(ra) && j < len(rb) {
		lo, hi := max(ra[i][0], rb[j][0]), min(ra[i][1], rb[j][1])
		if hi > lo {
			inter += hi - lo
		}
		if ra[i][1] < rb[j][1] {
			i++
		} else {
			j++
		}
	}
	union := sa + sb - inter
	if union == 0 {
		return 1 // both empty
	}
	return float64(inter) / float64(union)
}

// FieldEqual compares one revision field under the kind's rule.
func FieldEqual(rule KindRule, field string, a, b *manifests.AnnotationRevision) bool {
	switch field {
	case FieldClass:
		return a.ClassID == b.ClassID
	case FieldGeometry:
		return GeometryEqual(rule, &a.Geometry, &b.Geometry)
	case FieldConfidence:
		return floatPtrClose(a.Confidence, b.Confidence, 1e-9)
	case FieldStatus:
		return a.Status == b.Status
	case FieldReviewer:
		return a.ReviewerID == b.ReviewerID
	case FieldAttributes:
		return reflect.DeepEqual(nonNil(a.Attributes), nonNil(b.Attributes))
	case FieldFrame:
		return a.CoordinateFrame == b.CoordinateFrame
	case FieldCalibration:
		return reflect.DeepEqual(a.Calibration, b.Calibration)
	case FieldOntologyRev:
		return a.OntologyRev == b.OntologyRev
	}
	return true
}

func nonNil(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// ChangedFields lists the compared fields that differ between a and b.
func ChangedFields(rules *Rules, a, b *manifests.AnnotationRevision) []string {
	rule := rules.For(b.Kind)
	var out []string
	if a.Kind != b.Kind {
		out = append(out, "kind")
	}
	for _, f := range rule.CompareFields {
		if !FieldEqual(rule, f, a, b) {
			out = append(out, f)
		}
	}
	return out
}

// SetField copies one field from src into dst (used by merges).
func SetField(dst, src *manifests.AnnotationRevision, field string) {
	switch field {
	case FieldClass:
		dst.ClassID = src.ClassID
	case FieldGeometry:
		dst.Geometry = src.Geometry
	case FieldConfidence:
		dst.Confidence = src.Confidence
	case FieldStatus:
		dst.Status = src.Status
	case FieldReviewer:
		dst.ReviewerID = src.ReviewerID
	case FieldAttributes:
		dst.Attributes = src.Attributes
	case FieldFrame:
		dst.CoordinateFrame = src.CoordinateFrame
	case FieldCalibration:
		dst.Calibration = src.Calibration
	case FieldOntologyRev:
		dst.OntologyRev = src.OntologyRev
	}
}
