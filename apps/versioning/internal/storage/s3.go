package storage

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

// S3Config configures the S3 adapter. Endpoint + PathStyle cover MinIO; GCS
// works through its S3 interoperability endpoint.
type S3Config struct {
	Endpoint       string
	Region         string
	PathStyle      bool
	AccessKeyID    string
	SecretKey      string
	ObjectBucket   string
	ManifestBucket string
	TempDir        string // buffer for large uploads; an emptyDir in k8s
}

// S3 is the production BlobStore.
type S3 struct {
	client  *s3.Client
	presign *s3.PresignClient
	cfg     S3Config
}

var _ BlobStore = (*S3)(nil)

// NewS3 builds the adapter.
func NewS3(ctx context.Context, c S3Config) (*S3, error) {
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(c.Region)}
	if c.AccessKeyID != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(c.AccessKeyID, c.SecretKey, "")))
	}
	ac, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	client := s3.NewFromConfig(ac, func(o *s3.Options) {
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
		}
		o.UsePathStyle = c.PathStyle
		// Only send/validate checksums when an operation requires them, which
		// keeps MinIO and GCS interop happy; we set SHA-256 ourselves.
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	return &S3{client: client, presign: s3.NewPresignClient(client), cfg: c}, nil
}

func isNotFound(err error) bool {
	var nsk *types.NoSuchKey
	var nf *types.NotFound
	if errors.As(err, &nsk) || errors.As(err, &nf) {
		return true
	}
	var ae smithy.APIError
	return errors.As(err, &ae) && (ae.ErrorCode() == "NotFound" || ae.ErrorCode() == "NoSuchKey")
}

// PutStaged uploads raw bytes under their content key after verifying them.
// Small objects are buffered and sent with a SHA-256 checksum the server also
// checks; large ones stream to a temp file while hashing, then go up in 64 MiB
// multipart parts. Nothing appears under the content key unless it verified.
func (s *S3) PutStaged(ctx context.Context, tenant, sha string, size int64, mediaType string, r io.Reader) error {
	if err := checkSHA(sha); err != nil {
		return err
	}
	key := ObjectKey(tenant, sha)
	if info, err := s.Head(ctx, tenant, sha); err == nil {
		if info.Size != size {
			return ErrSizeMismatch
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(r, size)) // drain; content already present
		return nil
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	raw, _ := hex.DecodeString(sha)
	sum := base64.StdEncoding.EncodeToString(raw)
	if size <= MultipartThreshold {
		vr := newVerifyingReader(io.LimitReader(r, size+1))
		buf, err := io.ReadAll(vr)
		if err != nil {
			return err
		}
		if err := vr.check(sha, size); err != nil {
			return err
		}
		_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket: &s.cfg.ObjectBucket, Key: &key, Body: bytes.NewReader(buf),
			ContentLength: aws.Int64(size), ContentType: aws.String(mediaType),
			ChecksumSHA256: aws.String(sum), ChecksumAlgorithm: types.ChecksumAlgorithmSha256,
		})
		return err
	}
	return s.putLarge(ctx, key, sha, size, mediaType, r)
}

func (s *S3) putLarge(ctx context.Context, key, sha string, size int64, mediaType string, r io.Reader) error {
	f, err := os.CreateTemp(s.cfg.TempDir, "upload-*")
	if err != nil {
		return err
	}
	defer func() { _ = f.Close(); _ = os.Remove(f.Name()) }()
	vr := newVerifyingReader(io.LimitReader(r, size+1))
	if _, err := io.Copy(f, vr); err != nil {
		return err
	}
	if err := vr.check(sha, size); err != nil {
		return err
	}
	mp, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: &s.cfg.ObjectBucket, Key: &key, ContentType: aws.String(mediaType),
	})
	if err != nil {
		return err
	}
	abort := func() {
		_, _ = s.client.AbortMultipartUpload(context.WithoutCancel(ctx), &s3.AbortMultipartUploadInput{
			Bucket: &s.cfg.ObjectBucket, Key: &key, UploadId: mp.UploadId})
	}
	var parts []types.CompletedPart
	for off, n := int64(0), int32(1); off < size; off, n = off+MultipartThreshold, n+1 {
		length := min(int64(MultipartThreshold), size-off)
		out, err := s.client.UploadPart(ctx, &s3.UploadPartInput{
			Bucket: &s.cfg.ObjectBucket, Key: &key, UploadId: mp.UploadId, PartNumber: aws.Int32(n),
			Body: io.NewSectionReader(f, off, length), ContentLength: aws.Int64(length),
		})
		if err != nil {
			abort()
			return err
		}
		parts = append(parts, types.CompletedPart{ETag: out.ETag, PartNumber: aws.Int32(n)})
	}
	_, err = s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: &s.cfg.ObjectBucket, Key: &key, UploadId: mp.UploadId,
		MultipartUpload: &types.CompletedMultipartUpload{Parts: parts},
	})
	if err != nil {
		abort()
	}
	return err
}

// Head returns size and media type.
func (s *S3) Head(ctx context.Context, tenant, sha string) (ObjectInfo, error) {
	if err := checkSHA(sha); err != nil {
		return ObjectInfo{}, err
	}
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.cfg.ObjectBucket, Key: aws.String(ObjectKey(tenant, sha))})
	if err != nil {
		if isNotFound(err) {
			return ObjectInfo{}, ErrNotFound
		}
		return ObjectInfo{}, err
	}
	return ObjectInfo{Size: aws.ToInt64(out.ContentLength), MediaType: aws.ToString(out.ContentType)}, nil
}

// Get streams an object, optionally a byte range.
func (s *S3) Get(ctx context.Context, tenant, sha string, rng *Range) (io.ReadCloser, error) {
	if err := checkSHA(sha); err != nil {
		return nil, err
	}
	in := &s3.GetObjectInput{Bucket: &s.cfg.ObjectBucket, Key: aws.String(ObjectKey(tenant, sha))}
	if rng != nil {
		in.Range = aws.String(fmt.Sprintf("bytes=%d-%d", rng.Start, rng.End))
	}
	out, err := s.client.GetObject(ctx, in)
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out.Body, nil
}

// PresignGet returns a short-lived GET URL for one object.
func (s *S3) PresignGet(ctx context.Context, tenant, sha string, ttl time.Duration) (string, error) {
	if err := checkSHA(sha); err != nil {
		return "", err
	}
	if ttl <= 0 || ttl > MaxPresignTTL {
		ttl = MaxPresignTTL
	}
	req, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: &s.cfg.ObjectBucket, Key: aws.String(ObjectKey(tenant, sha)),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", err
	}
	return req.URL, nil
}

// Delete removes a raw object.
func (s *S3) Delete(ctx context.Context, tenant, sha string) error {
	if err := checkSHA(sha); err != nil {
		return err
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.cfg.ObjectBucket, Key: aws.String(ObjectKey(tenant, sha))})
	return err
}

// PutManifest writes a manifest document (immutable, content-addressed key).
func (s *S3) PutManifest(ctx context.Context, key string, data []byte, contentType string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.cfg.ManifestBucket, Key: &key, Body: bytes.NewReader(data),
		ContentLength: aws.Int64(int64(len(data))), ContentType: &contentType,
	})
	return err
}

// GetManifest reads a manifest document.
func (s *S3) GetManifest(ctx context.Context, key string) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.cfg.ManifestBucket, Key: &key})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer func() { _ = out.Body.Close() }()
	return io.ReadAll(out.Body)
}

// DeleteManifest removes a manifest document; only GC calls it.
func (s *S3) DeleteManifest(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.cfg.ManifestBucket, Key: &key})
	return err
}

// ListManifests visits manifest keys under prefix.
func (s *S3) ListManifests(ctx context.Context, prefix string, fn func(string, time.Time) error) error {
	p := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: &s.cfg.ManifestBucket, Prefix: &prefix})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return err
		}
		for _, o := range page.Contents {
			if err := fn(aws.ToString(o.Key), aws.ToTime(o.LastModified)); err != nil {
				return err
			}
		}
	}
	return nil
}

// Ping checks both buckets are reachable.
func (s *S3) Ping(ctx context.Context) error {
	for _, b := range []string{s.cfg.ObjectBucket, s.cfg.ManifestBucket} {
		if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(b)}); err != nil {
			return fmt.Errorf("head bucket: %w", err)
		}
	}
	return nil
}

// EnsureBuckets creates both buckets if missing (dev and tests only; in
// compose a minio-init job does this, in prod Terraform does).
func (s *S3) EnsureBuckets(ctx context.Context) error {
	for _, b := range []string{s.cfg.ObjectBucket, s.cfg.ManifestBucket} {
		if _, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(b)}); err == nil {
			continue
		}
		if _, err := s.client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(b)}); err != nil {
			return err
		}
	}
	return nil
}
