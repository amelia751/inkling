package manifests

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/gowebpki/jcs"
	"golang.org/x/text/unicode/norm"
)

// Canonical serialises v with RFC 8785 (JCS) after normalising every string
// and object key to Unicode NFC, so equivalent inputs hash identically.
func Canonical(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return CanonicalizeJSON(raw)
}

// CanonicalizeJSON canonicalises arbitrary JSON bytes.
func CanonicalizeJSON(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return nil, fmt.Errorf("canonical: %w", err)
	}
	if dec.More() {
		return nil, fmt.Errorf("canonical: trailing data")
	}
	normalised, err := json.Marshal(nfc(tree))
	if err != nil {
		return nil, err
	}
	return jcs.Transform(normalised)
}

func nfc(v any) any {
	switch t := v.(type) {
	case string:
		return norm.NFC.String(t)
	case []any:
		for i := range t {
			t[i] = nfc(t[i])
		}
		return t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[norm.NFC.String(k)] = nfc(x)
		}
		return out
	default:
		return v
	}
}

// Hash returns "sha256:<hex>" of b.
func Hash(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

// HashHex returns the bare hex SHA-256 of b.
func HashHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// Encode sorts m into canonical order and returns its canonical bytes and hash.
func Encode(m *Manifest) ([]byte, string, error) {
	m.Sort()
	b, err := Canonical(m)
	if err != nil {
		return nil, "", err
	}
	return b, Hash(b), nil
}

// Decode parses manifest JSON strictly (unknown fields are errors).
func Decode(b []byte) (*Manifest, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	if dec.More() {
		return nil, fmt.Errorf("decode manifest: trailing data")
	}
	if m.Samples == nil {
		m.Samples = []Sample{}
	}
	if m.Annotations == nil {
		m.Annotations = []Annotation{}
	}
	return &m, nil
}

// DecodeRevision parses an annotation revision strictly.
func DecodeRevision(b []byte) (*AnnotationRevision, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var r AnnotationRevision
	if err := dec.Decode(&r); err != nil {
		return nil, fmt.Errorf("decode revision: %w", err)
	}
	return &r, nil
}

// EncodeRevision returns the canonical bytes and "sha256:" ref of r.
func EncodeRevision(r *AnnotationRevision) ([]byte, string, error) {
	b, err := Canonical(r)
	if err != nil {
		return nil, "", err
	}
	return b, Hash(b), nil
}

// EntryHash is the canonical hash of a single manifest entry, used to compare
// entries cheaply in diffs and merges.
func EntryHash(v any) string {
	b, err := Canonical(v)
	if err != nil {
		panic(err) // entries are plain structs; marshal cannot fail
	}
	return HashHex(b)
}
