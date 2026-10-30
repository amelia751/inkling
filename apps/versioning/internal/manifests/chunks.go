package manifests

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/parquet-go/parquet-go"
)

// Formats of a stored manifest root.
const (
	FormatJSON    = "json-v1"    // whole manifest in one canonical JSON document
	FormatChunked = "chunked-v1" // root JSON + 256 hash-bucketed Parquet chunks (todo4 V7)
)

// NumBuckets is the fixed partition count for chunked manifests.
const NumBuckets = 256

// Bucket returns the partition of a sample: the first byte of sha256(sample_id).
// Annotations live in their sample's bucket so partial checkout co-locates them.
func Bucket(sampleID string) int {
	s := sha256.Sum256([]byte(sampleID))
	return int(s[0])
}

// BucketKey formats a bucket number as two lowercase hex digits.
func BucketKey(b int) string { return fmt.Sprintf("%02x", b) }

// ChunkedRoot is the root document of a chunked manifest. Unchanged buckets
// keep their chunk hash, so a diff compares this map before reading chunks.
type ChunkedRoot struct {
	SchemaVersion   string            `json:"schema_version"`
	Format          string            `json:"format"`
	Ontology        Ontology          `json:"ontology"`
	SampleCount     int               `json:"sample_count"`
	AnnotationCount int               `json:"annotation_count"`
	Buckets         map[string]string `json:"buckets"`
}

type chunkRow struct {
	Kind     string `parquet:"kind,dict"`
	ID       string `parquet:"id"`
	SampleID string `parquet:"sample_id"`
	Doc      []byte `parquet:"doc"`
}

// Partition splits a sorted manifest into per-bucket partial manifests.
func Partition(m *Manifest) map[int]*Manifest {
	out := map[int]*Manifest{}
	get := func(b int) *Manifest {
		if out[b] == nil {
			out[b] = &Manifest{SchemaVersion: m.SchemaVersion, Ontology: m.Ontology, Samples: []Sample{}, Annotations: []Annotation{}}
		}
		return out[b]
	}
	for _, s := range m.Samples {
		p := get(Bucket(s.SampleID))
		p.Samples = append(p.Samples, s)
	}
	for _, a := range m.Annotations {
		p := get(Bucket(a.SampleID))
		p.Annotations = append(p.Annotations, a)
	}
	return out
}

// EncodeChunk writes one bucket as Parquet. Rows are in canonical order and
// every entry is canonical JSON, so equal content yields equal bytes.
func EncodeChunk(part *Manifest) ([]byte, error) {
	rows := make([]chunkRow, 0, len(part.Samples)+len(part.Annotations))
	for _, s := range part.Samples {
		doc, err := Canonical(s)
		if err != nil {
			return nil, err
		}
		rows = append(rows, chunkRow{Kind: "s", ID: s.SampleID, SampleID: s.SampleID, Doc: doc})
	}
	for _, a := range part.Annotations {
		doc, err := Canonical(a)
		if err != nil {
			return nil, err
		}
		rows = append(rows, chunkRow{Kind: "a", ID: a.AnnotationID, SampleID: a.SampleID, Doc: doc})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Kind != rows[j].Kind {
			return rows[i].Kind > rows[j].Kind // samples ("s") before annotations ("a")
		}
		return rows[i].ID < rows[j].ID
	})
	var buf bytes.Buffer
	w := parquet.NewGenericWriter[chunkRow](&buf, parquet.CreatedBy("versioning", "1", ""),
		parquet.Compression(&parquet.Zstd))
	if _, err := w.Write(rows); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// DecodeChunk reads a Parquet chunk back into a partial manifest.
func DecodeChunk(b []byte, ontology Ontology) (*Manifest, error) {
	rows, err := parquet.Read[chunkRow](bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return nil, fmt.Errorf("read chunk: %w", err)
	}
	m := &Manifest{SchemaVersion: SchemaVersion, Ontology: ontology, Samples: []Sample{}, Annotations: []Annotation{}}
	for _, r := range rows {
		switch r.Kind {
		case "s":
			var s Sample
			if err := json.Unmarshal(r.Doc, &s); err != nil {
				return nil, err
			}
			m.Samples = append(m.Samples, s)
		case "a":
			var a Annotation
			if err := json.Unmarshal(r.Doc, &a); err != nil {
				return nil, err
			}
			m.Annotations = append(m.Annotations, a)
		default:
			return nil, fmt.Errorf("chunk: unknown row kind %q", r.Kind)
		}
	}
	return m, nil
}

// Merge concatenates partial manifests and restores canonical order.
func Merge(ontology Ontology, parts ...*Manifest) *Manifest {
	m := &Manifest{SchemaVersion: SchemaVersion, Ontology: ontology, Samples: []Sample{}, Annotations: []Annotation{}}
	for _, p := range parts {
		m.Samples = append(m.Samples, p.Samples...)
		m.Annotations = append(m.Annotations, p.Annotations...)
	}
	m.Sort()
	return m
}
