package service

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/jackc/pgx/v5"

	"studio.local/versioning/internal/db"
)

// fakeIdem is an in-memory idempotency_records table keyed like the real
// UNIQUE(tenant, repo, branch, key).
type fakeIdem map[db.GetIdempotencyParams]db.VersioningIdempotencyRecord

func (f fakeIdem) GetIdempotency(_ context.Context, arg db.GetIdempotencyParams) (db.VersioningIdempotencyRecord, error) {
	r, ok := f[arg]
	if !ok {
		return r, pgx.ErrNoRows
	}
	return r, nil
}

func (f fakeIdem) put(tenant string, k idem, resp any) {
	f[db.GetIdempotencyParams{TenantID: tenant, RepoID: k.repo, Branch: k.scope, IdempotencyKey: k.key}] =
		db.VersioningIdempotencyRecord{TenantID: tenant, RepoID: k.repo, Branch: k.scope, IdempotencyKey: k.key,
			RequestHash: k.hash, StatusCode: http.StatusCreated, ResponseJson: mustJSON(resp)}
}

const (
	tenantA = "11111111-1111-1111-1111-111111111111"
	tenantB = "22222222-2222-2222-2222-222222222222"
	repoX   = "33333333-3333-3333-3333-333333333333"
	oidA    = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

func commitReq(msg string) CommitInput {
	return CommitInput{Branch: "work/a", ExpectedHead: oidA, ManifestRoot: "sha256:" + sha64("r"), Message: msg,
		IdempotencyKey: "key-12345678"}
}

func mustIdem(t *testing.T, scope, key string, req any) idem {
	t.Helper()
	k, err := newIdem(repoX, scope, key, req)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestIdempotencyKeyLength(t *testing.T) {
	for _, key := range []string{"", "short", string(make([]byte, 129))} {
		_, err := newIdem(repoX, "work/a", key, commitReq("m"))
		if e, ok := AsError(err); !ok || e.Status != http.StatusBadRequest {
			t.Errorf("key of length %d: want 400, got %v", len(key), err)
		}
	}
}

// The request hash covers the request body, not the key itself, and is
// stable for an identical request.
func TestIdempotencyRequestHash(t *testing.T) {
	a := mustIdem(t, "work/a", "key-12345678", commitReq("m"))
	b := mustIdem(t, "work/a", "key-12345678", commitReq("m"))
	if a.hash != b.hash {
		t.Fatal("identical requests hash differently")
	}
	other := commitReq("m")
	other.IdempotencyKey = "key-different"
	if c := mustIdem(t, "work/a", other.IdempotencyKey, other); c.hash != a.hash {
		t.Fatal("the idempotency key leaked into the request hash")
	}
	if d := mustIdem(t, "work/a", "key-12345678", commitReq("changed")); d.hash == a.hash {
		t.Fatal("a different request has the same hash")
	}
}

func TestIdempotencyMiss(t *testing.T) {
	store := fakeIdem{}
	k := mustIdem(t, "work/a", "key-12345678", commitReq("m"))
	raw, ok, err := lookupIdem(context.Background(), store, tenantA, k)
	if err != nil || ok || raw != nil {
		t.Fatalf("empty store: raw=%s ok=%v err=%v", raw, ok, err)
	}
}

func TestIdempotencyHitReplaysStoredResponse(t *testing.T) {
	store := fakeIdem{}
	k := mustIdem(t, "work/a", "key-12345678", commitReq("m"))
	want := CommitResult{CommitOID: oidA, Branch: "work/a", HeadGeneration: 7, ManifestRoot: "sha256:" + sha64("r"), RequestID: "req-1"}
	store.put(tenantA, k, want)

	retry := mustIdem(t, "work/a", "key-12345678", commitReq("m"))
	raw, ok, err := lookupIdem(context.Background(), store, tenantA, retry)
	if err != nil || !ok {
		t.Fatalf("hit: ok=%v err=%v", ok, err)
	}
	var got CommitResult
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("replayed %+v, want %+v", got, want)
	}
}

func TestIdempotencyMismatchIs422(t *testing.T) {
	store := fakeIdem{}
	store.put(tenantA, mustIdem(t, "work/a", "key-12345678", commitReq("m")), CommitResult{CommitOID: oidA})
	_, ok, err := lookupIdem(context.Background(), store, tenantA, mustIdem(t, "work/a", "key-12345678", commitReq("other")))
	e, isErr := AsError(err)
	if ok || !isErr || e.Status != http.StatusUnprocessableEntity || e.Code != "idempotency_mismatch" {
		t.Fatalf("want 422 idempotency_mismatch, got ok=%v err=%v", ok, err)
	}
}

// Keys are scoped by tenant, repo and branch/operation: the same key in
// another scope is a miss, never a replay of someone else's response.
func TestIdempotencyScopes(t *testing.T) {
	store := fakeIdem{}
	k := mustIdem(t, "work/a", "key-12345678", commitReq("m"))
	store.put(tenantA, k, CommitResult{CommitOID: oidA})
	ctx := context.Background()
	if _, ok, err := lookupIdem(ctx, store, tenantB, k); ok || err != nil {
		t.Fatalf("other tenant: ok=%v err=%v", ok, err)
	}
	if _, ok, err := lookupIdem(ctx, store, tenantA, mustIdem(t, "work/b", "key-12345678", commitReq("m"))); ok || err != nil {
		t.Fatalf("other branch: ok=%v err=%v", ok, err)
	}
	if _, ok, err := lookupIdem(ctx, store, tenantA, mustIdem(t, "@op/merge/r1", "key-12345678", commitReq("m"))); ok || err != nil {
		t.Fatalf("operation scope: ok=%v err=%v", ok, err)
	}
}

func sha64(seed string) string {
	const hexd = "0123456789abcdef"
	b := make([]byte, 64)
	for i := range b {
		b[i] = hexd[(int(seed[i%len(seed)])+i)%16]
	}
	return string(b)
}
