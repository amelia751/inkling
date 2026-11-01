// Package publication is the pipeline's versioning client (todo12 Milestone 1
// item 6) and the candidate/publish procedure of docs/pipeline.md §9.
//
// The pipeline signs its own short-lived Ed25519 JWTs (kid "pipeline", issuer
// "pipeline", actor service:pipeline); apps/versioning verifies them against
// the public key in versioning-jwks and lets that principal only create
// pipeline/* branches and commits, open reviews, and merge reviews with a
// current approval. Orchestration never moves a head itself: every write is a
// versioning CAS with an idempotency key derived from the run.
package publication

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Identity constants; they must match apps/versioning/internal/authn.
const (
	KID      = "pipeline"
	Issuer   = "pipeline"
	ActorID  = "service:pipeline"
	Audience = "versioning"
	Lifetime = 60 * time.Second
)

// Scopes the pipeline uses (no approve, release or admin: versioning refuses them).
const (
	ScopeRead   = "versioning:read"
	ScopeWrite  = "versioning:write"
	ScopeReview = "versioning:review"
	ScopeMerge  = "versioning:merge"
)

// Signer mints the pipeline's tokens.
type Signer struct {
	Key      ed25519.PrivateKey
	KID      string
	Audience string
	Now      func() time.Time
}

// LoadKey reads an Ed25519 PKCS#8 PEM private key (the jwt.key of Secret
// pipeline-versioning-jwt, mounted at PIPELINE_VERSIONING_JWT_KEY_FILE).
func LoadKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path) //nolint:gosec // operator-provided key path
	if err != nil {
		return nil, fmt.Errorf("versioning key: %w", err)
	}
	return ParseKey(b)
}

// ParseKey parses an Ed25519 PKCS#8 PEM private key.
func ParseKey(b []byte) (ed25519.PrivateKey, error) {
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("versioning key: not PEM")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("versioning key: %w", err)
	}
	ek, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("versioning key: not Ed25519")
	}
	return ek, nil
}

// JWKS is the public half for versioning-jwks.
func JWKS(key ed25519.PrivateKey, kid string) []byte {
	pub := key.Public().(ed25519.PublicKey)
	b, _ := json.Marshal(map[string]any{"keys": []map[string]string{{"kty": "OKP", "crv": "Ed25519", "kid": kid,
		"x": base64.RawURLEncoding.EncodeToString(pub), "use": "sig", "alg": "EdDSA"}}})
	return b
}

// Scope is who a call is for: versioning's tenant and project uuids.
type Scope struct {
	TenantID  string
	ProjectID string
	RequestID string
}

// TenantUUID and ProjectUUID map kernel ids to versioning's uuids exactly as
// apps/api does (kernel/versioning/auth.py), so the pipeline lands in the same
// versioning project as the api for a workspace.
func TenantUUID(resourcePrefix, tenant string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(resourcePrefix+":tenant:"+tenant)).String()
}

// ProjectUUID is the versioning project of a kernel workspace.
func ProjectUUID(resourcePrefix, workspaceID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(resourcePrefix+":workspace:"+workspaceID)).String()
}

type claims struct {
	jwt.RegisteredClaims
	TenantID  string            `json:"tenant_id"`
	ProjectID string            `json:"project_id"`
	Actor     map[string]string `json:"actor"`
	Scopes    []string          `json:"scopes"`
	RequestID string            `json:"request_id,omitempty"`
}

// Token mints a token for one call with only the scopes it needs.
func (s *Signer) Token(sc Scope, scopes ...string) (string, error) {
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	kid, aud := s.KID, s.Audience
	if kid == "" {
		kid = KID
	}
	if aud == "" {
		aud = Audience
	}
	c := claims{RegisteredClaims: jwt.RegisteredClaims{Issuer: Issuer, Audience: jwt.ClaimStrings{aud}, Subject: ActorID,
		IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(Lifetime))},
		TenantID: sc.TenantID, ProjectID: sc.ProjectID, Actor: map[string]string{"id": ActorID, "kind": "service"},
		Scopes: scopes, RequestID: sc.RequestID}
	t := jwt.NewWithClaims(jwt.SigningMethodEdDSA, c)
	t.Header["kid"] = kid
	return t.SignedString(s.Key)
}

// Client calls apps/versioning.
type Client struct {
	BaseURL string
	HTTP    *http.Client
	Signer  *Signer
}

// Problem is versioning's error body.
type Problem struct {
	Status      int    `json:"status"`
	Code        string `json:"code"`
	Detail      string `json:"detail"`
	CurrentHead string `json:"current_head"`
}

func (p *Problem) Error() string {
	return fmt.Sprintf("versioning %d %s: %s", p.Status, p.Code, p.Detail)
}

// Typed outcomes callers branch on.
var (
	ErrStaleHead = errors.New("stale head")
	ErrNotReady  = errors.New("review not ready")
	ErrForbidden = errors.New("forbidden")
	ErrNotFound  = errors.New("not found")
)

// Is maps problems to the typed errors.
func (p *Problem) Is(target error) bool {
	switch target {
	case ErrStaleHead:
		return p.Code == "stale_head"
	case ErrNotReady:
		return p.Code == "not_ready"
	case ErrForbidden:
		return p.Status == http.StatusForbidden
	case ErrNotFound:
		return p.Status == http.StatusNotFound
	}
	return false
}

// Transient reports whether an error is worth retrying the step (network,
// 5xx, 429, or a review still being checked).
func Transient(err error) bool {
	var p *Problem
	if errors.As(err, &p) {
		return p.Status >= 500 || p.Status == http.StatusTooManyRequests || p.Code == "not_ready"
	}
	return err != nil && !errors.Is(err, context.Canceled)
}

func (c *Client) do(ctx context.Context, sc Scope, scopes []string, method, path string, body any, idem string, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, rd)
	if err != nil {
		return err
	}
	tok, err := c.Signer.Token(sc, scopes...)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idem != "" {
		req.Header.Set("Idempotency-Key", idem)
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		p := &Problem{Status: res.StatusCode}
		_ = json.Unmarshal(raw, p)
		p.Status = res.StatusCode
		return p
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// Branch is a versioning branch.
type Branch struct {
	Name       string `json:"name"`
	CommitOID  string `json:"commit_oid"`
	Generation int64  `json:"generation"`
	Protected  bool   `json:"protected"`
}

// Approval is one review approval (todo12: id, candidate digest, target).
type Approval struct {
	ID                string `json:"id"`
	ReviewerID        string `json:"reviewer_id"`
	ApprovedSourceOID string `json:"approved_source_oid"`
	ApprovedTargetOID string `json:"approved_target_oid"`
	CandidateDigest   string `json:"candidate_digest"`
}

// Review is a versioning review.
type Review struct {
	ID               string     `json:"id"`
	Status           string     `json:"status"`
	SourceBranch     string     `json:"source_branch"`
	SourceOID        string     `json:"source_oid"`
	TargetBranch     string     `json:"target_branch"`
	CheckedTargetOID string     `json:"checked_target_oid"`
	MergeOID         string     `json:"merge_oid"`
	Approvals        []Approval `json:"approvals"`
}

// CommitResult is a successful commit.
type CommitResult struct {
	CommitOID    string `json:"commit_oid"`
	Branch       string `json:"branch"`
	ManifestRoot string `json:"manifest_root"`
}

func repoPath(repo string) string { return "/internal/v1/repos/" + url.PathEscape(repo) }

// CreateBranch creates name at from (a commit oid or branch name).
func (c *Client) CreateBranch(ctx context.Context, sc Scope, repo, name, from, idem string) (*Branch, error) {
	var b Branch
	err := c.do(ctx, sc, []string{ScopeWrite}, http.MethodPost, repoPath(repo)+"/branches", map[string]any{"name": name, "from": from}, idem, &b)
	return &b, err
}

// GetBranch finds a live branch by name.
func (c *Client) GetBranch(ctx context.Context, sc Scope, repo, name string) (*Branch, error) {
	cursor := ""
	for i := 0; i < 100; i++ {
		var page struct {
			Items      []Branch `json:"items"`
			NextCursor *string  `json:"next_cursor"`
		}
		q := "?limit=200"
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		if err := c.do(ctx, sc, []string{ScopeRead}, http.MethodGet, repoPath(repo)+"/branches"+q, nil, "", &page); err != nil {
			return nil, err
		}
		for _, b := range page.Items {
			if b.Name == name {
				b := b
				return &b, nil
			}
		}
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		cursor = *page.NextCursor
	}
	return nil, &Problem{Status: http.StatusNotFound, Code: "not_found", Detail: "branch " + name}
}

// PutManifest stores a dataset manifest and returns its root.
func (c *Client) PutManifest(ctx context.Context, sc Scope, repo string, manifest json.RawMessage) (string, error) {
	var out struct {
		ManifestRoot string `json:"manifest_root"`
	}
	err := c.do(ctx, sc, []string{ScopeWrite}, http.MethodPost, repoPath(repo)+"/manifests", manifest, "", &out)
	return out.ManifestRoot, err
}

// Commit is a CAS commit on branch; a moved head is ErrStaleHead.
func (c *Client) Commit(ctx context.Context, sc Scope, repo, branch, expected, root, message, idem string) (*CommitResult, error) {
	var out CommitResult
	err := c.do(ctx, sc, []string{ScopeWrite}, http.MethodPost, repoPath(repo)+"/commits", map[string]any{"branch": branch,
		"expected_head": expected, "manifest_root": root, "message": message, "idempotency_key": idem, "tool": "pipeline"}, "", &out)
	return &out, err
}

// CreateReview opens a review from source into target.
func (c *Client) CreateReview(ctx context.Context, sc Scope, repo, title, description, source, target, idem string) (*Review, error) {
	var out Review
	err := c.do(ctx, sc, []string{ScopeReview}, http.MethodPost, repoPath(repo)+"/reviews", map[string]any{"title": title,
		"description": description, "source_branch": source, "target_branch": target}, idem, &out)
	return &out, err
}

// GetReview reads a review.
func (c *Client) GetReview(ctx context.Context, sc Scope, repo, id string) (*Review, error) {
	var out Review
	err := c.do(ctx, sc, []string{ScopeRead}, http.MethodGet, repoPath(repo)+"/reviews/"+url.PathEscape(id), nil, "", &out)
	return &out, err
}

// MergeReview merges with versioning's CAS on the target head.
func (c *Client) MergeReview(ctx context.Context, sc Scope, repo, id, idem, message string) (*Review, error) {
	var out Review
	err := c.do(ctx, sc, []string{ScopeMerge}, http.MethodPost, repoPath(repo)+"/reviews/"+url.PathEscape(id)+"/merge",
		map[string]any{"idempotency_key": idem, "message": message}, "", &out)
	return &out, err
}

// idemKey fits versioning's 8–128 characters: readable when short, hashed when long.
func idemKey(parts ...string) string {
	k := strings.Join(parts, ":")
	if len(k) <= 128 {
		return k
	}
	return "h:" + hex.EncodeToString(sha(k))
}
