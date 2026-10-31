package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/iterator"
)

// GCSConfig configures the Cloud Storage adapter. Credentials are Application
// Default Credentials only (Workload Identity on GKE): no key file, no HMAC key.
type GCSConfig struct {
	ObjectBucket   string
	ManifestBucket string
	// SignerEmail is the service account that signs URLs through the IAM
	// signBlob API; empty means the one the credentials belong to.
	SignerEmail string
}

// GCS is the BlobStore on Google Cloud, through the native JSON API.
type GCS struct {
	client *storage.Client
	cfg    GCSConfig
}

var _ BlobStore = (*GCS)(nil)

// NewGCS builds the adapter with Application Default Credentials.
func NewGCS(ctx context.Context, c GCSConfig) (*GCS, error) {
	client, err := storage.NewClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("gcs client: %w", err)
	}
	return &GCS{client: client, cfg: c}, nil
}

func (s *GCS) obj(tenant, sha string) *storage.ObjectHandle {
	return s.client.Bucket(s.cfg.ObjectBucket).Object(ObjectKey(tenant, sha))
}

func gcsNotFound(err error) bool {
	if errors.Is(err, storage.ErrObjectNotExist) {
		return true
	}
	var ge *googleapi.Error
	return errors.As(err, &ge) && ge.Code == http.StatusNotFound
}

func gcsPreconditionFailed(err error) bool {
	var ge *googleapi.Error
	return errors.As(err, &ge) && ge.Code == http.StatusPreconditionFailed
}

// PutStaged streams r into the content key while hashing it. The object only
// becomes visible when the writer closes, and the write is cancelled (nothing
// appears) unless hash and length verified. Large uploads are resumable in
// MultipartThreshold chunks, so nothing is buffered on disk.
func (s *GCS) PutStaged(ctx context.Context, tenant, sha string, size int64, mediaType string, r io.Reader) error {
	if err := checkSHA(sha); err != nil {
		return err
	}
	if info, err := s.Head(ctx, tenant, sha); err == nil {
		if info.Size != size {
			return ErrSizeMismatch
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(r, size)) // drain; content already present
		return nil
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// DoesNotExist: a concurrent identical upload wins; ours is then a no-op.
	w := s.obj(tenant, sha).If(storage.Conditions{DoesNotExist: true}).NewWriter(wctx)
	w.ContentType = mediaType
	w.ChunkSize = MultipartThreshold
	w.Metadata = map[string]string{"sha256": sha}
	vr := newVerifyingReader(io.LimitReader(r, size+1))
	if _, err := io.Copy(w, vr); err != nil {
		cancel()
		_ = w.Close()
		return err
	}
	if err := vr.check(sha, size); err != nil {
		cancel() // abort: the object never becomes visible
		_ = w.Close()
		return err
	}
	if err := w.Close(); err != nil && !gcsPreconditionFailed(err) {
		return err
	}
	return nil
}

// Head returns size and media type.
func (s *GCS) Head(ctx context.Context, tenant, sha string) (ObjectInfo, error) {
	if err := checkSHA(sha); err != nil {
		return ObjectInfo{}, err
	}
	a, err := s.obj(tenant, sha).Attrs(ctx)
	if err != nil {
		if gcsNotFound(err) {
			return ObjectInfo{}, ErrNotFound
		}
		return ObjectInfo{}, err
	}
	return ObjectInfo{Size: a.Size, MediaType: a.ContentType}, nil
}

// Get streams an object, optionally an inclusive byte range.
func (s *GCS) Get(ctx context.Context, tenant, sha string, rng *Range) (io.ReadCloser, error) {
	if err := checkSHA(sha); err != nil {
		return nil, err
	}
	off, length := int64(0), int64(-1)
	if rng != nil {
		off, length = rng.Start, rng.End-rng.Start+1
	}
	rc, err := s.obj(tenant, sha).NewRangeReader(ctx, off, length)
	if err != nil {
		if gcsNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return rc, nil
}

// PresignGet returns a short-lived V4 GET URL, signed through IAM signBlob as
// the workload's service account (needs roles/iam.serviceAccountTokenCreator
// on itself; infra/terraform/phi/iam.tf).
func (s *GCS) PresignGet(ctx context.Context, tenant, sha string, ttl time.Duration) (string, error) {
	if err := checkSHA(sha); err != nil {
		return "", err
	}
	if ttl <= 0 || ttl > MaxPresignTTL {
		ttl = MaxPresignTTL
	}
	opts := &storage.SignedURLOptions{Scheme: storage.SigningSchemeV4, Method: http.MethodGet, Expires: time.Now().Add(ttl)}
	if s.cfg.SignerEmail != "" {
		opts.GoogleAccessID = s.cfg.SignerEmail
	}
	return s.client.Bucket(s.cfg.ObjectBucket).SignedURL(ObjectKey(tenant, sha), opts)
}

// Delete removes a raw object.
func (s *GCS) Delete(ctx context.Context, tenant, sha string) error {
	if err := checkSHA(sha); err != nil {
		return err
	}
	if err := s.obj(tenant, sha).Delete(ctx); err != nil && !gcsNotFound(err) {
		return err
	}
	return nil
}

// PutManifest writes a manifest document (immutable, content-addressed key).
func (s *GCS) PutManifest(ctx context.Context, key string, data []byte, contentType string) error {
	w := s.client.Bucket(s.cfg.ManifestBucket).Object(key).NewWriter(ctx)
	w.ContentType = contentType
	if _, err := w.Write(data); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}

// GetManifest reads a manifest document.
func (s *GCS) GetManifest(ctx context.Context, key string) ([]byte, error) {
	rc, err := s.client.Bucket(s.cfg.ManifestBucket).Object(key).NewReader(ctx)
	if err != nil {
		if gcsNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	return io.ReadAll(rc)
}

// DeleteManifest removes a manifest document; only GC calls it.
func (s *GCS) DeleteManifest(ctx context.Context, key string) error {
	if err := s.client.Bucket(s.cfg.ManifestBucket).Object(key).Delete(ctx); err != nil && !gcsNotFound(err) {
		return err
	}
	return nil
}

// ListManifests visits manifest keys under prefix.
func (s *GCS) ListManifests(ctx context.Context, prefix string, fn func(string, time.Time) error) error {
	q := &storage.Query{Prefix: prefix}
	if err := q.SetAttrSelection([]string{"Name", "Updated"}); err != nil {
		return err
	}
	it := s.client.Bucket(s.cfg.ManifestBucket).Objects(ctx, q)
	for {
		a, err := it.Next()
		if errors.Is(err, iterator.Done) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := fn(a.Name, a.Updated); err != nil {
			return err
		}
	}
}

// Ping lists one object in each bucket (objects.list: the workload holds
// object roles only, not buckets.get).
func (s *GCS) Ping(ctx context.Context) error {
	for _, b := range []string{s.cfg.ObjectBucket, s.cfg.ManifestBucket} {
		it := s.client.Bucket(b).Objects(ctx, &storage.Query{})
		it.PageInfo().MaxSize = 1
		if _, err := it.Next(); err != nil && !errors.Is(err, iterator.Done) {
			return fmt.Errorf("list bucket %s: %w", b, err)
		}
	}
	return nil
}
