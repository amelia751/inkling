//go:build integration

package integration

import (
	"context"
	"testing"

	"studio.local/versioning/internal/manifests"
)

// todo10 Phase 2: the Studio definition (`.studio/`) rides along with the
// dataset. Annotation commits keep it, a revert restores an old one, a merge
// carries it into main, a release pins it and GC keeps it.
func TestStudioDefinitionTravelsWithTheDataset(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("studio")
	const br = "work/alice/studio"
	head := e.branch(repo, br, main)
	samples := []manifests.Sample{e.image("s-1", "v0")}
	root := e.putManifest(repo, manifest(samples))

	v1 := map[string]string{
		"plugins.lock.json":            `{"lockfileVersion":1,"plugins":[]}`,
		"tasks/scans/environment.json": `{"extends":"preset:image-2d","task":"classification"}`,
		"tasks/scans/README.md":        "# Scans\n\nClassify each scan.\n",
	}
	commitStudio := func(expected string, files map[string]string) resp {
		return e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", map[string]any{"branch": br, "expected_head": expected,
			"manifest_root": root, "message": "Task setup saved", "idempotency_key": idem(), "studio": map[string]any{"files": files}}), 201)
	}
	studioAt := func(ref string) resp {
		return e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/studio?ref="+ref, nil), 200)
	}
	c1 := commitStudio(head, v1)
	tree1 := c1.str("studio_tree")
	if len(tree1) != 40 {
		t.Fatalf("commit has no studio tree: %s", c1.Raw)
	}
	got := studioAt(c1.str("commit_oid"))
	if got.str("studio_tree") != tree1 || got.Body["files"].(map[string]any)["tasks/scans/README.md"] != v1["tasks/scans/README.md"] {
		t.Fatalf("studio read back: %s", got.Raw)
	}
	// Not canonical JSON is refused.
	bad := e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", map[string]any{"branch": br, "expected_head": c1.str("commit_oid"),
		"manifest_root": root, "message": "x", "idempotency_key": idem(), "studio": map[string]any{"files": map[string]string{"plugins.lock.json": `{ "lockfileVersion": 1 }`}}})
	e.must(bad, 400)

	// An annotation commit without `studio` keeps the parent's tree.
	c2 := e.must(e.commit(alice, repo, br, c1.str("commit_oid"), root), 201)
	if c2.str("studio_tree") != tree1 {
		t.Fatalf("annotation commit dropped the studio: %s", c2.Raw)
	}
	// Same files, same tree: the tree id names the definition.
	c3 := commitStudio(c2.str("commit_oid"), v1)
	if c3.str("studio_tree") != tree1 {
		t.Fatalf("identical studio got a different tree: %s vs %s", c3.str("studio_tree"), tree1)
	}
	v2 := map[string]string{"plugins.lock.json": v1["plugins.lock.json"], "tasks/scans/environment.json": `{"extends":"preset:image-2d","task":"detection"}`}
	c4 := commitStudio(c3.str("commit_oid"), v2)
	tree2 := c4.str("studio_tree")
	if tree2 == tree1 || studioAt(br).str("studio_tree") != tree2 {
		t.Fatalf("changed studio kept the old tree")
	}
	// Restoring an old version restores its Studio setup.
	rv := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/reverts", map[string]any{"branch": br, "expected_head": c4.str("commit_oid"),
		"target_oid": c1.str("commit_oid"), "idempotency_key": idem()}), 201)
	if rv.str("studio_tree") != tree1 || studioAt(br).Body["files"].(map[string]any)["tasks/scans/environment.json"] != v1["tasks/scans/environment.json"] {
		t.Fatalf("revert didn't restore the studio: %s", rv.Raw)
	}
	cm := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+rv.str("commit_oid"), nil), 200)
	if cm.str("studio_tree") != tree1 {
		t.Fatalf("commit view lacks studio_tree: %s", cm.Raw)
	}

	// Through review into main, then a release pins it.
	r := e.openReview(alice, repo, br, "main")
	r = e.passChecks(repo, r, "READY")
	e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve", map[string]any{"source_oid": r.str("source_oid")}), 200)
	m := e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/merge", map[string]any{"idempotency_key": idem()}), 200)
	if studioAt("main").str("studio_tree") != tree1 {
		t.Fatalf("merge didn't carry the studio into main")
	}
	rel := e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v1", "commit_oid": m.str("merge_oid")},
		"Idempotency-Key", idem()), 201)
	if rel.str("studio_tree") != tree1 {
		t.Fatalf("release doesn't pin the studio: %s", rel.Raw)
	}
	pinned := studioAt("tag:v1")
	if pinned.str("studio_tree") != tree1 || len(pinned.Body["files"].(map[string]any)) != 3 {
		t.Fatalf("tag:v1 studio: %s", pinned.Raw)
	}
	// Later edits on a branch never change what v1 pinned.
	h := e.branch(repo, "work/alice/next", "main")
	e.must(e.do(alice, "POST", "/internal/v1/repos/"+repo+"/commits", map[string]any{"branch": "work/alice/next", "expected_head": h,
		"manifest_root": root, "message": "drop", "idempotency_key": idem(), "studio": map[string]any{"files": map[string]string{}}}), 201)
	if studioAt("work/alice/next").str("studio_tree") != "" || studioAt("tag:v1").str("studio_tree") != tree1 {
		t.Fatalf("an empty studio must remove the tree on the branch only")
	}

	// GC marks every object of the studio subtree reachable.
	g := e.app.Svc.Git.Open(context.Background(), e.tenant, repo)
	ids, err := g.ObjectIDs(rv.str("commit_oid"))
	if err != nil || len(ids) < 2+4+1+4 { // commit, tree, 4 pointer blobs, .studio tree, lock + tasks/ + scans/ + 2 files
		t.Fatalf("object ids %d: %v", len(ids), err)
	}
}
