//go:build integration

package integration

import (
	"strings"
	"testing"

	"studio.local/versioning/internal/authn"
	"studio.local/versioning/internal/manifests"
)

// todo12 Milestone 1 (todo12-versioning): the pipeline service, signing with
// its own key, may create pipeline/* branches and commits, open reviews and
// merge reviews that carry a current approval; nothing else.
var pipeline = authn.Actor{ID: authn.PipelineActorID, Kind: authn.KindService}

func approvalOf(r resp, reviewer string) map[string]any {
	apps, _ := r.Body["approvals"].([]any)
	for _, a := range apps {
		m, _ := a.(map[string]any)
		if m["reviewer_id"] == reviewer {
			return m
		}
	}
	return nil
}

func TestPipelinePrincipal(t *testing.T) {
	e := newEnv(t)
	repo, main := e.createRepo("pipeline-principal")
	base := []manifests.Sample{e.image("s0", "a")}
	main = e.seed(repo, main, manifest(base))
	root := e.must(e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/manifests", manifest(append(base, e.image("s1", "b")))), 201).str("manifest_root")
	digest := "sha256:" + strings.Repeat("d", 64)

	// It can't move main, or write any branch outside pipeline/*.
	if r := e.commit(pipeline, repo, "main", main, root); r.Status != 403 {
		t.Fatalf("pipeline committed to main: %d %s", r.Status, r.Raw)
	}
	if r := e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/branches", map[string]any{"name": "work/x", "from": main}, "Idempotency-Key", idem()); r.Status != 403 {
		t.Fatalf("pipeline created work/x: %d", r.Status)
	}
	if r := e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/reverts", map[string]any{"branch": "main", "expected_head": main,
		"target": main, "message": "x", "idempotency_key": idem()}); r.Status != 403 {
		t.Fatalf("pipeline reverted main: %d", r.Status)
	}
	if r := e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/releases", map[string]any{"tag": "v1", "commit": main}, "Idempotency-Key", idem()); r.Status != 403 {
		t.Fatalf("pipeline released: %d", r.Status)
	}

	// It reads manifests to build a candidate, never signed object URLs.
	if r := e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/checkouts", map[string]any{"ref": main}); r.Status != 403 {
		t.Fatalf("pipeline got signed URLs: %d", r.Status)
	}
	co := e.must(e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/checkouts", map[string]any{"ref": main, "include_urls": false}), 200)
	if s, _ := co.Body["samples"].([]any); len(s) != 1 {
		t.Fatalf("manifest checkout: %s", co.Raw)
	}

	// Its own candidate branch, commit and review work.
	h := e.must(e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/branches", map[string]any{"name": "pipeline/run_1", "from": "main"},
		"Idempotency-Key", idem()), 201).str("commit_oid")
	cand := e.must(e.commit(pipeline, repo, "pipeline/run_1", h, root), 201).str("commit_oid")
	if r := e.do(pipeline, "POST", "/internal/v1/repos/"+repo+"/reviews", map[string]any{"title": "x", "source_branch": "main",
		"target_branch": "pipeline/run_1"}, "Idempotency-Key", idem()); r.Status != 403 {
		t.Fatalf("pipeline opened a review from main: %d", r.Status)
	}
	rv := e.passChecks(repo, e.openReview(pipeline, repo, "pipeline/run_1", "main"), "READY")
	id := rv.str("id")
	path := "/internal/v1/repos/" + repo + "/reviews/" + id

	// It can't approve, and can't merge an unapproved review.
	if r := e.do(pipeline, "POST", path+"/approve", map[string]any{"source_oid": cand}); r.Status != 403 {
		t.Fatalf("pipeline approved: %d", r.Status)
	}
	if r := e.do(pipeline, "POST", path+"/merge", map[string]any{"idempotency_key": idem()}); r.Status != 409 || r.str("code") != "not_ready" {
		t.Fatalf("pipeline merged unapproved: %d %s", r.Status, r.Raw)
	}
	if r := e.do(pipeline, "POST", path+"/close", nil); r.Status != 403 {
		t.Fatalf("pipeline closed a review: %d", r.Status)
	}

	// A human approval is bound to the candidate digest and the checked target.
	a1 := approvalOf(e.must(e.do(bob, "POST", path+"/approve", map[string]any{"source_oid": cand, "candidate_digest": digest}), 200), "user-bob")
	if a1 == nil || a1["id"] == "" || a1["candidate_digest"] != digest || a1["approved_target_oid"] != main {
		t.Fatalf("approval record: %v", a1)
	}
	again := approvalOf(e.must(e.do(bob, "POST", path+"/approve", map[string]any{"source_oid": cand, "candidate_digest": digest}), 200), "user-bob")
	if again["id"] != a1["id"] {
		t.Fatal("a repeated approval minted a new id")
	}
	if r := e.do(bob, "POST", path+"/approve", map[string]any{"source_oid": cand, "candidate_digest": "sha256:" + strings.Repeat("e", 64)}); r.Status != 409 {
		t.Fatalf("approval rebound to another digest: %d", r.Status)
	}

	// main moves: the approval is stale. Versioning re-checks the review, and the
	// pipeline still can't merge until someone approves against the new head.
	hb := e.branch(repo, "work/other", main)
	e.must(e.commit(alice, repo, "work/other", hb, e.putManifest(repo, manifest(append(base, e.image("s2", "c"))))), 201)
	other := e.passChecks(repo, e.openReview(alice, repo, "work/other", "main"), "READY")
	e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+other.str("id")+"/approve", map[string]any{"source_oid": other.str("source_oid")}), 200)
	newMain := e.must(e.merge(repo, other), 200).str("merge_oid")
	if r := e.do(pipeline, "POST", path+"/merge", map[string]any{"idempotency_key": idem()}); r.Status != 409 {
		t.Fatalf("pipeline merged onto a moved main: %d %s", r.Status, r.Raw)
	}
	rv = e.waitReview(repo, id, "CHECKING", "READY", "CONFLICTED")
	if rv.str("checked_target_oid") != newMain {
		t.Fatalf("review not re-checked against the new head: %s", rv.Raw)
	}
	e.passChecks(repo, rv, "READY")
	if r := e.do(pipeline, "POST", path+"/merge", map[string]any{"idempotency_key": idem()}); r.Status != 409 || r.str("code") != "stale_head" {
		t.Fatalf("pipeline merged with a stale approval: %d %s", r.Status, r.Raw)
	}
	a2 := approvalOf(e.must(e.do(bob, "POST", path+"/approve", map[string]any{"source_oid": cand, "candidate_digest": digest}), 200), "user-bob")
	if a2["id"] == a1["id"] || a2["approved_target_oid"] != newMain {
		t.Fatalf("re-approval after the target moved: %v (was %v)", a2, a1)
	}
	m := e.must(e.do(pipeline, "POST", path+"/merge", map[string]any{"idempotency_key": idem()}), 200)
	if m.str("status") != "MERGED" {
		t.Fatalf("not merged: %s", m.Raw)
	}
}
