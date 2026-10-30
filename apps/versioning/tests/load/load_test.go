//go:build load

// Package load measures the service at scale (todo4 Phase 3): 100k or 1M
// manifest entries with a 1% update -> diff -> merge -> partial checkout, GC
// at 50 branches and 200 releases, and backup/restore with every release
// verified. Run with `make load` (<envPrefix>VERSIONING_LOAD_ENTRIES=1000000 for the 1M run).
package load

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/app"
	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/config"
	"studio.local/versioning/internal/ids"
	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/service"
	"studio.local/versioning/internal/storage"
	"studio.local/versioning/internal/testenv"
)

type result struct {
	Name    string        `json:"name"`
	Entries int           `json:"entries"`
	Elapsed time.Duration `json:"elapsed_ns"`
	Note    string        `json:"note,omitempty"`
}

var results []result

func record(name string, entries int, start time.Time, note string) {
	r := result{Name: name, Entries: entries, Elapsed: time.Since(start), Note: note}
	results = append(results, r)
	fmt.Printf("%-34s %9d entries  %10s  %s\n", name, entries, r.Elapsed.Round(time.Millisecond), note)
}

type harness struct {
	t        *testing.T
	pg       *testenv.Postgres
	s3       *testenv.S3
	a        *app.App
	cfg      *config.Config
	alice    *authn.Principal
	bob      *authn.Principal
	worker   *authn.Principal
	objects  string
	manifest string
}

func principal(tenant, project, id, kind string) *authn.Principal {
	p := &authn.Principal{TenantID: tenant, ProjectID: project, Actor: authn.Actor{ID: id, Kind: kind}, Scopes: map[string]bool{}}
	for _, s := range authn.AllScopes {
		p.Scopes[s] = true
	}
	return p
}

func newHarness(t *testing.T, pg *testenv.Postgres, s3 *testenv.S3, objects, manifestsBucket string) *harness {
	vars := map[string]string{
		"VERSIONING_DATABASE_URL": pg.AppURL, "VERSIONING_JWT_PUBLIC_KEY_FILE": "unused",
		"VERSIONING_OBJECT_ENDPOINT": s3.Endpoint, "VERSIONING_S3_ACCESS_KEY_ID": s3.AccessKey,
		"VERSIONING_S3_SECRET_ACCESS_KEY": s3.SecretKey, "VERSIONING_OBJECT_BUCKET": objects,
		"VERSIONING_MANIFEST_BUCKET": manifestsBucket, "VERSIONING_MAX_COMMIT_ENTRIES": "3000000",
		"VERSIONING_SYNC_DIFF_MAX_ENTRIES": "5000000", "VERSIONING_RATE_CHECKOUT_PER_MINUTE": "100000",
		"VERSIONING_RATE_DIFF_PER_MINUTE": "100000",
	}
	cfg, err := config.FromEnv(config.Naming{ResourcePrefix: "load"}, func(k string) (string, bool) { v, ok := vars[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	blobs, err := storage.NewS3(ctx, storage.S3Config{Endpoint: s3.Endpoint, Region: "us-east-1", PathStyle: true,
		AccessKeyID: s3.AccessKey, SecretKey: s3.SecretKey, ObjectBucket: objects, ManifestBucket: manifestsBucket, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := blobs.EnsureBuckets(ctx); err != nil {
		t.Fatal(err)
	}
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	a, err := app.Build(ctx, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), app.Options{Blobs: blobs,
		Verifier: authn.NewStaticVerifier(map[string]ed25519.PublicKey{"x": pub}, "versioning", "api")})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.River.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = a.River.Stop(c)
		a.Close()
	})
	return &harness{t: t, pg: pg, s3: s3, a: a, cfg: cfg, objects: objects, manifest: manifestsBucket}
}

func (h *harness) tenantFor(tenant, project string) {
	h.alice = principal(tenant, project, "user-alice", authn.KindUser)
	h.bob = principal(tenant, project, "user-bob", authn.KindUser)
	h.worker = principal(tenant, project, "svc-worker", authn.KindService)
}

func fakeSHA(i int) string {
	s := sha256.Sum256([]byte(strconv.Itoa(i)))
	return hex.EncodeToString(s[:])
}

// bulkArtifacts registers n synthetic artifacts directly (bytes are not
// needed for diff/merge; checkout only signs URLs).
func (h *harness) bulkArtifacts(tenant string, from, to int) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, h.pg.OwnerURL)
	if err != nil {
		h.t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `INSERT INTO versioning.tenants (id) VALUES ($1) ON CONFLICT DO NOTHING`, tenant); err != nil {
		h.t.Fatal(err)
	}
	_, err = conn.Exec(ctx, `INSERT INTO versioning.artifacts (id, tenant_id, content_sha256, size_bytes, media_type, storage_key, status, created_by)
		SELECT gen_random_uuid(), $1, encode(sha256(i::text::bytea), 'hex'), length(i::text), 'image/png', 'k', 'available', 'load'
		FROM generate_series($2::int, $3::int - 1) AS i ON CONFLICT DO NOTHING`, tenant, from, to)
	if err != nil {
		h.t.Fatal(err)
	}
}

func sample(i, objectIdx int) manifests.Sample {
	split := "train"
	if i%10 == 0 {
		split = "test"
	}
	return manifests.Sample{SampleID: fmt.Sprintf("s%07d", i), Modality: "image2d", Width: 512, Height: 512, Split: split,
		Objects: []manifests.ObjectRef{{Role: "image", SHA256: fakeSHA(objectIdx), SizeBytes: int64(len(strconv.Itoa(objectIdx))), MediaType: "image/png"}}}
}

// loadEnv reads <envPrefix>VERSIONING_LOAD_<key>; the prefix comes from the naming config.
func loadEnv(key string) string {
	n, err := config.LoadNaming()
	if err != nil {
		return ""
	}
	return config.Env(n, "VERSIONING_LOAD_"+key)
}

func entries() int {
	if v := loadEnv("ENTRIES"); v != "" {
		n, _ := strconv.Atoi(v)
		return n
	}
	return 100_000
}

func TestScaleUpdateDiffMergeCheckout(t *testing.T) {
	ctx := context.Background()
	pg := testenv.StartPostgres(ctx, t)
	s3 := testenv.StartS3(ctx, t)
	h := newHarness(t, pg, s3, "load-objects", "load-manifests")
	n := entries()
	tenant, project := ids.New(), ids.New()
	h.tenantFor(tenant, project)
	h.bulkArtifacts(tenant, 0, 2*n)

	repo, err := h.a.Svc.CreateRepo(ctx, h.alice, service.CreateRepoInput{Name: "scale"}, "k-"+ids.New())
	if err != nil {
		t.Fatal(err)
	}
	repoID := repo.Repo.ID
	base := make([]manifests.Sample, n)
	for i := range base {
		base[i] = sample(i, i)
	}
	mf := func(s []manifests.Sample) *manifests.Manifest {
		return &manifests.Manifest{SchemaVersion: "1", Ontology: manifests.Ontology{RevisionID: "o"},
			Samples: append([]manifests.Sample(nil), s...), Annotations: []manifests.Annotation{}}
	}
	start := time.Now()
	w, err := h.a.Svc.PutManifest(ctx, h.alice, repoID, mf(base))
	if err != nil {
		t.Fatal(err)
	}
	record("put manifest (validate+chunk+index)", n, start, w.Format)
	b, err := h.a.Svc.CreateBranch(ctx, h.alice, repoID, "work/base", repo.Head, false, "k-"+ids.New())
	if err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	c, err := h.a.Svc.Commit(ctx, h.alice, repoID, service.CommitInput{Branch: "work/base", ExpectedHead: b.CommitOid,
		ManifestRoot: w.RootHash, Message: "base", IdempotencyKey: "k-" + ids.New()})
	if err != nil {
		t.Fatal(err)
	}
	record("commit", n, start, "")
	baseOID := c.CommitOID
	ba, _ := h.a.Svc.CreateBranch(ctx, h.alice, repoID, "work/a", baseOID, false, "k-"+ids.New())
	bb, _ := h.a.Svc.CreateBranch(ctx, h.alice, repoID, "work/b", baseOID, false, "k-"+ids.New())

	update := func(offset int) []manifests.Sample {
		out := append([]manifests.Sample(nil), base...)
		for i := offset; i < n; i += 100 { // 1%
			out[i] = sample(i, n+i)
			// Real bytes for the objects a review checks (content = decimal index).
			body := strconv.Itoa(n + i)
			if err := h.a.Blobs.PutStaged(ctx, tenant, fakeSHA(n+i), int64(len(body)), "image/png", bytesReader([]byte(body))); err != nil {
				t.Fatal(err)
			}
		}
		return out
	}
	start = time.Now()
	wa, err := h.a.Svc.PutManifest(ctx, h.alice, repoID, mf(update(0)))
	if err != nil {
		t.Fatal(err)
	}
	ca, err := h.a.Svc.Commit(ctx, h.alice, repoID, service.CommitInput{Branch: "work/a", ExpectedHead: ba.CommitOid,
		ManifestRoot: wa.RootHash, Message: "1% a", IdempotencyKey: "k-" + ids.New()})
	if err != nil {
		t.Fatal(err)
	}
	record("1% update: put manifest + commit", n, start, "")
	wb, _ := h.a.Svc.PutManifest(ctx, h.bob, repoID, mf(update(50)))
	if _, err := h.a.Svc.Commit(ctx, h.bob, repoID, service.CommitInput{Branch: "work/b", ExpectedHead: bb.CommitOid,
		ManifestRoot: wb.RootHash, Message: "1% b", IdempotencyKey: "k-" + ids.New()}); err != nil {
		t.Fatal(err)
	}

	start = time.Now()
	res, err := h.a.Svc.Diff(ctx, h.alice, repoID, baseOID, ca.CommitOID, "", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if res.Result == nil || res.Result.Summary["sample.replaced"] != n/100 {
		t.Fatalf("diff: %+v", res)
	}
	record("diff 1% (sync)", n, start, fmt.Sprintf("changed_buckets=%d", res.Result.ChangedBuckets))

	rv, err := h.a.Svc.CreateReview(ctx, h.bob, repoID, service.CreateReviewInput{Title: "b into a", SourceBranch: "work/b", TargetBranch: "work/a"}, "k-"+ids.New())
	if err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	waitStatus(t, h, repoID, rv.Row.ID, service.StChecking, func(v *service.ReviewView) bool { return len(v.Checks) > 1 })
	record("review checks (merge preview + checks)", n, start, "")
	v, err := h.a.Svc.ReportCheck(ctx, h.worker, repoID, rv.Row.ID, service.CheckDeidentify, rv.Row.SourceOid, deref(rv.Row.CheckedTargetOid), "passed", nil)
	if err != nil || v.Row.Status != service.StReady {
		t.Fatalf("not ready: %v %+v", err, v)
	}
	if _, err := h.a.Svc.Approve(ctx, h.alice, repoID, rv.Row.ID, rv.Row.SourceOid); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	mv, err := h.a.Svc.MergeReview(ctx, h.alice, repoID, rv.Row.ID, "k-"+ids.New(), "")
	if err != nil {
		t.Fatal(err)
	}
	record("three-way merge + commit", n, start, mv.Row.Status)

	var sel []string
	for i := 0; i < 10; i++ {
		sel = append(sel, fmt.Sprintf("s%07d", i*997%n))
	}
	start = time.Now()
	co, err := h.a.Svc.CreateCheckout(ctx, h.alice, repoID, service.CheckoutInput{Ref: "work/a",
		Filter: manifests.Filter{SampleIDs: sel}, IncludeURLs: true, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	record("partial checkout (10 samples)", n, start, fmt.Sprintf("buckets_read=%d", co.BucketsRead))
	start = time.Now()
	sp, err := h.a.Svc.CreateCheckout(ctx, h.alice, repoID, service.CheckoutInput{Ref: "work/a",
		Filter: manifests.Filter{Splits: []string{"test"}}, Limit: 1000})
	if err != nil {
		t.Fatal(err)
	}
	record("filtered checkout (split=test, page)", n, start, fmt.Sprintf("buckets_read=%d samples=%d", sp.BucketsRead, len(sp.Manifest.Samples)))
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	record("peak heap (approx, MiB)", n, time.Now(), strconv.FormatUint(ms.Sys>>20, 10))
	writeResults(t)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func waitStatus(t *testing.T, h *harness, repo, id, status string, extra func(*service.ReviewView) bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Minute)
	for time.Now().Before(deadline) {
		v, err := h.a.Svc.GetReview(context.Background(), h.alice, repo, id)
		if err != nil {
			t.Fatal(err)
		}
		if v.Row.Status == status && extra(v) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("timed out waiting for review")
}

// GC at 50 branches and 200 releases, plus backup/restore verifying every
// release against a fresh database and a copied bucket.
func TestGCScaleAndBackupRestore(t *testing.T) {
	ctx := context.Background()
	pg := testenv.StartPostgres(ctx, t)
	s3 := testenv.StartS3(ctx, t)
	h := newHarness(t, pg, s3, "gc-objects", "gc-manifests")
	tenant, project := ids.New(), ids.New()
	h.tenantFor(tenant, project)
	repo, err := h.a.Svc.CreateRepo(ctx, h.alice, service.CreateRepoInput{Name: "gc"}, "k-"+ids.New())
	if err != nil {
		t.Fatal(err)
	}
	repoID := repo.Repo.ID
	// Real bytes so restore verification hashes actual content.
	var samples []manifests.Sample
	head := repo.Head
	b, _ := h.a.Svc.CreateBranch(ctx, h.alice, repoID, "work/main", head, false, "k-"+ids.New())
	head = b.CommitOid
	for i := 0; i < 200; i++ {
		content := []byte(fmt.Sprintf("bytes-%d", i))
		sum := sha256.Sum256(content)
		sha := hex.EncodeToString(sum[:])
		if _, _, err := h.a.Svc.PutArtifact(ctx, h.alice, sha, "image/png", int64(len(content)), bytesReader(content)); err != nil {
			t.Fatal(err)
		}
		samples = append(samples, manifests.Sample{SampleID: fmt.Sprintf("s%03d", i), Modality: "image2d",
			Objects: []manifests.ObjectRef{{Role: "image", SHA256: sha, SizeBytes: int64(len(content)), MediaType: "image/png"}}})
		w, err := h.a.Svc.PutManifest(ctx, h.alice, repoID, &manifests.Manifest{SchemaVersion: "1", Ontology: manifests.Ontology{RevisionID: "o"},
			Samples: append([]manifests.Sample(nil), samples...), Annotations: []manifests.Annotation{}})
		if err != nil {
			t.Fatal(err)
		}
		c, err := h.a.Svc.Commit(ctx, h.alice, repoID, service.CommitInput{Branch: "work/main", ExpectedHead: head,
			ManifestRoot: w.RootHash, Message: "c", IdempotencyKey: "k-" + ids.New()})
		if err != nil {
			t.Fatal(err)
		}
		head = c.CommitOID
		if _, err := h.a.Svc.CreateRelease(ctx, h.alice, repoID, fmt.Sprintf("r%03d", i), head, "", nil, "k-"+ids.New()); err != nil {
			t.Fatal(err)
		}
		if i < 50 {
			if _, err := h.a.Svc.CreateBranch(ctx, h.alice, repoID, fmt.Sprintf("work/b%02d", i), head, false, "k-"+ids.New()); err != nil {
				t.Fatal(err)
			}
		}
	}
	start := time.Now()
	reach, err := h.a.GC.Mark(ctx, tenant)
	if err != nil {
		t.Fatal(err)
	}
	record("gc mark (50 branches, 200 releases)", 200, start, fmt.Sprintf("commits=%d", len(reach.Commits[repoID])))
	start = time.Now()
	plan, err := h.a.GC.Sweep(ctx, tenant, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	record("gc sweep dry-run", 200, start, fmt.Sprintf("would delete artifacts=%d git=%d", len(plan.Artifacts), plan.GitObjects))
	if len(plan.Artifacts) != 0 || plan.GitObjects != 0 {
		t.Fatalf("GC would delete reachable data: %+v", plan)
	}

	// Backup: pg_dump + bucket copy. Restore: fresh Postgres + copied buckets.
	start = time.Now()
	dump := t.TempDir() + "/versioning.dump"
	code, out, err := pg.Container.Exec(ctx, []string{"pg_dump", "-U", "postgres", "-d", "studio", "-Fc", "-n", "versioning", "-f", "/tmp/v.dump"})
	if err != nil || code != 0 {
		b, _ := io.ReadAll(out)
		t.Fatalf("pg_dump: %d %v %s", code, err, b)
	}
	if err := copyFromContainer(ctx, pg, "/tmp/v.dump", dump); err != nil {
		t.Fatal(err)
	}
	restored := testenv.StartPostgres(ctx, t) // fresh, migrated schema with roles
	if err := restoreInto(ctx, restored, dump); err != nil {
		t.Fatal(err)
	}
	if err := testenv.CopyBuckets(ctx, s3, map[string]string{"gc-objects": "restore-objects", "gc-manifests": "restore-manifests"}); err != nil {
		t.Fatal(err)
	}
	record("backup + restore", 200, start, "")
	h2 := newHarness(t, restored, s3, "restore-objects", "restore-manifests")
	h2.tenantFor(tenant, project)
	start = time.Now()
	rels, err := h2.a.Svc.ListReleases(ctx, h2.alice, repoID)
	if err != nil || len(rels) != 200 {
		t.Fatalf("restored releases: %d %v", len(rels), err)
	}
	verified := 0
	for _, r := range rels {
		co, err := h2.a.Svc.CreateCheckout(ctx, h2.alice, repoID, service.CheckoutInput{Ref: "tag:" + r.Tag, IncludeURLs: false, Limit: 1000})
		if err != nil {
			t.Fatal(err)
		}
		for _, o := range co.Objects {
			rc, err := h2.a.Blobs.Get(ctx, tenant, o.SHA256, nil)
			if err != nil {
				t.Fatalf("release %s object %s: %v", r.Tag, o.SHA256, err)
			}
			hsh := sha256.New()
			_, _ = io.Copy(hsh, rc)
			rc.Close()
			if hex.EncodeToString(hsh.Sum(nil)) != o.SHA256 {
				t.Fatalf("release %s: corrupted object", r.Tag)
			}
			verified++
		}
	}
	record("verify every release after restore", 200, start, fmt.Sprintf("objects verified=%d", verified))
	writeResults(t)
}

func writeResults(t *testing.T) {
	if p := loadEnv("RESULTS"); p != "" {
		b, _ := json.MarshalIndent(results, "", "  ")
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}
