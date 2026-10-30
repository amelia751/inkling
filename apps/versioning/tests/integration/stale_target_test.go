//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/manifests"
)

// twoReadyReviews seeds main and returns two approved READY reviews (work/a
// and work/b into main) that were both checked against the same main head.
func (e *env) twoReadyReviews(name string) (repo, main string, ra, rb resp) {
	e.t.Helper()
	repo, main = e.createRepo(name)
	base := []manifests.Sample{e.image("s0", "a")}
	main = e.seed(repo, main, manifest(base))
	ha := e.branch(repo, "work/a", main)
	hb := e.branch(repo, "work/b", main)
	e.must(e.commit(alice, repo, "work/a", ha, e.putManifest(repo, manifest(append(base, e.image("sa", "a"))))), 201)
	e.must(e.commit(alice, repo, "work/b", hb, e.putManifest(repo, manifest(append(base, e.image("sb", "b"))))), 201)
	ra = e.passChecks(repo, e.openReview(alice, repo, "work/a", "main"), "READY")
	rb = e.passChecks(repo, e.openReview(alice, repo, "work/b", "main"), "READY")
	for _, r := range []resp{ra, rb} {
		if r.str("checked_target_oid") != main {
			e.t.Fatalf("review checked against %s, want main %s", r.str("checked_target_oid"), main)
		}
		e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/approve",
			map[string]any{"source_oid": r.str("source_oid")}), 200)
	}
	return repo, main, ra, rb
}

func (e *env) merge(repo string, r resp) resp {
	return e.do(carol, "POST", "/internal/v1/repos/"+repo+"/reviews/"+r.str("id")+"/merge", map[string]any{"idempotency_key": idem()})
}

func wantStale(t *testing.T, r resp, head string) {
	t.Helper()
	if r.Status != 409 || r.str("code") != "stale_head" {
		t.Fatalf("want 409 stale_head, got %d %s", r.Status, r.Raw)
	}
	if r.str("current_head") != head {
		t.Fatalf("409 current_head %q, want %q", r.str("current_head"), head)
	}
}

// The target head moved after the review's checks passed (here a writer that
// bypassed review invalidation): merging returns 409, the review goes back to
// CHECKING against the new head, and nothing replaces newer work
// (spec §8; acceptance row 4).
func TestMergeStaleTargetAfterChecks(t *testing.T) {
	e := newEnv(t)
	repo, main, ra, rb := e.twoReadyReviews("stale-target")
	moved := ra.str("source_oid") // any newer commit of this repo

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, pg.AdminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, `UPDATE versioning.repo_branches SET commit_oid = $1, generation = generation + 1
		WHERE repo_id = $2 AND name = 'main'`, moved, repo); err != nil {
		t.Fatal(err)
	}

	wantStale(t, e.merge(repo, rb), moved)
	got := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id"), nil), 200)
	if got.str("status") != "CHECKING" {
		t.Fatalf("review is %s after a stale merge, want CHECKING", got.str("status"))
	}
	if got.str("checked_target_oid") != moved {
		t.Fatalf("review re-checks against %s, want the new head %s", got.str("checked_target_oid"), moved)
	}
	if m := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/branches", nil), 200); !branchAt(m, "main", moved) {
		t.Fatalf("main moved by the rejected merge: %s", m.Raw)
	}
	_ = main

	// Once re-checked and re-approved it merges on top of the newer head.
	rb = e.passChecks(repo, got, "READY")
	e.must(e.do(bob, "POST", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id")+"/approve",
		map[string]any{"source_oid": rb.str("source_oid")}), 200)
	merged := e.must(e.merge(repo, rb), 200)
	c := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/commits/"+merged.str("merge_oid"), nil), 200)
	if ps, _ := c.Body["parents"].([]any); len(ps) != 2 || ps[0] != moved {
		t.Fatalf("merge parents %v, want [%s, source]", c.Body["parents"], moved)
	}
}

// The target moves between the READY check and the CAS (another review
// merges while this merge is writing its commit): the CAS fails, the merge
// returns 409 and the review goes back to CHECKING.
func TestMergeStaleTargetAtCAS(t *testing.T) {
	e := newEnv(t)
	repo, main, ra, rb := e.twoReadyReviews("stale-cas")
	var (
		fired    atomic.Bool
		inner    atomic.Int32
		innerOID atomic.Value
	)
	tokCarol := e.token(carol)
	e.app.Svc.Failpoint = func(name string) error {
		if name != "merge.after-git-write" || !fired.CompareAndSwap(false, true) {
			return nil
		}
		// Review A merges first and moves main.
		b, _ := json.Marshal(map[string]any{"idempotency_key": idem()})
		req, _ := http.NewRequest("POST", e.srv.URL+"/internal/v1/repos/"+repo+"/reviews/"+ra.str("id")+"/merge", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+tokCarol)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(res.Body).Decode(&body)
		inner.Store(int32(res.StatusCode))
		innerOID.Store(body["merge_oid"])
		return nil
	}
	r := e.merge(repo, rb)
	if inner.Load() != 200 {
		t.Fatalf("concurrent merge of A: %d", inner.Load())
	}
	headA, _ := innerOID.Load().(string)
	if headA == "" || headA == main {
		t.Fatalf("merge of A did not move main: %q", headA)
	}
	wantStale(t, r, headA)
	got := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/reviews/"+rb.str("id"), nil), 200)
	if got.str("status") != "CHECKING" || got.str("checked_target_oid") != headA {
		t.Fatalf("review B after a lost CAS: status %s target %s", got.str("status"), got.str("checked_target_oid"))
	}
	if m := e.must(e.do(alice, "GET", "/internal/v1/repos/"+repo+"/branches", nil), 200); !branchAt(m, "main", headA) {
		t.Fatalf("main is not at A's merge: %s", m.Raw)
	}
}

func branchAt(r resp, name, oid string) bool {
	items, _ := r.Body["items"].([]any)
	for _, it := range items {
		b, _ := it.(map[string]any)
		if b["name"] == name {
			return b["commit_oid"] == oid
		}
	}
	return false
}
