//go:build integration

package storage_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"studio.local/versioning/internal/storage"
)

// TestGCS runs against real Cloud Storage when VERSIONING_TEST_GCS_OBJECT_BUCKET and
// VERSIONING_TEST_GCS_MANIFEST_BUCKET name writable buckets (Application Default Credentials;
// synthetic bytes only). Otherwise it's skipped.
func TestGCS(t *testing.T) {
	ob, mb := os.Getenv("VERSIONING_TEST_GCS_OBJECT_BUCKET"), os.Getenv("VERSIONING_TEST_GCS_MANIFEST_BUCKET")
	if ob == "" || mb == "" {
		t.Skip("set VERSIONING_TEST_GCS_OBJECT_BUCKET and VERSIONING_TEST_GCS_MANIFEST_BUCKET")
	}
	ctx := context.Background()
	s, err := storage.NewGCS(ctx, storage.GCSConfig{ObjectBucket: ob, ManifestBucket: mb})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("synthetic"), 1000)
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	tenant := "00000000-0000-0000-0000-0000000000gc"

	// A wrong hash never becomes visible.
	bad := hex.EncodeToString(make([]byte, 32))
	if err := s.PutStaged(ctx, tenant, bad, int64(len(data)), "application/octet-stream", bytes.NewReader(data)); !errors.Is(err, storage.ErrHashMismatch) {
		t.Fatalf("bad hash: %v", err)
	}
	if _, err := s.Head(ctx, tenant, bad); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("bad hash visible: %v", err)
	}

	if err := s.PutStaged(ctx, tenant, sha, int64(len(data)), "application/octet-stream", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Delete(context.Background(), tenant, sha) })
	if err := s.PutStaged(ctx, tenant, sha, int64(len(data)), "application/octet-stream", bytes.NewReader(data)); err != nil {
		t.Fatalf("idempotent put: %v", err)
	}
	info, err := s.Head(ctx, tenant, sha)
	if err != nil || info.Size != int64(len(data)) {
		t.Fatalf("head: %+v %v", info, err)
	}
	rc, err := s.Get(ctx, tenant, sha, &storage.Range{Start: 9, End: 17})
	if err != nil {
		t.Fatal(err)
	}
	part, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(part, data[9:18]) {
		t.Fatalf("range: %q", part)
	}
	if url, err := s.PresignGet(ctx, tenant, sha, time.Minute); err != nil || !strings.Contains(url, "X-Goog-Signature") {
		t.Logf("presign unavailable with these credentials (needs a service account): %v", err)
	}

	key := "t/repo/roots/" + sha + ".json"
	if err := s.PutManifest(ctx, key, []byte(`{}`), "application/json"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteManifest(context.Background(), key) })
	got, err := s.GetManifest(ctx, key)
	if err != nil || string(got) != "{}" {
		t.Fatalf("manifest: %q %v", got, err)
	}
	n := 0
	if err := s.ListManifests(ctx, "t/repo/", func(string, time.Time) error { n++; return nil }); err != nil || n == 0 {
		t.Fatalf("list: %d %v", n, err)
	}
}
