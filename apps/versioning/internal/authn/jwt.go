// Package authn verifies the short-lived Ed25519 service JWT that apps/api
// mints per request (todo4 V4). A static service token alone is rejected:
// every request names a tenant, project and actor, which the service then
// re-checks against its own rows (internal/authz).
package authn

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Scopes the API may grant.
const (
	ScopeRead     = "versioning:read"
	ScopeWrite    = "versioning:write"
	ScopeReview   = "versioning:review"
	ScopeApprove  = "versioning:approve"
	ScopeMerge    = "versioning:merge"
	ScopeRelease  = "versioning:release"
	ScopeCheckout = "versioning:checkout"
	ScopeChecks   = "versioning:checks"
	ScopeAdmin    = "versioning:admin"
	ScopePurge    = "versioning:purge"
)

// Actor kinds.
const (
	KindUser    = "user"
	KindAgent   = "agent"
	KindService = "service"
)

// The pipeline service's identity (todo12 Milestone 1). Tokens signed with
// kid PipelineKID (its own Ed25519 key, published in versioning-jwks next to
// the api's) carry issuer PipelineIssuer and the actor PipelineActorID, and
// become a principal with Service = ServicePipeline. No other key may claim
// that actor. What the pipeline may do is fenced in internal/authz and the
// server's route allowlist.
const (
	PipelineKID     = "pipeline"
	PipelineIssuer  = "pipeline"
	PipelineActorID = "service:pipeline"
	ServicePipeline = "pipeline"
)

// PipelineScopes are the only scopes a pipeline token may carry.
var PipelineScopes = map[string]bool{ScopeRead: true, ScopeWrite: true, ScopeReview: true, ScopeMerge: true}

// MaxLifetime bounds exp-iat; apps/api mints 60 s tokens.
const MaxLifetime = 120 * time.Second

// Actor is who acts, and for whom.
type Actor struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	OnBehalfOf string `json:"on_behalf_of,omitempty"`
}

// Principal is the verified request context.
type Principal struct {
	TenantID  string
	ProjectID string
	Actor     Actor
	Scopes    map[string]bool
	RequestID string
	// Service names a restricted backend principal (ServicePipeline), set
	// only from its own signing key.
	Service string
}

// IsPipeline reports whether p is the pipeline service.
func (p *Principal) IsPipeline() bool { return p != nil && p.Service == ServicePipeline }

// Has reports whether the principal holds scope.
func (p *Principal) Has(scope string) bool { return p.Scopes[scope] }

// Effective is the human (or service) ultimately responsible: on_behalf_of
// when an agent acts for someone, otherwise the actor.
func (p *Principal) Effective() string {
	if p.Actor.OnBehalfOf != "" {
		return p.Actor.OnBehalfOf
	}
	return p.Actor.ID
}

// Claims is the JWT body.
type Claims struct {
	jwt.RegisteredClaims
	TenantID  string   `json:"tenant_id"`
	ProjectID string   `json:"project_id"`
	Actor     Actor    `json:"actor"`
	Scopes    []string `json:"scopes"`
	RequestID string   `json:"request_id"`
}

var (
	uuidRE  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	actorRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`)
)

// ErrUnauthenticated wraps every verification failure.
var ErrUnauthenticated = errors.New("unauthenticated")

// Verifier checks tokens against the API's public keys.
type Verifier struct {
	path     string
	audience string
	issuer   string

	mu       sync.RWMutex
	keys     map[string]ed25519.PublicKey
	loadedAt time.Time
	modTime  time.Time
	now      func() time.Time
}

// NewVerifier loads keys from a JWKS (or PEM) file. The file is re-read when
// it changes, so a ConfigMap key rotation needs no restart.
func NewVerifier(path, audience, issuer string) (*Verifier, error) {
	v := &Verifier{path: path, audience: audience, issuer: issuer, now: time.Now}
	if err := v.reload(true); err != nil {
		return nil, err
	}
	return v, nil
}

// NewStaticVerifier verifies against fixed keys (tests).
func NewStaticVerifier(keys map[string]ed25519.PublicKey, audience, issuer string) *Verifier {
	return &Verifier{keys: keys, audience: audience, issuer: issuer, now: time.Now}
}

func (v *Verifier) reload(force bool) error {
	if v.path == "" {
		return nil
	}
	v.mu.RLock()
	fresh := time.Since(v.loadedAt) < 30*time.Second
	v.mu.RUnlock()
	if fresh && !force {
		return nil
	}
	st, err := os.Stat(v.path)
	if err != nil {
		return fmt.Errorf("jwt keys: %w", err)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.loadedAt = time.Now()
	if !force && st.ModTime().Equal(v.modTime) {
		return nil
	}
	b, err := os.ReadFile(v.path)
	if err != nil {
		return fmt.Errorf("jwt keys: %w", err)
	}
	keys, err := ParseKeys(b)
	if err != nil {
		return err
	}
	v.keys, v.modTime = keys, st.ModTime()
	return nil
}

// ParseKeys reads a JWKS document of OKP/Ed25519 keys, or a single PEM key
// (kid "default").
func ParseKeys(b []byte) (map[string]ed25519.PublicKey, error) {
	if blk, _ := pem.Decode(b); blk != nil {
		k, err := x509.ParsePKIXPublicKey(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("jwt keys: %w", err)
		}
		ek, ok := k.(ed25519.PublicKey)
		if !ok {
			return nil, errors.New("jwt keys: PEM key is not Ed25519")
		}
		return map[string]ed25519.PublicKey{"default": ek}, nil
	}
	var set struct {
		Keys []struct {
			Kty, Crv, Kid, X string
		} `json:"keys"`
	}
	if err := json.Unmarshal(b, &set); err != nil {
		return nil, fmt.Errorf("jwt keys: %w", err)
	}
	out := map[string]ed25519.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "OKP" || k.Crv != "Ed25519" || k.Kid == "" {
			continue
		}
		raw, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("jwt keys: bad key %s", k.Kid)
		}
		out[k.Kid] = ed25519.PublicKey(raw)
	}
	if len(out) == 0 {
		return nil, errors.New("jwt keys: no Ed25519 keys")
	}
	return out, nil
}

// Verify parses and validates a bearer token.
func (v *Verifier) Verify(token string) (*Principal, error) {
	_ = v.reload(false) // keep serving with the last good keys on a transient error
	var c Claims
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithAudience(v.audience),
		jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithLeeway(5*time.Second),
		jwt.WithTimeFunc(v.now),
	)
	var kid string
	_, err := parser.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		kid, _ = t.Header["kid"].(string)
		if kid == "" {
			kid = "default"
		}
		v.mu.RLock()
		defer v.mu.RUnlock()
		k, ok := v.keys[kid]
		if !ok {
			return nil, fmt.Errorf("unknown kid")
		}
		return k, nil
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnauthenticated, err)
	}
	// Each key has one issuer: the pipeline's key can't mint api tokens and vice versa.
	wantIssuer := v.issuer
	if kid == PipelineKID {
		wantIssuer = PipelineIssuer
	}
	if c.Issuer != wantIssuer {
		return nil, fmt.Errorf("%w: issuer %q not accepted for key %q", ErrUnauthenticated, c.Issuer, kid)
	}
	if c.IssuedAt == nil || c.ExpiresAt.Sub(c.IssuedAt.Time) > MaxLifetime {
		return nil, fmt.Errorf("%w: token lifetime exceeds %s", ErrUnauthenticated, MaxLifetime)
	}
	if !uuidRE.MatchString(c.TenantID) || !uuidRE.MatchString(c.ProjectID) {
		return nil, fmt.Errorf("%w: tenant_id and project_id must be uuids", ErrUnauthenticated)
	}
	if !actorRE.MatchString(c.Actor.ID) {
		return nil, fmt.Errorf("%w: actor.id invalid", ErrUnauthenticated)
	}
	switch c.Actor.Kind {
	case KindUser, KindService:
	case KindAgent:
		if !actorRE.MatchString(c.Actor.OnBehalfOf) {
			return nil, fmt.Errorf("%w: agent actors must carry on_behalf_of", ErrUnauthenticated)
		}
	default:
		return nil, fmt.Errorf("%w: actor.kind invalid", ErrUnauthenticated)
	}
	if c.Actor.OnBehalfOf != "" && !actorRE.MatchString(c.Actor.OnBehalfOf) {
		return nil, fmt.Errorf("%w: on_behalf_of invalid", ErrUnauthenticated)
	}
	p := &Principal{TenantID: c.TenantID, ProjectID: c.ProjectID, Actor: c.Actor, RequestID: c.RequestID, Scopes: map[string]bool{}}
	for _, s := range c.Scopes {
		p.Scopes[s] = true
	}
	switch {
	case kid == PipelineKID:
		if c.Actor.ID != PipelineActorID || c.Actor.Kind != KindService || c.Actor.OnBehalfOf != "" {
			return nil, fmt.Errorf("%w: the pipeline key signs only for %s", ErrUnauthenticated, PipelineActorID)
		}
		for s := range p.Scopes {
			if !PipelineScopes[s] {
				return nil, fmt.Errorf("%w: scope %s is not available to the pipeline", ErrUnauthenticated, s)
			}
		}
		p.Service = ServicePipeline
	case c.Actor.ID == PipelineActorID || c.Actor.OnBehalfOf == PipelineActorID:
		return nil, fmt.Errorf("%w: %s is reserved for the pipeline key", ErrUnauthenticated, PipelineActorID)
	}
	return p, nil
}

// BearerToken extracts the token from an Authorization header value.
func BearerToken(h string) (string, bool) {
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}

type ctxKey struct{}

// WithPrincipal stores p in ctx.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the request principal, or nil.
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}
