package manifests_test

import (
	"bytes"
	"testing"

	"studio.local/versioning/internal/manifests"
)

// FuzzManifestDecode: arbitrary bytes never panic the decoder or validator,
// and anything that decodes and validates re-encodes to a stable hash.
func FuzzManifestDecode(f *testing.F) {
	f.Add([]byte(`{"schema_version":"1","ontology":{"revision_id":"o","classes":[]},"samples":[],"annotations":[]}`))
	f.Add([]byte(`{"schema_version":"1","ontology":{"revision_id":"o","classes":[{"class_id":"c","name":"C"}]},"samples":[{"sample_id":"s","modality":"image2d","objects":[{"role":"image","sha256":"` +
		"0000000000000000000000000000000000000000000000000000000000000000" + `","size_bytes":1,"media_type":"image/png"}]}],"annotations":[]}`))
	f.Add([]byte(`{"samples":null}`))
	f.Fuzz(func(t *testing.T, b []byte) {
		m, err := manifests.Decode(b)
		if err != nil {
			return
		}
		if manifests.Validate(m, 10_000) != nil {
			return
		}
		_, h1, err := manifests.Encode(m)
		if err != nil {
			t.Fatal(err)
		}
		_, h2, _ := manifests.Encode(m)
		if h1 != h2 {
			t.Fatal("unstable hash")
		}
	})
}

// FuzzCanonicalJSON: canonicalisation is idempotent.
func FuzzCanonicalJSON(f *testing.F) {
	for _, s := range []string{`{"b":1,"a":2}`, `[1,2.50,"é"]`, `{"x":{"z":null,"y":true}}`, `"é"`, `1e3`} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		c1, err := manifests.CanonicalizeJSON(b)
		if err != nil {
			return
		}
		c2, err := manifests.CanonicalizeJSON(c1)
		if err != nil {
			t.Fatalf("canonical output does not re-parse: %v", err)
		}
		if !bytes.Equal(c1, c2) {
			t.Fatalf("not idempotent:\n%s\n%s", c1, c2)
		}
	})
}
