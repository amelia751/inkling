package manifests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"

	"golang.org/x/sync/errgroup"
)

// ObjectIO is the slice of the blob store the manifest store needs.
type ObjectIO interface {
	PutManifest(ctx context.Context, key string, data []byte, contentType string) error
	GetManifest(ctx context.Context, key string) ([]byte, error)
}

// Keys builds manifest object keys for a tenant and repo.
type Keys interface {
	Root(tenant, repo, rootHex string) string
	Chunk(tenant, repo, chunkHex string) string
}

// Store writes and reads immutable manifests in the manifests bucket.
type Store struct {
	IO        ObjectIO
	Keys      Keys
	Threshold int // samples above which the chunked format is used
}

// Written describes a stored manifest.
type Written struct {
	RootHash  string
	Format    string
	ObjectKey string
	Index     []IndexRow
	Samples   int
	Annots    int
	Manifest  *Manifest
}

// Root is a loaded manifest root: the whole manifest (json-v1) or the bucket
// map of a chunked manifest.
type Root struct {
	Hash     string
	Format   string
	Ontology Ontology
	Buckets  map[int]string // chunked only: bucket → "sha256:" chunk hash
	Full     *Manifest      // json-v1 only
	Samples  int
	Annots   int
}

// Write canonicalises and stores m. It is idempotent: equal manifests produce
// the same root hash and the same object keys.
func (s *Store) Write(ctx context.Context, tenant, repo string, m *Manifest) (*Written, error) {
	m.Sort()
	w := &Written{Index: BuildIndex(m), Samples: len(m.Samples), Annots: len(m.Annotations), Manifest: m}
	if len(m.Samples) <= s.Threshold {
		b, h, err := Encode(m)
		if err != nil {
			return nil, err
		}
		w.RootHash, w.Format = h, FormatJSON
		w.ObjectKey = s.Keys.Root(tenant, repo, RefHex(h))
		return w, s.IO.PutManifest(ctx, w.ObjectKey, b, "application/json")
	}
	parts := Partition(m)
	root := ChunkedRoot{SchemaVersion: SchemaVersion, Format: FormatChunked, Ontology: m.Ontology,
		SampleCount: len(m.Samples), AnnotationCount: len(m.Annotations), Buckets: map[string]string{}}
	type out struct {
		bucket int
		hash   string
	}
	results := make(chan out, len(parts))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(16)
	for b, part := range parts {
		g.Go(func() error {
			data, err := EncodeChunk(part)
			if err != nil {
				return err
			}
			h := Hash(data)
			if err := s.IO.PutManifest(gctx, s.Keys.Chunk(tenant, repo, RefHex(h)), data, "application/vnd.apache.parquet"); err != nil {
				return err
			}
			results <- out{b, h}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	close(results)
	for r := range results {
		root.Buckets[BucketKey(r.bucket)] = r.hash
	}
	b, err := Canonical(root)
	if err != nil {
		return nil, err
	}
	w.RootHash, w.Format = Hash(b), FormatChunked
	w.ObjectKey = s.Keys.Root(tenant, repo, RefHex(w.RootHash))
	return w, s.IO.PutManifest(ctx, w.ObjectKey, b, "application/json")
}

func (s *Store) getVerified(ctx context.Context, key, want string) ([]byte, error) {
	b, err := s.IO.GetManifest(ctx, key)
	if err != nil {
		return nil, err
	}
	if Hash(b) != want {
		return nil, fmt.Errorf("manifest object %s failed hash verification", want)
	}
	return b, nil
}

// LoadRoot reads and verifies a manifest root.
func (s *Store) LoadRoot(ctx context.Context, tenant, repo, rootHash string) (*Root, error) {
	b, err := s.getVerified(ctx, s.Keys.Root(tenant, repo, RefHex(rootHash)), rootHash)
	if err != nil {
		return nil, err
	}
	var probe struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return nil, err
	}
	if probe.Format == FormatChunked {
		var cr ChunkedRoot
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&cr); err != nil {
			return nil, err
		}
		r := &Root{Hash: rootHash, Format: FormatChunked, Ontology: cr.Ontology, Buckets: map[int]string{},
			Samples: cr.SampleCount, Annots: cr.AnnotationCount}
		for k, v := range cr.Buckets {
			n, err := strconv.ParseUint(k, 16, 8)
			if err != nil {
				return nil, fmt.Errorf("chunked root: bad bucket %q", k)
			}
			r.Buckets[int(n)] = v
		}
		return r, nil
	}
	m, err := Decode(b)
	if err != nil {
		return nil, err
	}
	return &Root{Hash: rootHash, Format: FormatJSON, Ontology: m.Ontology, Full: m,
		Samples: len(m.Samples), Annots: len(m.Annotations)}, nil
}

// LoadBuckets returns the partial manifest for the given buckets. For a
// json-v1 root it filters the full manifest.
func (s *Store) LoadBuckets(ctx context.Context, tenant, repo string, r *Root, buckets []int) (*Manifest, error) {
	if r.Format == FormatJSON {
		want := map[int]bool{}
		for _, b := range buckets {
			want[b] = true
		}
		parts := Partition(r.Full)
		var sel []*Manifest
		for b, p := range parts {
			if want[b] {
				sel = append(sel, p)
			}
		}
		return Merge(r.Ontology, sel...), nil
	}
	sort.Ints(buckets)
	parts := make([]*Manifest, len(buckets))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(16)
	for i, b := range buckets {
		h, ok := r.Buckets[b]
		if !ok {
			parts[i] = &Manifest{}
			continue
		}
		g.Go(func() error {
			data, err := s.getVerified(gctx, s.Keys.Chunk(tenant, repo, RefHex(h)), h)
			if err != nil {
				return err
			}
			parts[i], err = DecodeChunk(data, r.Ontology)
			return err
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return Merge(r.Ontology, parts...), nil
}

// Load returns the whole manifest for a root.
func (s *Store) Load(ctx context.Context, tenant, repo, rootHash string) (*Manifest, error) {
	r, err := s.LoadRoot(ctx, tenant, repo, rootHash)
	if err != nil {
		return nil, err
	}
	if r.Format == FormatJSON {
		return r.Full, nil
	}
	all := make([]int, 0, len(r.Buckets))
	for b := range r.Buckets {
		all = append(all, b)
	}
	return s.LoadBuckets(ctx, tenant, repo, r, all)
}

// ChunkKeys lists every object key a root depends on (for GC and reconcile).
func (s *Store) ChunkKeys(tenant, repo string, r *Root) []string {
	keys := []string{s.Keys.Root(tenant, repo, RefHex(r.Hash))}
	for _, h := range r.Buckets {
		keys = append(keys, s.Keys.Chunk(tenant, repo, RefHex(h)))
	}
	sort.Strings(keys)
	return keys
}
