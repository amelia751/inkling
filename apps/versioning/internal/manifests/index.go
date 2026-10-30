package manifests

import "sort"

// IndexRow is one row of versioning.manifest_index: sample counts and label
// counts per (bucket, study, series, split), so filters resolve to buckets
// without reading chunks.
type IndexRow struct {
	Bucket        int
	StudyUIDHash  string
	SeriesUIDHash string
	Split         string
	SampleCount   int
	LabelCounts   map[string]int
}

type indexKey struct {
	bucket               int
	study, series, split string
}

// BuildIndex aggregates m into index rows.
func BuildIndex(m *Manifest) []IndexRow {
	rows := map[indexKey]*IndexRow{}
	keyOf := map[string]indexKey{}
	for _, s := range m.Samples {
		k := indexKey{bucket: Bucket(s.SampleID), split: s.Split}
		if s.Group != nil {
			k.study, k.series = s.Group.StudyUIDHash, s.Group.SeriesUIDHash
		}
		keyOf[s.SampleID] = k
		r := rows[k]
		if r == nil {
			r = &IndexRow{Bucket: k.bucket, StudyUIDHash: k.study, SeriesUIDHash: k.series, Split: k.split, LabelCounts: map[string]int{}}
			rows[k] = r
		}
		r.SampleCount++
	}
	for _, a := range m.Annotations {
		if k, ok := keyOf[a.SampleID]; ok {
			rows[k].LabelCounts[a.ClassID]++
		}
	}
	out := make([]IndexRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Bucket != b.Bucket {
			return a.Bucket < b.Bucket
		}
		if a.StudyUIDHash != b.StudyUIDHash {
			return a.StudyUIDHash < b.StudyUIDHash
		}
		if a.SeriesUIDHash != b.SeriesUIDHash {
			return a.SeriesUIDHash < b.SeriesUIDHash
		}
		return a.Split < b.Split
	})
	return out
}

// Filter selects samples for partial checkout. Empty fields match everything.
type Filter struct {
	SampleIDs      []string
	Splits         []string
	StudyUIDHashes []string
}

// Empty reports whether the filter selects everything.
func (f Filter) Empty() bool {
	return len(f.SampleIDs) == 0 && len(f.Splits) == 0 && len(f.StudyUIDHashes) == 0
}

// Match reports whether s passes the filter.
func (f Filter) Match(s *Sample) bool {
	if len(f.SampleIDs) > 0 && !contains(f.SampleIDs, s.SampleID) {
		return false
	}
	if len(f.Splits) > 0 && !contains(f.Splits, s.Split) {
		return false
	}
	if len(f.StudyUIDHashes) > 0 && (s.Group == nil || !contains(f.StudyUIDHashes, s.Group.StudyUIDHash)) {
		return false
	}
	return true
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// Apply returns the subset of m selected by f (annotations follow samples).
func (f Filter) Apply(m *Manifest) *Manifest {
	if f.Empty() {
		return m
	}
	out := &Manifest{SchemaVersion: m.SchemaVersion, Ontology: m.Ontology, Samples: []Sample{}, Annotations: []Annotation{}}
	keep := map[string]bool{}
	for i := range m.Samples {
		if f.Match(&m.Samples[i]) {
			keep[m.Samples[i].SampleID] = true
			out.Samples = append(out.Samples, m.Samples[i])
		}
	}
	for _, a := range m.Annotations {
		if keep[a.SampleID] {
			out.Annotations = append(out.Annotations, a)
		}
	}
	return out
}
