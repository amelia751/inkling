//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/manifests"
)

// Repo -> branch -> 100 commits -> tag -> checkout, verifying every byte hash
// (todo4 1.8; acceptance rows 2 and 5).
func TestRepoBranchHundredCommitsTagCheckout(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("images")
	samples := []manifests.Sample{e.image("s-000", "v0")}
	head := e.branch(repo, "work/alice/images", main)
	for i := 1; i <= 100; i++ {
		samples = append(samples, e.image(fmt.Sprintf("s-%03d", i), "v0"))
		root := e.putManifest(repo, manifest(samples))
		head = e.must(e.commit(alice, repo, "work/alice/images", head, root), 201).str("commit_oid")
	}
	hist := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits?ref=work/alice/images&limit=1000", nil), 200)
	if n := len(hist.Body["items"].([]any)); n != 102 { // 100 commits + 1 branch base + init
		if n != 101 {
			t.Fatalf("history has %d commits", n)
		}
	}
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v1", "commit_oid": head},
		"Idempotency-Key", idem()), 201)
	// Tags are immutable.
	r := e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v1", "commit_oid": main},
		"Idempotency-Key", idem())
	e.must(r, 409)
	verifyCheckout(t, e, repo, "tag:v1", 101)
}

// verifyCheckout pages through a checkout and checks every signed object.
func verifyCheckout(t *testing.T, e *env, repo, ref string, wantSamples int) {
	t.Helper()
	cursor, seen, verified := "", 0, 0
	for {
		body := map[string]any{"ref": ref, "limit": 40}
		if cursor != "" {
			body["cursor"] = cursor
		}
		c := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/checkouts", body), 200)
		seen += len(c.Body["samples"].([]any))
		for _, o := range c.Body["objects"].([]any) {
			obj := o.(map[string]any)
			if obj["status"] != "available" && obj["status"] != "staged" {
				t.Fatalf("object %v status %v", obj["sha256"], obj["status"])
			}
			if got := shaOf(fetch(t, obj["url"].(string))); got != obj["sha256"] {
				t.Fatalf("object bytes hash %s, want %s", got, obj["sha256"])
			}
			verified++
		}
		cursor = c.str("next_cursor")
		if cursor == "" {
			break
		}
	}
	if seen != wantSamples || verified < wantSamples {
		t.Fatalf("checkout saw %d samples, verified %d objects; want %d", seen, verified, wantSamples)
	}
}

// Exactly one of 20 concurrent commits on the same expected head wins; the
// rest get 409 with the current head (spec §5; acceptance row 4).
func TestTwentyConcurrentCommits(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("concurrency")
	head := e.branch(repo, "work/race", main)
	roots := make([]string, 20)
	for i := range roots {
		roots[i] = e.putManifest(repo, manifest([]manifests.Sample{e.image("s", fmt.Sprint(i))}))
	}
	var ok, conflict atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := e.commit(alice, repo, "work/race", head, roots[i])
			switch {
			case r.Status == 201:
				ok.Add(1)
			case r.Status == 409 && r.str("code") == "stale_head" && r.str("current_head") != "":
				conflict.Add(1)
			default:
				t.Errorf("unexpected %d %s", r.Status, r.Raw)
			}
		}(i)
	}
	wg.Wait()
	if ok.Load() != 1 || conflict.Load() != 19 {
		t.Fatalf("ok=%d conflict=%d", ok.Load(), conflict.Load())
	}

	// Identical idempotent retries all return the same response.
	cur := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/branches", nil), 200)
	var tip string
	for _, b := range cur.Body["items"].([]any) {
		if b.(map[string]any)["name"] == "work/race" {
			tip = b.(map[string]any)["commit_oid"].(string)
		}
	}
	key := idem()
	body := map[string]any{"branch": "work/race", "expected_head": tip, "manifest_root": roots[0], "message": "retry", "idempotency_key": key}
	results := make([]resp, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", body)
		}(i)
	}
	wg.Wait()
	first := ""
	for _, r := range results {
		e.must(r, 201)
		if first == "" {
			first = r.str("commit_oid")
		}
		if r.str("commit_oid") != first {
			t.Fatalf("idempotent retries returned different commits: %s vs %s", first, r.str("commit_oid"))
		}
	}
	// Same key, different request -> 422.
	body["message"] = "different"
	r := e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", body)
	if r.Status != 422 || r.str("code") != "idempotency_mismatch" {
		t.Fatalf("want 422 idempotency_mismatch, got %d %s", r.Status, r.Raw)
	}
}

// A crash between the Git write and the CAS: the retry succeeds and the
// orphaned commit shows up in the reconcile report (todo4 1.8).
func TestCrashBetweenGitWriteAndCAS(t *testing.T) {
	e := newEnv(t)
	e.app.Reconcile.OrphanGrace = 0
	repo, main := e.createRepo("crash")
	head := e.branch(repo, "work/crash", main)
	root := e.putManifest(repo, manifest([]manifests.Sample{e.image("s1", "a")}))
	var crashed atomic.Bool
	e.app.Svc.Failpoint = func(name string) error {
		if name == "commit.after-git-write" && crashed.CompareAndSwap(false, true) {
			return errors.New("injected crash")
		}
		return nil
	}
	body := map[string]any{"branch": "work/crash", "expected_head": head, "manifest_root": root, "message": "m", "idempotency_key": idem()}
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", body), 500)
	// Git commit times have one-second resolution; wait so the retry writes
	// a distinct commit and the crashed one is a true orphan.
	time.Sleep(1100 * time.Millisecond)
	r := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", body), 201)
	findings, err := e.app.Reconcile.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	orphans := 0
	for _, f := range findings {
		if f.Kind == "orphaned_git_commit" && f.Repo == repo {
			orphans++
			if f.Subject == r.str("commit_oid") {
				t.Fatal("published commit reported as orphan")
			}
		}
		if f.Severity == "page" {
			t.Fatalf("reconciler paged: %+v", f)
		}
	}
	if orphans != 1 {
		t.Fatalf("want 1 orphaned commit in the reconcile report, got %d", orphans)
	}
}

// Restarting Postgres keeps branches and versions (MVP exit criterion 1).
func TestRefsSurviveRestart(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("restart")
	head := e.branch(repo, "work/r", main)
	root := e.putManifest(repo, manifest([]manifests.Sample{e.image("s1", "a")}))
	head = e.must(e.commit(alice, repo, "work/r", head, root), 201).str("commit_oid")
	e.close()

	ctx := context.Background()
	if err := pg.Container.Stop(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := pg.Container.Start(ctx); err != nil {
		t.Fatal(err)
	}
	admin, _ := pg.Container.ConnectionString(ctx, "sslmode=disable")
	pg.AdminURL = admin
	pg.AppURL = replaceUser(admin, "versioning_app", "app-test-pw")
	pg.OwnerURL = replaceUser(admin, "versioning_owner", "owner-test-pw")
	eventually(t, "postgres back after restart", func() bool {
		c, err := pgx.Connect(ctx, pg.AppURL)
		if err != nil {
			return false
		}
		defer c.Close(ctx)
		return c.Ping(ctx) == nil
	})

	e2 := newEnv(t)
	e2.tenant, e2.project = e.tenant, e.project
	got := e2.must(e2.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+head, nil), 200)
	if got.str("manifest_root") != root {
		t.Fatal("commit lost its manifest root across restart")
	}
	verifyCheckout(t, e2, repo, "work/r", 1)
}

// Cross-tenant references are denied even with known hashes, and RLS hides
// rows from versioning_app under the wrong tenant (acceptance row 8).
func TestCrossTenantDenied(t *testing.T) {
	a := newEnv(t)
	repoA, _ := a.createRepo("a")
	img := a.image("secret", "x")
	b := newEnv(t)
	repoB, _ := b.createRepo("b")
	r := b.do(alice, "POST", "/internal/v1/repos/"+repoB+"/manifests", manifest([]manifests.Sample{img}))
	if r.Status != 422 {
		t.Fatalf("foreign artifact accepted: %d %s", r.Status, r.Raw)
	}
	// Tenant B cannot even see tenant A's repository.
	b.must(b.do(alice, "GET", "/internal/v1/repos/"+repoA, nil), 404)

	// Raw SQL as versioning_app with the wrong tenant sees nothing.
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, pg.AppURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	tx, _ := conn.Begin(ctx)
	defer tx.Rollback(ctx)
	_, _ = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", b.tenant)
	var n int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM versioning.artifacts WHERE content_sha256 = $1", img.Objects[0].SHA256).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("RLS leaked %d artifact rows across tenants", n)
	}
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM versioning.dataset_repositories WHERE id = $1", repoA).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("RLS leaked a repository across tenants")
	}
	_ = tx.Rollback(ctx)
	// Without any tenant set, nothing is visible either.
	var none int
	_ = conn.QueryRow(ctx, "SELECT count(*) FROM versioning.git_objects").Scan(&none)
	if none != 0 {
		t.Fatalf("RLS leaked %d git objects with no tenant set", none)
	}
	// And versioning_app cannot bypass RLS.
	var bypass bool
	_ = conn.QueryRow(ctx, "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user").Scan(&bypass)
	if bypass {
		t.Fatal("versioning_app has BYPASSRLS")
	}
}

func TestProtectedMainAndBranchRules(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("protected")
	root := e.putManifest(repo, manifest([]manifests.Sample{e.image("s1", "a")}))
	r := e.commit(alice, repo, "main", main, root)
	if r.Status != 403 || r.str("code") != "protected_branch" {
		t.Fatalf("direct commit to main: %d %s", r.Status, r.Raw)
	}
	for _, bad := range []string{"HEAD", "a..b", "x//y", "a@{1}", "trailing/", "x.lock", "Upper", "-x", "a\x01b"} {
		r := e.do(alice, "POST", "/internal/v1/repos/"+repo+"/branches", map[string]any{"name": bad, "from": main}, "Idempotency-Key", idem())
		if r.Status != 400 {
			t.Errorf("branch %q accepted: %d", bad, r.Status)
		}
	}
	e.must(e.do(alice, "DELETE", "/internal/v1/repos/"+repo+"/branches?name=main&expected_head="+main, nil), 403)
	// Agents may only commit to work/agent-* branches.
	h := e.branch(repo, "work/alice/x", main)
	if r := e.commit(agent, repo, "work/alice/x", h, root); r.Status != 403 {
		t.Fatalf("agent committed outside work/agent-*: %d", r.Status)
	}
	h = e.branch(repo, "work/agent-1/x", main)
	e.must(e.commit(agent, repo, "work/agent-1/x", h, root), 201)
}

func TestUnauthenticated(t *testing.T) {
	e := newEnv(t)
	res, err := e.srv.Client().Get(e.srv.URL + "/internal/v1/repos/" + e.tenant)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("want 401, got %d", res.StatusCode)
	}
	h, _ := e.srv.Client().Get(e.srv.URL + "/healthz")
	h.Body.Close()
	if h.StatusCode != 200 {
		t.Fatal("healthz must not need auth")
	}
	rz, _ := e.srv.Client().Get(e.srv.URL + "/readyz")
	rz.Body.Close()
	if rz.StatusCode != 200 {
		t.Fatalf("readyz: %d", rz.StatusCode)
	}
}

func replaceUser(raw, user, pw string) string {
	u, _ := url.Parse(raw)
	u.User = url.UserPassword(user, pw)
	return u.String()
}
