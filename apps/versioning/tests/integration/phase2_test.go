//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/gitengine"
	"studio.local/versioning/internal/manifests"
)

// openReview opens a review and returns it once checks settle on CHECKING
// with the deid check pending.
func (e *env) openReview(a authn.Actor, repo, src, dst string) resp {
	r := e.must(e.do(a, "POST", "/internal/v1/repos/"+repo+"/reviews", map[string]any{"title": "Review " + src,
		"source_branch": src, "target_branch": dst}, "Idempotency-Key", idem()), 201)
	return r
}

// passChecks reports deid and waits for the review to settle.
func (e *env) passChecks(repo string, r resp, statuses ...string) resp {
	e.t.Helper()
	e.must(e.reportDeid(repo, r, "passed"), 200)
	return e.waitReview(repo, r.str("id"), statuses...)
}

// seed merges an initial dataset into protected main through a review
// (workflow A: initial upload, then v1 visible).
func (e *env) seed(repo, main string, m *manifests.Manifest) string {
	e.t.Helper()
	h := e.branch(repo, "work/seed", main)
	e.must(e.commit(alice, repo, "work/seed", h, e.putManifest(repo, m)), 201)
	r := e.openReview(alice, repo, "work/seed", "main")
	r = e.passChecks(repo, r, "READY")
	e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve",
		map[string]any{"source_oid": r.str("source_oid")}), 200)
	m2 := e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/merge",
		map[string]any{"idempotency_key": idem()}), 200)
	if m2.str("status") != "MERGED" {
		e.t.Fatalf("seed merge: %s", m2.Raw)
	}
	return m2.str("merge_oid")
}

func (e *env) checkoutClass(repo, ref, ann string) string {
	c := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/checkouts", map[string]any{"ref": ref, "include_urls": false}), 200)
	for _, a := range c.Body["annotations"].([]any) {
		m := a.(map[string]any)
		if m["annotation_id"] == ann {
			return m["class_id"].(string)
		}
	}
	return ""
}

// Workflow B: two users edit the same annotation -> conflict -> resolve ->
// merge -> release (todo4 Phase 6 e2e flow B, run here at the service level).
func TestReviewConflictResolveMergeRelease(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("flow-b")
	s1, s2 := e.image("s1", "a"), e.image("s2", "a")
	base := []manifests.Sample{s1, s2}
	main = e.seed(repo, main, manifest(base, e.ann(box("a1", "s1", "cat", 10))))
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v1", "commit_oid": main},
		"Idempotency-Key", idem()), 201)

	ha := e.branch(repo, "work/alice", main)
	hb := e.branch(repo, "work/bob", main)
	e.must(e.commit(alice, repo, "work/alice", ha, e.putManifest(repo, manifest(base, e.ann(box("a1", "s1", "dog", 10))))), 201)
	hb = e.must(e.commit(bob, repo, "work/bob", hb, e.putManifest(repo, manifest(base, e.ann(box("a1", "s1", "bird", 10))))), 201).str("commit_oid")

	ra := e.openReview(alice, repo, "work/alice", "main")
	rb := e.openReview(bob, repo, "work/bob", "main")
	ra = e.passChecks(repo, ra, "READY")

	// Unapproved changes cannot merge to protected main (acceptance row 3).
	r := e.do(carol, "POST", "/internal/v1/repos/"+repo+"/reviews/"+ra.str("id")+"/merge", map[string]any{"idempotency_key": idem()})
	if r.Status != 409 || r.str("code") != "not_ready" {
		t.Fatalf("unapproved merge: %d %s", r.Status, r.Raw)
	}
	// Self-approval and agent approval are rejected.
	approve := map[string]any{"source_oid": ra.str("source_oid")}
	if r := e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reviews/"+ra.str("id")+"/approve", approve); r.Status != 403 {
		t.Fatalf("self approval: %d", r.Status)
	}
	if r := e.do(agent, "POST", "/internal/v1/repos/"+repo+"/reviews/"+ra.str("id")+"/approve", approve); r.Status != 403 {
		t.Fatalf("agent approval: %d", r.Status)
	}
	e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+ra.str("id")+"/approve", approve), 200)
	merged := e.must(e.do(carol, "POST", "/internal/v1/repos/"+repo+"/reviews/"+ra.str("id")+"/merge",
		map[string]any{"idempotency_key": idem()}), 200)
	if merged.str("status") != "MERGED" || merged.str("merge_oid") == "" {
		t.Fatalf("merge A: %s", merged.Raw)
	}
	if got := e.checkoutClass(repo, "main", "a1"); got != "dog" {
		t.Fatalf("after merge A, a1 is %q", got)
	}

	// Review B was re-checked against the new main and now conflicts.
	rb = e.waitReview(repo, rb.str("id"), "CHECKING")
	rb = e.passChecks(repo, rb, "CONFLICTED")
	conf := rb.Body["conflicts"].([]any)
	if len(conf) != 1 || conf[0].(map[string]any)["conflict_key"] != "annotation:a1:class_id" {
		t.Fatalf("conflicts: %v", conf)
	}
	// An approval on B, then a new push to B, clears it (V8).
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id")+"/approve",
		map[string]any{"source_oid": rb.str("source_oid")}), 200)
	hb = e.must(e.commit(bob, repo, "work/bob", hb, e.putManifest(repo,
		manifest([]manifests.Sample{s1, s2, e.image("s3", "b")}, e.ann(box("a1", "s1", "bird", 10))))), 201).str("commit_oid")
	rb = e.waitReview(repo, rb.str("id"), "CHECKING")
	if rb.str("source_oid") != hb {
		t.Fatal("review did not follow the new source head")
	}
	for _, a := range rb.Body["approvals"].([]any) {
		if a.(map[string]any)["approved_source_oid"] != hb {
			t.Fatal("stale approval survived a source push")
		}
	}
	rb = e.passChecks(repo, rb, "CONFLICTED")
	res := e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id")+"/resolutions", map[string]any{
		"source_oid": rb.str("source_oid"), "target_oid": rb.str("checked_target_oid"),
		"resolutions": []map[string]any{{"conflict_key": "annotation:a1:class_id", "choice": "theirs"}}}), 200)
	if res.str("status") != "READY" {
		t.Fatalf("after resolution: %s", res.str("status"))
	}
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id")+"/approve",
		map[string]any{"source_oid": rb.str("source_oid")}), 200)
	mb := e.must(e.do(carol, "POST", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id")+"/merge",
		map[string]any{"idempotency_key": idem()}), 200)
	if got := e.checkoutClass(repo, "main", "a1"); got != "bird" {
		t.Fatalf("after resolution merge, a1 is %q", got)
	}
	// The merge commit has two parents: old main and the source.
	c := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+mb.str("merge_oid"), nil), 200)
	if ps := c.Body["parents"].([]any); len(ps) != 2 || ps[1] != hb || c.str("operation") != "merge" {
		t.Fatalf("merge commit parents %v op %s", ps, c.str("operation"))
	}
	rel := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v2", "commit_oid": mb.str("merge_oid")},
		"Idempotency-Key", idem()), 201)
	if att := rel.Body["attestations"].([]any); len(att) != 1 {
		t.Fatalf("release attestations: %v", att)
	}

	// Every published version is retrievable and its bytes verify (row 5).
	rels := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/releases", nil), 200)
	var list []map[string]any
	_ = json.Unmarshal(rels.Raw, &list)
	if len(list) != 2 {
		t.Fatalf("releases: %d", len(list))
	}
	for _, r := range list {
		want := 2
		if r["tag"] == "v2" {
			want = 3
		}
		verifyCheckout(t, e, repo, "tag:"+r["tag"].(string), want)
	}

	// Audit attributes every merge to an actor and a commit (row 6).
	assertMergesAudited(t, e, repo, 3)

	// The diff between v1 and v2 is semantic: one sample added, one label changed.
	d := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/diff?base="+main+"&head="+mb.str("merge_oid"), nil), 200)
	sum := d.Body["summary"].(map[string]any)
	if sum["sample.added"] != 1.0 || sum["annotation.changed"] != 1.0 {
		t.Fatalf("diff summary %v", sum)
	}
	if strings.Contains(string(d.Raw), "Review ") {
		t.Fatal("diff output leaked free text")
	}
}

func assertMergesAudited(t *testing.T, e *env, repo string, want int) {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, pg.OwnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	rows, err := conn.Query(ctx, `SELECT actor_id, coalesce(commit_oid, '') FROM versioning.audit_events
		WHERE repo_id = $1 AND event_type = 'review.merged'`, repo)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for rows.Next() {
		var actor, commit string
		_ = rows.Scan(&actor, &commit)
		if actor == "" || len(commit) != 40 {
			t.Fatalf("merge audit missing actor/commit: %q %q", actor, commit)
		}
		n++
	}
	if n != want {
		t.Fatalf("want %d merge audit events, got %d", want, n)
	}
}

// Workflow C: an agent proposes on its branch, a human approves, the agent's
// approval and merge attempts are rejected.
func TestAgentProposalNeedsHumanApproval(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("flow-c")
	main = e.seed(repo, main, manifest([]manifests.Sample{e.image("s1", "a")}))
	h := e.branch(repo, "work/agent-1/proposal", main)
	e.must(e.commit(agent, repo, "work/agent-1/proposal", h, e.putManifest(repo,
		manifest([]manifests.Sample{e.image("s1", "a")}, e.ann(box("a9", "s1", "cat", 5))))), 201)
	r := e.openReview(agent, repo, "work/agent-1/proposal", "main")
	r = e.passChecks(repo, r, "READY")
	ap := map[string]any{"source_oid": r.str("source_oid")}
	if x := e.do(agent, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve", ap); x.Status != 403 {
		t.Fatalf("agent self-approval: %d", x.Status)
	}
	// The user the agent acts for cannot approve the agent's proposal either.
	if x := e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve", ap); x.Status != 403 {
		t.Fatalf("on_behalf_of approval: %d", x.Status)
	}
	e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve", ap), 200)
	if x := e.do(agent, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/merge", map[string]any{"idempotency_key": idem()}); x.Status != 403 {
		t.Fatalf("agent merge: %d", x.Status)
	}
	m := e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/merge", map[string]any{"idempotency_key": idem()}), 200)
	if m.str("status") != "MERGED" {
		t.Fatal("not merged")
	}
}

// A failing de-identification check blocks the review.
func TestFailedMandatoryCheckBlocks(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("blocked")
	h := e.branch(repo, "work/x", main)
	e.must(e.commit(alice, repo, "work/x", h, e.putManifest(repo, manifest([]manifests.Sample{e.image("s1", "a")}))), 201)
	r := e.openReview(alice, repo, "work/x", "main")
	e.must(e.reportDeid(repo, r, "failed"), 200)
	e.waitReview(repo, r.str("id"), "BLOCKED")
	// A check report for superseded oids is refused.
	bad := e.do(worker, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/checks/deidentification",
		map[string]any{"source_oid": main, "target_oid": main, "outcome": "passed"})
	if bad.Status != 409 {
		t.Fatalf("stale check report: %d", bad.Status)
	}
}

// Criss-cross history has two merge bases: checks fail and merging is refused
// with 409 multiple_merge_bases (V8; merge table row "criss-cross").
func TestCrissCrossHistory(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("criss")
	ctx := context.Background()
	g := e.app.Svc.Git.Open(ctx, e.tenant, repo)
	root0 := e.putManifest(repo, manifest([]manifests.Sample{e.image("s0", "a")}))
	snap := func(op string) gitengine.Snapshot {
		return gitengine.Snapshot{Dataset: gitengine.DatasetDoc{RepoID: repo, SchemaVersion: "1", ManifestRoot: root0, ManifestFormat: "json-v1", SampleCount: 1},
			Ontology: gitengine.OntologyDoc{RevisionID: "ont-1"}, Policy: gitengine.PolicyDoc{PolicyID: "default"},
			Provenance: gitengine.ProvenanceDoc{Operation: op, ActorID: "user-alice", ActorKind: "user"}}
	}
	now := time.Now()
	x1, _ := g.WriteCommit(snap("commit"), []string{main}, "user-alice", "x1", now)
	y1, _ := g.WriteCommit(snap("commit"), []string{main}, "user-bob", "y1", now.Add(time.Second))
	mx, _ := g.WriteCommit(snap("merge"), []string{x1, y1}, "user-alice", "mx", now.Add(2*time.Second))
	my, _ := g.WriteCommit(snap("merge"), []string{y1, x1}, "user-bob", "my", now.Add(3*time.Second))
	conn, err := pgx.Connect(ctx, pg.OwnerURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	for _, c := range [][2]string{{x1, main}, {y1, main}, {mx, x1}, {my, y1}} {
		if _, err := conn.Exec(ctx, `INSERT INTO versioning.repo_commits (tenant_id, repo_id, oid, manifest_root, author_id, parent_oids)
			VALUES ($1, $2, $3, $4, 'user-alice', ARRAY[$5])`, e.tenant, repo, c[0], root0, c[1]); err != nil {
			t.Fatal(err)
		}
	}
	for _, b := range [][2]string{{"work/x", mx}, {"work/y", my}} {
		if _, err := conn.Exec(ctx, `INSERT INTO versioning.repo_branches (tenant_id, repo_id, name, commit_oid, created_by)
			VALUES ($1, $2, $3, $4, 'user-alice')`, e.tenant, repo, b[0], b[1]); err != nil {
			t.Fatal(err)
		}
	}
	r := e.openReview(alice, repo, "work/x", "work/y")
	r = e.passChecks(repo, r, "BLOCKED")
	found := false
	for _, c := range r.Body["checks"].([]any) {
		cm := c.(map[string]any)
		if cm["name"] == "merge_base" && cm["outcome"] == "failed" {
			found = true
		}
	}
	if !found {
		t.Fatalf("merge_base check did not fail: %s", r.Raw)
	}
	res := e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/resolutions", map[string]any{
		"source_oid": r.str("source_oid"), "target_oid": r.str("checked_target_oid"), "resolutions": []any{}})
	if res.Status != 409 || res.str("code") != "multiple_merge_bases" {
		t.Fatalf("want 409 multiple_merge_bases, got %d %s", res.Status, res.Raw)
	}
}
