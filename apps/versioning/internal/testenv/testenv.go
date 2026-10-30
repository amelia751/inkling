// Package testenv starts throwaway Postgres and MinIO containers for
// integration tests and wires the versioning schema with real roles.
package testenv

import (
	"bytes"
	"context"
	"io"
	"net/url"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"studio.local/versioning/internal/migrate"
)

// Postgres holds connection strings for one migrated database.
type Postgres struct {
	Container *tcpostgres.PostgresContainer
	AdminURL  string
	OwnerURL  string
	AppURL    string // versioning_app: DML only, subject to RLS
}

const (
	ownerPassword = "owner-test-pw"
	appPassword   = "app-test-pw"
)

// StartPostgres starts Postgres 17, bootstraps roles and runs migrations.
func StartPostgres(ctx context.Context, tb testing.TB) *Postgres {
	tb.Helper()
	c, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("studio"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		tb.Fatalf("start postgres: %v", err)
	}
	tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
	admin, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		tb.Fatal(err)
	}
	p := &Postgres{Container: c, AdminURL: admin,
		OwnerURL: withUser(admin, "versioning_owner", ownerPassword),
		AppURL:   withUser(admin, "versioning_app", appPassword)}
	if err := migrate.Bootstrap(ctx, admin, ownerPassword, appPassword); err != nil {
		tb.Fatal(err)
	}
	if err := migrate.Up(ctx, p.OwnerURL); err != nil {
		tb.Fatal(err)
	}
	return p
}

func withUser(raw, user, pw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	u.User = url.UserPassword(user, pw)
	return u.String()
}

// S3 holds connection details for an S3-compatible server. MinIO no longer
// publishes container images, so tests (and compose) use RustFS, an
// Apache-2.0, MinIO-compatible server; the adapter is the same S3 client.
type S3 struct {
	Container testcontainers.Container
	Endpoint  string
	AccessKey string
	SecretKey string
}

// S3Image is the pinned S3-compatible test server.
const S3Image = "rustfs/rustfs:1.0.4"

// StartS3 starts the S3-compatible server.
func StartS3(ctx context.Context, tb testing.TB) *S3 {
	tb.Helper()
	const key, secret = "testaccess", "testsecret-123"
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        S3Image,
			ExposedPorts: []string{"9000/tcp"},
			Env:          map[string]string{"RUSTFS_ACCESS_KEY": key, "RUSTFS_SECRET_KEY": secret},
			WaitingFor:   wait.ForListeningPort("9000/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		tb.Fatalf("start s3: %v", err)
	}
	tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
	ep, err := c.PortEndpoint(ctx, "9000/tcp", "http")
	if err != nil {
		tb.Fatal(err)
	}
	return &S3{Container: c, Endpoint: ep, AccessKey: key, SecretKey: secret}
}

// CopyBuckets copies every object from each source bucket to its destination
// bucket (backup/restore drills).
func CopyBuckets(ctx context.Context, s *S3, pairs map[string]string) error {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s.AccessKey, s.SecretKey, "")))
	if err != nil {
		return err
	}
	c := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(s.Endpoint)
		o.UsePathStyle = true
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	for src, dst := range pairs {
		if _, err := c.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(dst)}); err != nil {
			return err
		}
		p := s3.NewListObjectsV2Paginator(c, &s3.ListObjectsV2Input{Bucket: aws.String(src)})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				return err
			}
			for _, o := range page.Contents {
				out, err := c.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(src), Key: o.Key})
				if err != nil {
					return err
				}
				body, err := io.ReadAll(out.Body)
				_ = out.Body.Close()
				if err != nil {
					return err
				}
				if _, err := c.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(dst), Key: o.Key, Body: bytes.NewReader(body)}); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
