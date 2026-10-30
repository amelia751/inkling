//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/gc"
	"studio.local/versioning/internal/manifests"
)

// GC mark: the reachable set contains every root (acceptance row 7). With
// history and branch retention set to ~0, each commit below is kept alive
// by exactly one kind of root, so dropping any root kind from Mark fails the
// test: live branch heads, releases, open reviews, checkout leases and
// legal holds (artifact and repository). A second tenant with the default
// retention covers the history-retention window. A commit held by nothing
// must not be reachable, so the set is not simply "everything".
func TestGCMarkReachableCoversAllRoots(t *testing.T) {
	e := newEnv(t, with("HISTORY_RETENTION", "1ms"), with("BRANCH_RETENTION", "1ms"))
	repo, main := e.createRepo("gc-roots")

	live := e.branch(repo, "work/live", main)
	live = e.must(e.commit(alice, repo, "work/live", live, e.putManifest(repo, manifest([]manifests.Sample{e.image("live", "a")}))), 201).str("commit_oid")

	rel, relImg := e.isolatedCommit(repo, main, "work/rel", "rel")
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v1", "commit_oid": rel},
		"Idempotency-Key", idem()), 201)

	// An open review whose source branch was deleted afterwards: only the
	// review's source_oid keeps the commit.
	revBranch := e.branch(repo, "work/rev", main)
	revImg := e.image("rev", "a")
	rev := e.must(e.commit(alice, repo, "work/rev", revBranch, e.putManifest(repo, manifest([]manifests.Sample{revImg}))), 201).str("commit_oid")
	review := e.openReview(alice, repo, "work/rev", "main")
	e.must(e.do(alice, "DELETE", "/internal/v1/repos/"+repo+"/branches?name=work/rev&expected_head="+rev, nil), 200)

	lease, leaseImg := e.isolatedCommit(repo, main, "work/lease", "lease")
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/checkouts", map[string]any{"ref": lease, "include_urls": false}), 200)

	dead, deadImg := e.isolatedCommit(repo, main, "work/dead", "dead")

	held := e.image("held", "never-committed")
	_ = e.putManifest(repo, manifest([]manifests.Sample{held})) // registered, never committed
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/legal-holds",
		map[string]any{"artifact_sha256": held.Objects[0].SHA256, "reason_code": "litigation"}), 201)

	repoHeld, mainHeld := e.createRepo("gc-held")
	heldCommit, heldImg := e.isolatedCommit(repoHeld, mainHeld, "work/held", "repo-held")
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repoHeld+"/legal-holds", map[string]any{"reason_code": "audit"}), 201)

	time.Sleep(50 * time.Millisecond) // past the 1ms retention windows
	ctx := context.Background()
	reach, err := e.app.GC.Mark(ctx, e.tenant)
	if err != nil {
		t.Fatal(err)
	}

	for what, oid := range map[string]string{"main head": main, "live branch head": live, "release": rel,
		"open review source": rev, "checkout lease": lease} {
		if !reach.Commits[repo][oid] {
			t.Errorf("%s %s not in the reachable set", what, oid)
		}
	}
	if !reach.Commits[repoHeld][heldCommit] {
		t.Error("commit of a legally held repository not reachable")
	}
	if src := review.str("source_oid"); src != rev {
		t.Fatalf("review source %s, want %s", src, rev)
	}
	for what, img := range map[string]manifests.Sample{"release": relImg, "review": revImg, "lease": leaseImg} {
		if !e.artifactReachable(reach, img) {
			t.Errorf("artifact of the %s commit not reachable", what)
		}
	}
	if !e.artifactReachable(reach, held) {
		t.Error("legally held artifact not reachable")
	}
	if !e.artifactReachable(reach, heldImg) {
		t.Error("artifact of a legally held repository not reachable")
	}

	// Negative control: nothing holds the dead commit.
	if reach.Commits[repo][dead] {
		t.Error("an unrooted commit is reachable: the test cannot tell roots apart")
	}
	if e.artifactReachable(reach, deadImg) {
		t.Error("an unrooted commit's artifact is reachable")
	}

	assertRootsCovered(t, e, reach)
	assertClosed(t, e, reach)

	// History retention: with the default 30-day window every recent commit
	// is a root, including one on a deleted branch.
	e2 := newEnv(t, with("BRANCH_RETENTION", "1ms"))
	repo2, main2 := e2.createRepo("gc-retention")
	recent, recentImg := e2.isolatedCommit(repo2, main2, "work/recent", "recent")
	time.Sleep(50 * time.Millisecond)
	reach2, err := e2.app.GC.Mark(ctx, e2.tenant)
	if err != nil {
		t.Fatal(err)
	}
	if !reach2.Commits[repo2][recent] || !e2.artifactReachable(reach2, recentImg) {
		t.Error("a commit inside the history retention window is not reachable")
	}
	assertRootsCovered(t, e2, reach2)
	assertClosed(t, e2, reach2)
}

// isolatedCommit commits one new image on a fresh branch from base, then
// deletes the branch, so only another root can keep the commit alive.
func (e *env) isolatedCommit(repo, base, branch, seed string) (string, manifests.Sample) {
	e.t.Helper()
	h := e.branch(repo, branch, base)
	img := e.image(seed, seed)
	oid := e.must(e.commit(alice, repo, branch, h, e.putManifest(repo, manifest([]manifests.Sample{img}))), 201).str("commit_oid")
	e.must(e.do(alice, "DELETE", "/internal/v1/repos/"+repo+"/branches?name="+branch+"&expected_head="+oid, nil), 200)
	return oid, img
}

func (e *env) artifactReachable(r *gc.Reachable, s manifests.Sample) bool {
	e.t.Helper()
	ctx := context.Background()
	conn := e.admin()
	defer conn.Close(ctx)
	var id string
	if err := conn.QueryRow(ctx, "SELECT id FROM versioning.artifacts WHERE tenant_id = $1 AND content_sha256 = $2",
		e.tenant, s.Objects[0].SHA256).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return r.Artifacts[id] || r.ArtifactSHAs[s.Objects[0].SHA256]
}

func (e *env) admin() *pgx.Conn {
	e.t.Helper()
	conn, err := pgx.Connect(context.Background(), pg.AdminURL)
	if err != nil {
		e.t.Fatal(err)
	}
	return conn
}

// assertRootsCovered recomputes the GC roots straight from the tables (as
// the superuser, independent of Mark's queries) and checks each is marked.
func assertRootsCovered(t *testing.T, e *env, r *gc.Reachable) {
	t.Helper()
	ctx := context.Background()
	conn := e.admin()
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `
		SELECT 'branch', repo_id::text, commit_oid FROM versioning.repo_branches
		  WHERE tenant_id = $1 AND (deleted_at IS NULL OR retain_until > now())
		UNION ALL SELECT 'release', repo_id::text, commit_oid FROM versioning.dataset_releases WHERE tenant_id = $1
		UNION ALL SELECT 'review source', repo_id::text, source_oid FROM versioning.review_requests
		  WHERE tenant_id = $1 AND status NOT IN ('MERGED', 'CLOSED')
		UNION ALL SELECT 'review target', repo_id::text, checked_target_oid FROM versioning.review_requests
		  WHERE tenant_id = $1 AND status NOT IN ('MERGED', 'CLOSED') AND checked_target_oid IS NOT NULL
		UNION ALL SELECT 'lease', repo_id::text, commit_oid FROM versioning.checkout_leases WHERE tenant_id = $1 AND expires_at > now()
		UNION ALL SELECT 'retention', repo_id::text, oid FROM versioning.repo_commits
		  WHERE tenant_id = $1 AND created_at > now() - make_interval(secs => $2)
		UNION ALL SELECT 'repo hold', c.repo_id::text, c.oid FROM versioning.repo_commits c
		  JOIN versioning.legal_holds h ON h.repo_id = c.repo_id AND h.artifact_id IS NULL AND h.released_at IS NULL
		  WHERE c.tenant_id = $1`, e.tenant, e.app.Cfg.HistoryRetention.Seconds())
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for rows.Next() {
		var kind, repo, oid string
		if err := rows.Scan(&kind, &repo, &oid); err != nil {
			t.Fatal(err)
		}
		kinds[kind]++
		if !r.Commits[repo][oid] {
			t.Errorf("%s root %s/%s not in the reachable set", kind, repo, oid)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	var holds []string
	hr, err := conn.Query(ctx, `SELECT artifact_id::text FROM versioning.legal_holds
		WHERE tenant_id = $1 AND artifact_id IS NOT NULL AND released_at IS NULL`, e.tenant)
	if err != nil {
		t.Fatal(err)
	}
	for hr.Next() {
		var id string
		_ = hr.Scan(&id)
		holds = append(holds, id)
	}
	hr.Close()
	for _, id := range holds {
		kinds["artifact hold"]++
		if !r.Artifacts[id] {
			t.Errorf("legally held artifact %s not reachable", id)
		}
	}
	t.Logf("roots checked by kind: %v", kinds)
}

// assertClosed checks the reachable set is closed: every reachable commit's
// parents are reachable, its manifest root is marked, and every artifact the
// root references is marked.
func assertClosed(t *testing.T, e *env, r *gc.Reachable) {
	t.Helper()
	ctx := context.Background()
	conn := e.admin()
	defer conn.Close(ctx)
	for repo, commits := range r.Commits {
		for oid := range commits {
			var root string
			var parents []string
			if err := conn.QueryRow(ctx, `SELECT manifest_root, parent_oids FROM versioning.repo_commits WHERE repo_id = $1 AND oid = $2`,
				repo, oid).Scan(&root, &parents); err != nil {
				t.Fatalf("reachable commit %s/%s: %v", repo, oid, err)
			}
			for _, p := range parents {
				if !commits[p] {
					t.Errorf("parent %s of reachable %s not reachable", p, oid)
				}
			}
			if !r.Roots[repo][root] {
				t.Errorf("manifest root %s of reachable %s not marked", root, oid)
			}
			arts, err := conn.Query(ctx, `SELECT artifact_id::text FROM versioning.artifact_references WHERE repo_id = $1 AND root_hash = $2`, repo, root)
			if err != nil {
				t.Fatal(err)
			}
			for arts.Next() {
				var id string
				_ = arts.Scan(&id)
				if !r.Artifacts[id] {
					t.Errorf("artifact %s of reachable root %s not marked", id, root)
				}
			}
			arts.Close()
		}
	}
}

// principal is the service-level identity matching e.token(a).
func (e *env) principal(a authn.Actor) *authn.Principal {
	p := &authn.Principal{TenantID: e.tenant, ProjectID: e.project, Actor: a, Scopes: map[string]bool{}, RequestID: "test"}
	for _, s := range authn.AllScopes {
		p.Scopes[s] = true
	}
	return p
}

func jsonArray(raw []byte, v any) error { return json.Unmarshal(raw, v) }
