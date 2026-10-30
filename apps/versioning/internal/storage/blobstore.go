package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"regexp"
	"time"
)

// Blob store errors.
var (
	ErrNotFound     = errors.New("blob not found")
	ErrHashMismatch = errors.New("content sha256 does not match")
	ErrSizeMismatch = errors.New("content length does not match")
)

// ObjectInfo describes a stored raw object.
type ObjectInfo struct {
	Size      int64
	MediaType string
}

// Range is an inclusive byte range for partial reads.
type Range struct{ Start, End int64 }

// MaxPresignTTL caps signed URL lifetimes (todo4 1.4).
const MaxPresignTTL = 5 * time.Minute

// MultipartThreshold is the size above which uploads go through a verified
// temp file and multipart upload (todo4 Phase 3).
const MultipartThreshold = 64 << 20

// BlobStore holds raw artifacts (content-addressed, per tenant) and manifest
// documents. Keys never contain user file names (spec §3.2).
type BlobStore interface {
	// PutStaged streams r to {tenant}/sha256/ab/cd/<sha256>, verifying hash
	// and length before the object becomes visible. Re-uploading identical
	// content is a no-op.
	PutStaged(ctx context.Context, tenant, sha string, size int64, mediaType string, r io.Reader) error
	Head(ctx context.Context, tenant, sha string) (ObjectInfo, error)
	Get(ctx context.Context, tenant, sha string, rng *Range) (io.ReadCloser, error)
	PresignGet(ctx context.Context, tenant, sha string, ttl time.Duration) (string, error)
	// Delete removes a raw object; only GC and purge call it.
	Delete(ctx context.Context, tenant, sha string) error

	PutManifest(ctx context.Context, key string, data []byte, contentType string) error
	GetManifest(ctx context.Context, key string) ([]byte, error)
	DeleteManifest(ctx context.Context, key string) error
	ListManifests(ctx context.Context, prefix string, fn func(key string, modified time.Time) error) error

	Ping(ctx context.Context) error
}

var shaRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ObjectKey is the storage key of a raw artifact.
func ObjectKey(tenant, sha string) string {
	return fmt.Sprintf("%s/sha256/%s/%s/%s", tenant, sha[0:2], sha[2:4], sha)
}

// ManifestRootKey is the key of a manifest root document.
func ManifestRootKey(tenant, repo, rootHex string) string {
	return fmt.Sprintf("%s/%s/roots/%s.json", tenant, repo, rootHex)
}

// ManifestChunkKey is the key of a manifest Parquet chunk.
func ManifestChunkKey(tenant, repo, chunkHex string) string {
	return fmt.Sprintf("%s/%s/chunks/%s.parquet", tenant, repo, chunkHex)
}

// DiffResultKey is the key of an asynchronously computed diff.
func DiffResultKey(tenant, repo, jobID string) string {
	return fmt.Sprintf("%s/%s/diffs/%s.json", tenant, repo, jobID)
}

func checkSHA(sha string) error {
	if !shaRE.MatchString(sha) {
		return fmt.Errorf("invalid sha256 %q", sha)
	}
	return nil
}

// verifyingReader hashes and counts bytes as they stream through.
type verifyingReader struct {
	r io.Reader
	h hash.Hash
	n int64
}

func newVerifyingReader(r io.Reader) *verifyingReader {
	return &verifyingReader{r: r, h: sha256.New()}
}

func (v *verifyingReader) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	v.n += int64(n)
	v.h.Write(p[:n])
	return n, err
}

func (v *verifyingReader) check(sha string, size int64) error {
	if v.n != size {
		return ErrSizeMismatch
	}
	if hex.EncodeToString(v.h.Sum(nil)) != sha {
		return ErrHashMismatch
	}
	return nil
}

// ManifestKeys adapts the key helpers to manifests.Keys.
type ManifestKeys struct{}

// Root returns the root document key.
func (ManifestKeys) Root(tenant, repo, rootHex string) string {
	return ManifestRootKey(tenant, repo, rootHex)
}

// Chunk returns the chunk key.
func (ManifestKeys) Chunk(tenant, repo, chunkHex string) string {
	return ManifestChunkKey(tenant, repo, chunkHex)
}
