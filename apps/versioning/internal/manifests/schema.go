// Package manifests defines the dataset manifest, its canonical encoding and
// its storage formats. The JSON Schema in schemas/versioning/
// dataset-manifest.schema.json is kept in sync by schema_test.go.
package manifests

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
)

// SchemaVersion is the manifest schema version this service writes.
const SchemaVersion = "1"

// Annotation kinds, matching the geometries in contracts.
const (
	KindBox2D       = "box2d"
	KindPolygon2D   = "polygon2d"
	KindMask2D      = "mask2d"
	KindRegion3D    = "region3d"
	KindTimespan    = "timespan"
	KindMeasurement = "measurement"
	KindTextspan    = "textspan"
)

// Kinds lists every valid annotation kind.
var Kinds = []string{KindBox2D, KindPolygon2D, KindMask2D, KindRegion3D, KindTimespan, KindMeasurement, KindTextspan}

// Manifest is the logical content of one dataset snapshot: which immutable
// artifacts and annotation revisions belong to it.
type Manifest struct {
	SchemaVersion string       `json:"schema_version"`
	Ontology      Ontology     `json:"ontology"`
	Samples       []Sample     `json:"samples"`
	Annotations   []Annotation `json:"annotations"`
}

// Ontology is the class taxonomy revision the annotations refer to.
type Ontology struct {
	RevisionID string          `json:"revision_id"`
	Classes    []OntologyClass `json:"classes"`
}

// OntologyClass is one class. ClassID is stable; Name may be renamed.
type OntologyClass struct {
	ClassID        string   `json:"class_id"`
	Name           string   `json:"name"`
	RequiredFields []string `json:"required_fields,omitempty"`
}

// Sample is one stable, opaque sample and the raw objects it consists of.
type Sample struct {
	SampleID string      `json:"sample_id"`
	Modality string      `json:"modality"`
	Objects  []ObjectRef `json:"objects"`
	Group    *Grouping   `json:"group,omitempty"`
	Split    string      `json:"split,omitempty"`
	Width    int         `json:"width,omitempty"`
	Height   int         `json:"height,omitempty"`
	Depth    int         `json:"depth,omitempty"`
	Duration float64     `json:"duration_s,omitempty"`
}

// ObjectRef points at an immutable artifact by content hash.
type ObjectRef struct {
	Role      string `json:"role"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
	MediaType string `json:"media_type"`
}

// Grouping is an asset grouping such as DICOM study/series. Values are
// hashes, never raw UIDs (spec §14).
type Grouping struct {
	StudyUIDHash  string `json:"study_uid_hash,omitempty"`
	SeriesUIDHash string `json:"series_uid_hash,omitempty"`
	Sequence      int    `json:"sequence,omitempty"`
}

// Annotation is a manifest entry pointing at an immutable annotation-revision
// document (todo4 2.1). ClassID is denormalised for indexes and class balance.
type Annotation struct {
	AnnotationID string `json:"annotation_id"`
	RevisionID   string `json:"revision_id"`
	SampleID     string `json:"sample_id"`
	Kind         string `json:"kind"`
	ClassID      string `json:"class_id"`
	OntologyRev  string `json:"ontology_rev"`
	Ref          string `json:"ref"`
}

var (
	idRE     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	sha256RE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	refRE    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	splitRE  = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)
	tokenRE  = regexp.MustCompile(`^[a-z0-9][a-z0-9_.+/-]{0,127}$`)
)

// ValidationError lists every problem found, using paths and ids only.
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	if len(e.Problems) == 1 {
		return "manifest invalid: " + e.Problems[0]
	}
	return fmt.Sprintf("manifest invalid: %s (and %d more)", e.Problems[0], len(e.Problems)-1)
}

// ErrTooLarge is returned when a manifest exceeds the entry limit.
var ErrTooLarge = errors.New("manifest exceeds MAX_COMMIT_ENTRIES")

// Validate checks structural and referential integrity of m.
func Validate(m *Manifest, maxEntries int) error {
	if maxEntries > 0 && len(m.Samples)+len(m.Annotations) > maxEntries {
		return ErrTooLarge
	}
	var p []string
	add := func(f string, a ...any) {
		if len(p) < 100 {
			p = append(p, fmt.Sprintf(f, a...))
		}
	}
	if m.SchemaVersion != SchemaVersion {
		add("schema_version must be %q", SchemaVersion)
	}
	if m.Ontology.RevisionID != "" && !idRE.MatchString(m.Ontology.RevisionID) {
		add("ontology.revision_id invalid")
	}
	classes := map[string]bool{}
	for i, c := range m.Ontology.Classes {
		if !idRE.MatchString(c.ClassID) {
			add("ontology.classes[%d].class_id invalid", i)
		}
		if classes[c.ClassID] {
			add("ontology.classes[%d].class_id duplicate", i)
		}
		classes[c.ClassID] = true
		if c.Name == "" || len(c.Name) > 200 {
			add("ontology.classes[%d].name invalid", i)
		}
	}
	samples := make(map[string]*Sample, len(m.Samples))
	for i := range m.Samples {
		s := &m.Samples[i]
		if !idRE.MatchString(s.SampleID) {
			add("samples[%d].sample_id invalid", i)
			continue
		}
		if samples[s.SampleID] != nil {
			add("samples[%d].sample_id duplicate: %s", i, s.SampleID)
		}
		samples[s.SampleID] = s
		if !tokenRE.MatchString(s.Modality) {
			add("samples[%s].modality invalid", s.SampleID)
		}
		if len(s.Objects) == 0 {
			add("samples[%s].objects empty", s.SampleID)
		}
		roles := map[string]bool{}
		for j, o := range s.Objects {
			if !sha256RE.MatchString(o.SHA256) {
				add("samples[%s].objects[%d].sha256 invalid", s.SampleID, j)
			}
			if o.SizeBytes < 0 {
				add("samples[%s].objects[%d].size_bytes negative", s.SampleID, j)
			}
			if !tokenRE.MatchString(o.Role) || roles[o.Role] {
				add("samples[%s].objects[%d].role invalid or duplicate", s.SampleID, j)
			}
			roles[o.Role] = true
			if !tokenRE.MatchString(o.MediaType) {
				add("samples[%s].objects[%d].media_type invalid", s.SampleID, j)
			}
		}
		if s.Split != "" && !splitRE.MatchString(s.Split) {
			add("samples[%s].split invalid", s.SampleID)
		}
		if s.Width < 0 || s.Height < 0 || s.Depth < 0 || s.Duration < 0 {
			add("samples[%s] dimensions negative", s.SampleID)
		}
		if g := s.Group; g != nil {
			for _, h := range []string{g.StudyUIDHash, g.SeriesUIDHash} {
				if h != "" && !sha256RE.MatchString(h) {
					add("samples[%s].group uid hashes must be sha256 hex", s.SampleID)
				}
			}
		}
	}
	ann := make(map[string]bool, len(m.Annotations))
	for i, a := range m.Annotations {
		if !idRE.MatchString(a.AnnotationID) {
			add("annotations[%d].annotation_id invalid", i)
			continue
		}
		if ann[a.AnnotationID] {
			add("annotations[%d].annotation_id duplicate: %s", i, a.AnnotationID)
		}
		ann[a.AnnotationID] = true
		if !idRE.MatchString(a.RevisionID) {
			add("annotations[%s].revision_id invalid", a.AnnotationID)
		}
		if samples[a.SampleID] == nil {
			add("annotations[%s].sample_id references unknown sample", a.AnnotationID)
		}
		if !validKind(a.Kind) {
			add("annotations[%s].kind invalid", a.AnnotationID)
		}
		if len(classes) > 0 && !classes[a.ClassID] {
			add("annotations[%s].class_id not in ontology", a.AnnotationID)
		}
		if !refRE.MatchString(a.Ref) {
			add("annotations[%s].ref must be sha256:<hex>", a.AnnotationID)
		}
	}
	if len(p) > 0 {
		return &ValidationError{Problems: p}
	}
	return nil
}

func validKind(k string) bool {
	for _, x := range Kinds {
		if x == k {
			return true
		}
	}
	return false
}

// Sort orders entries by stable id, the canonical order.
func (m *Manifest) Sort() {
	sort.Slice(m.Samples, func(i, j int) bool { return m.Samples[i].SampleID < m.Samples[j].SampleID })
	sort.Slice(m.Annotations, func(i, j int) bool { return m.Annotations[i].AnnotationID < m.Annotations[j].AnnotationID })
	sort.Slice(m.Ontology.Classes, func(i, j int) bool { return m.Ontology.Classes[i].ClassID < m.Ontology.Classes[j].ClassID })
	for i := range m.Samples {
		o := m.Samples[i].Objects
		sort.Slice(o, func(a, b int) bool { return o[a].Role < o[b].Role })
	}
	for i := range m.Ontology.Classes {
		sort.Strings(m.Ontology.Classes[i].RequiredFields)
	}
}

// ArtifactHashes returns every artifact content hash the manifest references:
// sample objects and annotation-revision documents.
func (m *Manifest) ArtifactHashes() []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range m.Samples {
		for _, o := range s.Objects {
			if !seen[o.SHA256] {
				seen[o.SHA256] = true
				out = append(out, o.SHA256)
			}
		}
	}
	for _, a := range m.Annotations {
		h := RefHex(a.Ref)
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

// RefHex strips the "sha256:" prefix.
func RefHex(ref string) string {
	if len(ref) > 7 && ref[:7] == "sha256:" {
		return ref[7:]
	}
	return ref
}
