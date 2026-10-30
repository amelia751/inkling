package manifests_test

import (
	"bytes"
	"encoding/json"
	"math/rand"
	"testing"
	"testing/quick"

	"golang.org/x/text/unicode/norm"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/testutil"
)

func TestCanonicalStableAcrossFieldOrder(t *testing.T) {
	a := []byte(`{"b":1,"a":{"y":[1,2],"x":"q"},"c":1.50}`)
	b := []byte(`{"c":1.5,"a":{"x":"q","y":[1,2]},"b":1.0}`)
	ca, err := manifests.CanonicalizeJSON(a)
	if err != nil {
		t.Fatal(err)
	}
	cb, err := manifests.CanonicalizeJSON(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ca, cb) {
		t.Fatalf("canonical forms differ:\n%s\n%s", ca, cb)
	}
}

// Property: shuffling sample order and choosing NFC or NFD for strings never
// changes the manifest hash.
func TestCanonicalHashProperty(t *testing.T) {
	f := func(seed int64, n uint8, useNFD bool) bool {
		r := rand.New(rand.NewSource(seed))
		count := int(n%20) + 1
		var samples []manifests.Sample
		for i := 0; i < count; i++ {
			s := testutil.Sample(string(rune('a'+i%26)) + "-é-" + string(rune('0'+i/26)))
			samples = append(samples, s)
		}
		m1 := testutil.Manifest(append([]manifests.Sample(nil), samples...))
		r.Shuffle(len(samples), func(i, j int) { samples[i], samples[j] = samples[j], samples[i] })
		m2 := &manifests.Manifest{SchemaVersion: "1", Ontology: testutil.Ontology(), Samples: samples, Annotations: []manifests.Annotation{}}
		if useNFD {
			raw, _ := json.Marshal(m2)
			raw = []byte(norm.NFD.String(string(raw)))
			var err error
			if m2, err = manifests.Decode(raw); err != nil {
				return false
			}
		}
		_, h1, err1 := manifests.Encode(m1)
		_, h2, err2 := manifests.Encode(m2)
		return err1 == nil && err2 == nil && h1 == h2
	}
	if err := quick.Check(f, &quick.Config{MaxCount: 200}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRejects(t *testing.T) {
	revs := testutil.NewRevisions()
	good := testutil.Manifest([]manifests.Sample{testutil.Sample("s1")},
		testutil.Ann(revs, testutil.Box("a1", "s1", "cat", 1, 1, 5, 5)))
	if err := manifests.Validate(good, 100); err != nil {
		t.Fatalf("good manifest rejected: %v", err)
	}
	cases := map[string]func(m *manifests.Manifest){
		"dangling annotation": func(m *manifests.Manifest) { m.Annotations[0].SampleID = "nope" },
		"unknown class":       func(m *manifests.Manifest) { m.Annotations[0].ClassID = "bird" },
		"bad hash":            func(m *manifests.Manifest) { m.Samples[0].Objects[0].SHA256 = "xyz" },
		"duplicate sample":    func(m *manifests.Manifest) { m.Samples = append(m.Samples, m.Samples[0]) },
		"bad kind":            func(m *manifests.Manifest) { m.Annotations[0].Kind = "blob" },
		"bad schema":          func(m *manifests.Manifest) { m.SchemaVersion = "9" },
		"path-like id":        func(m *manifests.Manifest) { m.Samples[0].SampleID = "../etc"; m.Annotations[0].SampleID = "../etc" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			raw, _ := json.Marshal(good)
			m, _ := manifests.Decode(raw)
			mutate(m)
			if err := manifests.Validate(m, 100); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
	if err := manifests.Validate(good, 1); err != manifests.ErrTooLarge {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
}

func TestChunkDeterministicAndRoundTrip(t *testing.T) {
	var samples []manifests.Sample
	for i := 0; i < 500; i++ {
		samples = append(samples, testutil.Sample("s"+string(rune('a'+i%26))+itoa(i)))
	}
	m := testutil.Manifest(samples)
	parts := manifests.Partition(m)
	for b, p := range parts {
		c1, err := manifests.EncodeChunk(p)
		if err != nil {
			t.Fatal(err)
		}
		c2, _ := manifests.EncodeChunk(p)
		if !bytes.Equal(c1, c2) {
			t.Fatalf("bucket %d: chunk bytes not deterministic", b)
		}
		back, err := manifests.DecodeChunk(c1, m.Ontology)
		if err != nil {
			t.Fatal(err)
		}
		if len(back.Samples) != len(p.Samples) {
			t.Fatalf("bucket %d: round trip lost samples", b)
		}
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
