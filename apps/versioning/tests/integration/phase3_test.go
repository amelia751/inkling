//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/manifests"
	"studio.local/versioning/internal/storage"
)

type capture struct {
	mu     sync.Mutex
	events map[string][]byte
	subj   []string
}

func (c *capture) Publish(_ context.Context, subject, id string, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.events == nil {
		c.events = map[string][]byte{}
	}
	c.events[id] = payload
	c.subj = append(c.subj, subject)
	return nil
}

// The outbox relay delivers each event once per run and carries ids only.
func TestOutboxRelay(t *testing.T) {
	e := newEnv(t)
	cap := &capture{}
	e.app.Relay.Publisher = cap
	repo, main := e.createRepo("outbox")
	h := e.branch(repo, "work/o", main)
	e.must(e.commit(alice, repo, "work/o", h, e.putManifest(repo, manifest([]manifests.Sample{e.image("s1", "a")}))), 201)
	r := e.openReview(alice, repo, "work/o", "main")
	n, err := e.app.Relay.RunOnce(context.Background())
	if err != nil || n == 0 {
		t.Fatalf("relay delivered %d: %v", n, err)
	}
	again, _ := e.app.Relay.RunOnce(context.Background())
	if again != 0 {
		t.Fatalf("relay re-delivered %d events", again)
	}
	seen := map[string]bool{}
	for _, s := range cap.subj {
		seen[s] = true
	}
	for _, want := range []string{"versioning.commit.created", "versioning.branch.updated", "versioning.review.opened"} {
		if !seen[want] {
			t.Errorf("missing event %s (got %v)", want, cap.subj)
		}
	}
	for _, p := range cap.events {
		if strings.Contains(string(p), r.str("title")) {
			t.Fatal("event payload carries free text")
		}
		var ev map[string]any
		_ = json.Unmarshal(p, &ev)
		if ev["tenant_id"] != e.tenant {
			continue // the relay serves every tenant; earlier tests left events too
		}
		if ev["event_id"] == "" || ev["version"] != 1.0 || ev["repo_id"] == "" {
			t.Fatalf("bad envelope %s", p)
		}
	}
}

// The reconciler rebuilds a stale ref projection from repo_branches and
// promotes staged artifacts; nothing pages for healthy data (row 7).
func TestReconcileRepairsProjection(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("reconcile")
	h := e.branch(repo, "work/r", main)
	e.must(e.commit(alice, repo, "work/r", h, e.putManifest(repo, manifest([]manifests.Sample{e.image("s1", "a")}))), 201)
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, pg.OwnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE versioning.git_refs SET target = repeat('0', 40) WHERE repo_id = $1 AND name = 'refs/heads/work/r'`, repo); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, `INSERT INTO versioning.git_refs (tenant_id, repo_id, name, target) VALUES ($1, $2, 'refs/heads/ghost', repeat('1', 40))`, e.tenant, repo); err != nil {
		t.Fatal(err)
	}
	fs, err := e.app.Reconcile.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	repaired := 0
	for _, f := range fs {
		if f.Repo == repo && f.Kind == "stale_ref_projection" && f.Repaired {
			repaired++
		}
		if f.Severity == "page" {
			t.Fatalf("paged on healthy data: %+v", f)
		}
	}
	if repaired != 2 {
		t.Fatalf("want 2 repaired projections, got %d (%+v)", repaired, fs)
	}
	var target string
	_ = conn.QueryRow(ctx, `SELECT target FROM versioning.git_refs WHERE repo_id = $1 AND name = 'refs/heads/work/r'`, repo).Scan(&target)
	if target == strings.Repeat("0", 40) {
		t.Fatal("projection not rebuilt")
	}
	// Missing Git objects for a published commit page someone.
	if _, err := conn.Exec(ctx, `DELETE FROM versioning.git_objects WHERE repo_id = $1 AND type = 2`, repo); err != nil {
		t.Fatal(err)
	}
	// A fresh instance has a cold object cache, so it reads Postgres.
	e2 := newEnv(t)
	fs, err = e2.app.Reconcile.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	paged := false
	for _, f := range fs {
		if f.Repo == repo && f.Severity == "page" {
			paged = true
		}
	}
	if !paged {
		t.Fatal("missing objects of a published commit did not page")
	}
}

// GC keeps every reachable object and sweeps only expired unreferenced ones
// (row 7: reachable set contains all roots).
func TestGCKeepsReachableSweepsOrphans(t *testing.T) {
	e := newEnv(t, with("STAGED_TTL", "1ms"))
	repo, main := e.createRepo("gc")
	h := e.branch(repo, "work/g", main)
	kept := e.image("kept", "a")
	head := e.must(e.commit(alice, repo, "work/g", h, e.putManifest(repo, manifest([]manifests.Sample{kept}))), 201).str("commit_oid")
	orphan := e.image("orphan", "never-committed")
	_ = e.putManifest(repo, manifest([]manifests.Sample{orphan})) // registered, never committed
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "keep", "commit_oid": head},
		"Idempotency-Key", idem()), 201)
	ctx := context.Background()
	eventually(t, "promotion of committed artifacts", func() bool {
		a := e.do(alice, "GET", "/internal/v1/artifacts/"+kept.Objects[0].SHA256, nil)
		return a.str("status") == "available"
	})
	if _, err := e.app.Reconcile.RunOnce(ctx); err != nil { // expires the orphan's staged upload
		t.Fatal(err)
	}
	reach, err := e.app.GC.Mark(ctx, e.tenant)
	if err != nil {
		t.Fatal(err)
	}
	for _, oid := range []string{main, head} {
		if !reach.Commits[repo][oid] {
			t.Fatalf("root %s not in the reachable set", oid)
		}
	}
	dry, err := e.app.GC.Sweep(ctx, e.tenant, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(dry.Artifacts, orphan.Objects[0].SHA256) || contains(dry.Artifacts, kept.Objects[0].SHA256) {
		t.Fatalf("dry-run plan wrong: %+v", dry)
	}
	if a := e.do(alice, "GET", "/internal/v1/artifacts/"+orphan.Objects[0].SHA256, nil); a.str("status") == "deleted" {
		t.Fatal("dry run deleted something")
	}
	if _, err := e.app.GC.Sweep(ctx, e.tenant, 0, false); err != nil {
		t.Fatal(err)
	}
	if a := e.do(alice, "GET", "/internal/v1/artifacts/"+orphan.Objects[0].SHA256, nil); a.str("status") != "deleted" {
		t.Fatalf("orphan not swept: %s", a.Raw)
	}
	verifyCheckout(t, e, repo, "tag:keep", 1)
	verifyCheckout(t, e, repo, "main", 0)
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// Chunked manifests: a 1% update touches few buckets, diffs compare chunk
// hashes first, large diffs go async, partial checkout reads only matching
// buckets, and a merge reuses unchanged chunks.
func TestChunkedManifestsDiffMergePartialCheckout(t *testing.T) {
	e := newEnv(t, with("CHUNK_THRESHOLD", "50"), with("SYNC_DIFF_MAX_ENTRIES", "2"))
	repo, main := e.createRepo("chunked")
	var samples []manifests.Sample
	for i := 0; i < 400; i++ {
		s := e.image(fmt.Sprintf("img-%04d", i), "v0")
		if i%40 == 0 {
			s.Split = "test"
		}
		samples = append(samples, s)
	}
	h := e.branch(repo, "work/base", main)
	root := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/manifests", manifest(samples)), 201)
	if root.str("format") != "chunked-v1" {
		t.Fatalf("expected chunked format, got %s", root.str("format"))
	}
	base := e.must(e.commit(alice, repo, "work/base", h, root.str("manifest_root")), 201).str("commit_oid")
	ha := e.branch(repo, "work/a", base)
	hb := e.branch(repo, "work/b", base)
	edit := func(idx []int, seed string) []manifests.Sample {
		out := append([]manifests.Sample(nil), samples...)
		for _, i := range idx {
			out[i] = e.image(samples[i].SampleID, seed)
			out[i].Split = samples[i].Split
		}
		return out
	}
	headA := e.must(e.commit(alice, repo, "work/a", ha, e.putManifest(repo, manifest(edit([]int{1, 2, 3, 4}, "a")))), 201).str("commit_oid")
	e.must(e.commit(bob, repo, "work/b", hb, e.putManifest(repo, manifest(edit([]int{200, 201}, "b")))), 201)

	d := e.do(alice, "GET", "/internal/v1/repos/"+repo+"/diff?base="+base+"&head="+headA, nil)
	if d.Status != 202 {
		t.Fatalf("large diff should be async, got %d %s", d.Status, d.Raw)
	}
	var page resp
	eventually(t, "diff job", func() bool {
		page = e.do(alice, "GET", "/internal/v1/repos/"+repo+"/diff-jobs/"+d.str("job_id"), nil)
		return page.Status == 200
	})
	if cb := page.Body["changed_buckets"].(float64); cb < 1 || cb > 4 {
		t.Fatalf("changed buckets %v", cb)
	}
	if page.Body["summary"].(map[string]any)["sample.replaced"] != 4.0 {
		t.Fatalf("summary %v", page.Body["summary"])
	}

	// Partial checkout: one sample id reads one bucket; a split filter reads
	// only buckets the index says hold test samples.
	one := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/checkouts",
		map[string]any{"ref": headA, "filter": map[string]any{"sample_ids": []string{"img-0002"}}}), 200)
	if one.Body["buckets_read"].(float64) != 1 || len(one.Body["samples"].([]any)) != 1 {
		t.Fatalf("partial checkout: %v buckets, %d samples", one.Body["buckets_read"], len(one.Body["samples"].([]any)))
	}
	byte0 := fetch(t, one.Body["objects"].([]any)[0].(map[string]any)["url"].(string))
	if !bytes.Contains(byte0, []byte(":a")) {
		t.Fatal("checkout returned the old object")
	}
	split := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/checkouts",
		map[string]any{"ref": headA, "filter": map[string]any{"splits": []string{"test"}}, "include_urls": false}), 200)
	if n := len(split.Body["samples"].([]any)); n != 10 || split.Body["buckets_read"].(float64) > 10 {
		t.Fatalf("split checkout: %d samples from %v buckets", n, split.Body["buckets_read"])
	}

	// Merge b into a (unprotected target): disjoint edits auto-merge and
	// untouched buckets keep their chunk hash.
	r := e.openReview(bob, repo, "work/b", "work/a")
	r = e.passChecks(repo, r, "READY")
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve", map[string]any{"source_oid": r.str("source_oid")}), 200)
	m := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/merge", map[string]any{"idempotency_key": idem()}), 200)
	mc := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+m.str("merge_oid"), nil), 200)
	ac := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+headA, nil), 200)
	ra, err := e.app.Svc.Manifests.LoadRoot(context.Background(), e.tenant, repo, ac.str("manifest_root"))
	if err != nil {
		t.Fatal(err)
	}
	rm, err := e.app.Svc.Manifests.LoadRoot(context.Background(), e.tenant, repo, mc.str("manifest_root"))
	if err != nil {
		t.Fatal(err)
	}
	same, diff := 0, 0
	for b, hsh := range ra.Buckets {
		if rm.Buckets[b] == hsh {
			same++
		} else {
			diff++
		}
	}
	if diff == 0 || diff > 2 || same < len(ra.Buckets)-2 {
		t.Fatalf("merge rewrote %d buckets, reused %d", diff, same)
	}
	for _, id := range []string{"img-0001", "img-0200"} {
		b := manifests.Bucket(id)
		part, _ := e.app.Svc.Manifests.LoadBuckets(context.Background(), e.tenant, repo, rm, []int{b})
		ok := false
		for _, s := range part.Samples {
			if s.SampleID == id && s.Objects[0].SHA256 != samples[mustIdx(id)].Objects[0].SHA256 {
				ok = true
			}
		}
		if !ok {
			t.Fatalf("merged manifest lost the edit to %s", id)
		}
	}
}

func mustIdx(id string) int {
	var n int
	fmt.Sscanf(id, "img-%04d", &n)
	return n
}

// Objects over 64 MiB stream through a verified temp file and multipart upload.
func TestLargeArtifactMultipart(t *testing.T) {
	if testing.Short() {
		t.Skip("large upload")
	}
	e := newEnv(t)
	size := storage.MultipartThreshold + 3<<20
	data := bytes.Repeat([]byte("0123456789abcdef"), size/16)
	h := sha256.Sum256(data)
	sha := hex.EncodeToString(h[:])
	e.must(e.do(alice, "PUT", "/internal/v1/artifacts/"+sha, data, "X-Media-Type", "application/octet-stream", "Content-Type", "application/octet-stream"), 201)
	got, err := e.app.Blobs.Head(context.Background(), e.tenant, sha)
	if err != nil || got.Size != int64(len(data)) {
		t.Fatalf("head: %v %+v", err, got)
	}
	// A body that does not match its declared hash is rejected and invisible.
	bad := append([]byte{}, data[:1024]...)
	r := e.do(alice, "PUT", "/internal/v1/artifacts/"+strings.Repeat("ab", 32), bad, "X-Media-Type", "application/octet-stream", "Content-Type", "application/octet-stream")
	if r.Status != 422 {
		t.Fatalf("hash mismatch accepted: %d %s", r.Status, r.Raw)
	}
	if _, err := e.app.Blobs.Head(context.Background(), e.tenant, strings.Repeat("ab", 32)); err == nil {
		t.Fatal("mismatched object became visible")
	}
}
