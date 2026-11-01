package publication

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/golang-jwt/jwt/v5"

	"studio.local/pipeline/internal/contracts"
)

// fakeVersioning plays apps/versioning's side of the contract: it verifies
// the pipeline's token the way internal/authn does, replays idempotency keys,
// and moves heads only by CAS.
type fakeVersioning struct {
	t        *testing.T
	pub      ed25519.PublicKey
	mu       sync.Mutex
	branches map[string]string
	idem     map[string][]byte
	reviews  map[string]*Review
	commits  int
	merges   int
}

func newFake(t *testing.T) (*fakeVersioning, *Client) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	f := &fakeVersioning{t: t, pub: pub, branches: map[string]string{"main": strings.Repeat("a", 40)}, idem: map[string][]byte{}, reviews: map[string]*Review{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, &Client{BaseURL: srv.URL, Signer: &Signer{Key: priv}}
}

func (f *fakeVersioning) problem(w http.ResponseWriter, status int, code, head string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "code": code, "current_head": head})
}

func (f *fakeVersioning) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var c claims
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	parsed, err := jwt.ParseWithClaims(tok, &c, func(t *jwt.Token) (any, error) {
		if t.Header["kid"] != KID {
			return nil, fmt.Errorf("kid %v", t.Header["kid"])
		}
		return f.pub, nil
	}, jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithIssuer(Issuer), jwt.WithAudience(Audience))
	if err != nil || !parsed.Valid || c.Actor["id"] != ActorID || c.Actor["kind"] != "service" {
		f.problem(w, 401, "unauthenticated", "")
		return
	}
	for _, s := range c.Scopes {
		if s != ScopeRead && s != ScopeWrite && s != ScopeReview && s != ScopeMerge {
			f.problem(w, 401, "unauthenticated", "")
			return
		}
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	key := r.Header.Get("Idempotency-Key")
	if k, ok := body["idempotency_key"].(string); ok {
		key = k
	}
	if key != "" {
		if b, ok := f.idem[r.URL.Path+key]; ok {
			_, _ = w.Write(b)
			return
		}
	}
	reply := func(v any) {
		b, _ := json.Marshal(v)
		if key != "" {
			f.idem[r.URL.Path+key] = b
		}
		_, _ = w.Write(b)
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/internal/v1/repos/repo_1"), "/")
	switch {
	case r.Method == "POST" && parts[1] == "branches":
		name := body["name"].(string)
		if !strings.HasPrefix(name, "pipeline/") {
			f.problem(w, 403, "forbidden", "")
			return
		}
		if _, ok := f.branches[name]; ok {
			f.problem(w, 409, "conflict", "")
			return
		}
		from := f.branches[body["from"].(string)]
		f.branches[name] = from
		reply(Branch{Name: name, CommitOID: from})
	case r.Method == "POST" && parts[1] == "commits":
		b := body["branch"].(string)
		if f.branches[b] != body["expected_head"] {
			f.problem(w, 409, "stale_head", f.branches[b])
			return
		}
		f.commits++
		oid := fmt.Sprintf("%040x", 0xc0+f.commits)
		f.branches[b] = oid
		reply(CommitResult{CommitOID: oid, Branch: b})
	case r.Method == "POST" && len(parts) == 2 && parts[1] == "reviews":
		id := fmt.Sprintf("rev_%d", len(f.reviews)+1)
		src := body["source_branch"].(string)
		rv := &Review{ID: id, Status: "READY", SourceBranch: src, SourceOID: f.branches[src], TargetBranch: body["target_branch"].(string),
			CheckedTargetOID: f.branches[body["target_branch"].(string)]}
		f.reviews[id] = rv
		reply(rv)
	case r.Method == "GET" && len(parts) == 3 && parts[1] == "reviews":
		reply(f.reviews[parts[2]])
	case r.Method == "POST" && len(parts) == 4 && parts[3] == "merge":
		rv := f.reviews[parts[2]]
		if cur := f.branches[rv.TargetBranch]; cur != rv.CheckedTargetOID {
			rv.CheckedTargetOID, rv.Status = cur, "CHECKING"
			f.problem(w, 409, "stale_head", cur)
			return
		}
		f.merges++
		rv.Status, rv.MergeOID = "MERGED", fmt.Sprintf("%040x", 0xe0+f.merges)
		f.branches[rv.TargetBranch] = rv.MergeOID
		reply(rv)
	default:
		f.problem(w, 403, "forbidden", "")
	}
}

var sc = Scope{TenantID: TenantUUID("test", "default"), ProjectID: ProjectUUID("test", "ws_1")}

func digest(c string) string { return "sha256:" + strings.Repeat(c, 64) }

func (f *fakeVersioning) approve(id, reviewer, approvalID, dg string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rv := f.reviews[id]
	rv.Approvals = append(rv.Approvals, Approval{ID: approvalID, ReviewerID: reviewer, ApprovedSourceOID: rv.SourceOID,
		ApprovedTargetOID: rv.CheckedTargetOID, CandidateDigest: dg})
	rv.Status = "READY"
}

func TestProposeAndPublishExactlyOnce(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	in := ProposeInput{RunID: "run_1", RepoID: "repo_1", TargetBranch: "main", ManifestRoot: digest("1"), OutputDigest: digest("2")}
	cand, err := c.ProposeCandidate(ctx, sc, in)
	if err != nil {
		t.Fatal(err)
	}
	// A retried step (crash after the review was opened) replays everything.
	again, err := c.ProposeCandidate(ctx, sc, in)
	if err != nil || *again != *cand || f.commits != 1 || len(f.reviews) != 1 {
		t.Fatalf("propose isn't idempotent: %+v vs %+v (%v), commits=%d", again, cand, err, f.commits)
	}
	if cand.Branch != "pipeline/run_1" || cand.BaseCommit != strings.Repeat("a", 40) {
		t.Fatalf("%+v", cand)
	}
	if err := contracts.ValidateValue(contracts.SchemaRun, contracts.RunRecord{}); err == nil {
		t.Fatal("schema sanity")
	}

	// Unapproved, or approved for another digest: refused before any merge.
	if _, err := c.Publish(ctx, sc, cand, "apr_1", digest("2")); !errors.Is(err, ErrApprovalNotCurrent) {
		t.Fatal("published without an approval:", err)
	}
	f.approve(cand.ReviewID, "user-bob", "apr_1", digest("2"))
	if _, err := c.Publish(ctx, sc, cand, "apr_1", digest("9")); !errors.Is(err, ErrApprovalNotCurrent) {
		t.Fatal("published another digest:", err)
	}

	res, err := c.Publish(ctx, sc, cand, "apr_1", digest("2"))
	if err != nil || res.Outcome != OutcomeMerged || res.MergeCommit == "" {
		t.Fatal(res, err)
	}
	// A repeated approval (same PublishWorkflow id replayed) publishes nothing new.
	res2, err := c.Publish(ctx, sc, cand, "apr_1", digest("2"))
	if err != nil || res2.MergeCommit != res.MergeCommit || f.merges != 1 {
		t.Fatalf("published twice: %+v %v merges=%d", res2, err, f.merges)
	}
}

// P§20 tests 4/5: main moved after approval; the publish is stale, nothing
// newer is overwritten, and a fresh approval on the re-checked review publishes.
func TestPublishOnMovedTargetIsStale(t *testing.T) {
	f, c := newFake(t)
	ctx := context.Background()
	cand, err := c.ProposeCandidate(ctx, sc, ProposeInput{RunID: "run_2", RepoID: "repo_1", TargetBranch: "main", ManifestRoot: digest("1"), OutputDigest: digest("2")})
	if err != nil {
		t.Fatal(err)
	}
	f.approve(cand.ReviewID, "user-bob", "apr_1", digest("2"))
	f.mu.Lock()
	newer := strings.Repeat("b", 40)
	f.branches["main"] = newer // another publisher won the CAS
	f.mu.Unlock()
	res, err := c.Publish(ctx, sc, cand, "apr_1", digest("2"))
	if err != nil || res.Outcome != OutcomeStale || res.CurrentHead != newer || f.branches["main"] != newer {
		t.Fatalf("%+v %v main=%s", res, err, f.branches["main"])
	}
	// The same approval stays stale after versioning re-checked the review.
	res, err = c.Publish(ctx, sc, cand, "apr_1", digest("2"))
	if err != nil || res.Outcome != OutcomeStale {
		t.Fatal("a stale approval published:", res, err)
	}
	f.approve(cand.ReviewID, "user-bob", "apr_2", digest("2"))
	res, err = c.Publish(ctx, sc, cand, "apr_2", digest("2"))
	if err != nil || res.Outcome != OutcomeMerged {
		t.Fatal(res, err)
	}
}

func TestKeysAndTokens(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	k, err := ParseKey(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	if err != nil || !k.Public().(ed25519.PublicKey).Equal(pub) {
		t.Fatal(err)
	}
	var set struct {
		Keys []map[string]string `json:"keys"`
	}
	if err := json.Unmarshal(JWKS(k, KID), &set); err != nil || set.Keys[0]["kid"] != KID || set.Keys[0]["crv"] != "Ed25519" {
		t.Fatal(set, err)
	}
	// Same mapping as apps/api: uuid5(URL, "<prefix>:workspace:<id>").
	if ProjectUUID("p", "ws_1") != "bce78025-f5ec-5a6d-a37d-af536d0eaab1" { // python3 -c "uuid.uuid5(uuid.NAMESPACE_URL, 'p:workspace:ws_1')"
		t.Fatal("project uuid")
	}
	if len(idemKey(strings.Repeat("x", 200))) > 128 {
		t.Fatal("idempotency key too long")
	}
}
