//go:build integration

// Package integration exercises the service end to end over HTTP against real
// Postgres and MinIO containers (todo4 1.8, 2.5, Phase 7).
package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"studio.local/versioning/internal/app"
	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
	"studio.local/versioning/internal/testenv"
)

var (
	pg     *testenv.Postgres
	minioC *testenv.S3
	signer *authn.Signer
	pubKey ed25519.PublicKey
	// The pipeline service's own key (kid "pipeline", todo12).
	pipeSigner *authn.Signer
	pipePub    ed25519.PublicKey
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	t := &testing.T{}
	pg = testenv.StartPostgres(ctx, tbMain{t})
	minioC = testenv.StartS3(ctx, tbMain{t})
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	pubKey = pub
	signer = &authn.Signer{Key: priv, KID: "test", Issuer: "api", Audience: "versioning"}
	pp, pk, _ := ed25519.GenerateKey(rand.Reader)
	pipePub = pp
	pipeSigner = &authn.Signer{Key: pk, KID: authn.PipelineKID, Issuer: authn.PipelineIssuer, Audience: "versioning"}
	code := m.Run()
	for _, f := range cleanups {
		f()
	}
	os.Exit(code)
}

var cleanups []func()

// tbMain adapts testing.T for TestMain, where no *testing.T exists.
type tbMain struct{ *testing.T }

func (tbMain) Helper()                        {}
func (tbMain) Cleanup(f func())               { cleanups = append(cleanups, f) }
func (tbMain) Fatal(args ...any)              { panic(fmt.Sprint(args...)) }
func (tbMain) Fatalf(format string, a ...any) { panic(fmt.Sprintf(format, a...)) }

// env is one wired service instance for a test.
type env struct {
	t       *testing.T
	app     *app.App
	srv     *httptest.Server
	tenant  string
	project string
	cancel  context.CancelFunc
}

type envOpt func(map[string]string)

func newEnv(t *testing.T, opts ...envOpt) *env {
	t.Helper()
	vars := map[string]string{
		"VERSIONING_DATABASE_URL":         pg.AppURL,
		"VERSIONING_JWT_PUBLIC_KEY_FILE":  "unused",
		"VERSIONING_OBJECT_ENDPOINT":      minioC.Endpoint,
		"VERSIONING_S3_ACCESS_KEY_ID":     minioC.AccessKey,
		"VERSIONING_S3_SECRET_ACCESS_KEY": minioC.SecretKey,
		"VERSIONING_OBJECT_BUCKET":        "test-objects",
		"VERSIONING_MANIFEST_BUCKET":      "test-manifests",
		"VERSIONING_CHUNK_THRESHOLD":      "10000",
	}
	for _, o := range opts {
		o(vars)
	}
	cfg, err := config.FromEnv(config.Naming{ResourcePrefix: "test"}, func(k string) (string, bool) {
		v, ok := vars[k]
		return v, ok
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s3, err := storage.NewS3(ctx, storage.S3Config{Endpoint: cfg.ObjectEndpoint, Region: cfg.ObjectRegion, PathStyle: true,
		AccessKeyID: cfg.S3AccessKeyID, SecretKey: cfg.S3SecretKey, ObjectBucket: cfg.ObjectBucket,
		ManifestBucket: cfg.ManifestBucket, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := s3.EnsureBuckets(ctx); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if n, _ := config.LoadNaming(); config.Env(n, "VERSIONING_TEST_VERBOSE") != "" {
		log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	a, err := app.Build(ctx, cfg, log, app.Options{Blobs: s3,
		Verifier: authn.NewStaticVerifier(map[string]ed25519.PublicKey{"test": pubKey, authn.PipelineKID: pipePub}, "versioning", "api")})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.River.Start(ctx); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler)
	e := &env{t: t, app: a, srv: srv, tenant: ids.New(), project: ids.New(), cancel: cancel}
	t.Cleanup(e.close)
	return e
}

func (e *env) close() {
	e.srv.Close()
	stopCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()
	_ = e.app.River.Stop(stopCtx)
	e.cancel()
	e.app.Close()
}

func with(k, v string) envOpt { return func(m map[string]string) { m["VERSIONING_"+k] = v } }

// actor identities.
var (
	alice  = authn.Actor{ID: "user-alice", Kind: authn.KindUser}
	bob    = authn.Actor{ID: "user-bob", Kind: authn.KindUser}
	carol  = authn.Actor{ID: "user-carol", Kind: authn.KindUser}
	agent  = authn.Actor{ID: "agent-1", Kind: authn.KindAgent, OnBehalfOf: "user-alice"}
	worker = authn.Actor{ID: "svc-worker", Kind: authn.KindService}
)

func (e *env) token(a authn.Actor) string {
	if a.ID == authn.PipelineActorID {
		tok, err := pipeSigner.Token(e.tenant, e.project, a, []string{authn.ScopeRead, authn.ScopeWrite, authn.ScopeReview, authn.ScopeMerge}, "")
		if err != nil {
			e.t.Fatal(err)
		}
		return tok
	}
	tok, err := signer.Token(e.tenant, e.project, a, authn.AllScopes, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return tok
}

type resp struct {
	Status int
	Body   map[string]any
	Raw    []byte
}

func (r resp) str(path ...string) string {
	var v any = r.Body
	for _, p := range path {
		m, _ := v.(map[string]any)
		v = m[p]
	}
	s, _ := v.(string)
	return s
}

func (e *env) do(a authn.Actor, method, path string, body any, headers ...string) resp {
	e.t.Helper()
	var rd io.Reader
	if b, ok := body.([]byte); ok {
		rd = bytes.NewReader(b)
	} else if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("Authorization", "Bearer "+e.token(a))
	if _, ok := body.([]byte); !ok && body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	out := resp{Status: res.StatusCode, Raw: raw}
	_ = json.Unmarshal(raw, &out.Body)
	return out
}

func (e *env) must(r resp, status int) resp {
	e.t.Helper()
	if r.Status != status {
		e.t.Fatalf("want %d, got %d: %s", status, r.Status, r.Raw)
	}
	return r
}

func idem() string { return "k-" + ids.New() }

func shaOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// createRepo returns repo id and the main head.
func (e *env) createRepo(name string) (string, string) {
	r := e.must(e.do(alice, "POST", "/internal/v1/repos", map[string]any{"name": name}, "Idempotency-Key", idem()), 201)
	return r.str("id"), r.str("head")
}

func (e *env) putArtifact(content []byte, media string) string {
	sha := shaOf(content)
	r := e.do(alice, "PUT", "/internal/v1/artifacts/"+sha, content, "X-Media-Type", media, "Content-Type", "application/octet-stream")
	if r.Status != 201 && r.Status != 200 {
		e.t.Fatalf("put artifact: %d %s", r.Status, r.Raw)
	}
	return sha
}

func (e *env) putRevision(rev *manifests.AnnotationRevision) string {
	return e.must(e.do(alice, "POST", "/internal/v1/annotation-revisions", rev), 201).str("ref")
}

func (e *env) putManifest(repo string, m *manifests.Manifest) string {
	return e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/manifests", m), 201).str("manifest_root")
}

func (e *env) branch(repo, name, from string) string {
	return e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/branches", map[string]any{"name": name, "from": from},
		"Idempotency-Key", idem()), 201).str("commit_oid")
}

func (e *env) commit(a authn.Actor, repo, branch, expected, root string) resp {
	return e.do(a, "POST", "/internal/v1/repos/"+repo+"/commits", map[string]any{"branch": branch, "expected_head": expected,
		"manifest_root": root, "message": "edit", "idempotency_key": idem()})
}

// image builds a 2-D image sample backed by a real uploaded object.
func (e *env) image(id string, seed string) manifests.Sample {
	content := []byte("png-bytes:" + id + ":" + seed)
	sha := e.putArtifact(content, "image/png")
	return manifests.Sample{SampleID: id, Modality: "image2d", Width: 100, Height: 100, Split: "train",
		Objects: []manifests.ObjectRef{{Role: "image", SHA256: sha, SizeBytes: int64(len(content)), MediaType: "image/png"}}}
}

func box(ann, sample, class string, x float64) *manifests.AnnotationRevision {
	return &manifests.AnnotationRevision{SchemaVersion: "1", AnnotationID: ann, SampleID: sample, Kind: "box2d",
		ClassID: class, OntologyRev: "ont-1", CoordinateFrame: "pixel", Status: "submitted",
		Geometry: manifests.Geometry{Box: []float64{x, 10, 20, 20}}, Provenance: manifests.Provenance{ActorID: "user-alice"}}
}

func (e *env) ann(rev *manifests.AnnotationRevision) manifests.Annotation {
	ref := e.putRevision(rev)
	return manifests.Annotation{AnnotationID: rev.AnnotationID, RevisionID: "r" + manifests.RefHex(ref)[:20],
		SampleID: rev.SampleID, Kind: rev.Kind, ClassID: rev.ClassID, OntologyRev: rev.OntologyRev, Ref: ref}
}

func ontology() manifests.Ontology {
	return manifests.Ontology{RevisionID: "ont-1", Classes: []manifests.OntologyClass{
		{ClassID: "cat", Name: "Cat"}, {ClassID: "dog", Name: "Dog"}, {ClassID: "bird", Name: "Bird"}}}
}

func manifest(samples []manifests.Sample, anns ...manifests.Annotation) *manifests.Manifest {
	if anns == nil {
		anns = []manifests.Annotation{}
	}
	return &manifests.Manifest{SchemaVersion: "1", Ontology: ontology(), Samples: samples, Annotations: anns}
}

func eventually(t *testing.T, what string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// waitReview polls until the review reaches one of the statuses.
func (e *env) waitReview(repo, id string, statuses ...string) resp {
	e.t.Helper()
	var r resp
	eventually(e.t, "review "+strings.Join(statuses, "|"), func() bool {
		r = e.do(alice, "GET", "/internal/v1/repos/"+repo+"/reviews/"+id, nil)
		for _, s := range statuses {
			if r.str("status") == s {
				return true
			}
		}
		return false
	})
	return r
}

// reportDeid plays the worker's de-identification check.
func (e *env) reportDeid(repo string, review resp, outcome string) resp {
	return e.do(worker, "POST", "/internal/v1/repos/"+repo+"/reviews/"+review.str("id")+"/checks/deidentification",
		map[string]any{"source_oid": review.str("source_oid"), "target_oid": review.str("checked_target_oid"), "outcome": outcome})
}

func fetch(t *testing.T, url string) []byte {
	t.Helper()
	res, err := http.Get(url) // #nosec G107 -- presigned test URL
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("GET signed url: %d", res.StatusCode)
	}
	b, _ := io.ReadAll(res.Body)
	return b
}

var _ = sync.Mutex{}
