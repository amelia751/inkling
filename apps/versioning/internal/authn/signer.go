package authn

import (
	"crypto/ed25519"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Signer mints tokens the way apps/api does. The service itself never signs;
// this exists for tests, the load harness and the dev token tool.
type Signer struct {
	Key      ed25519.PrivateKey
	KID      string
	Issuer   string
	Audience string
	Lifetime time.Duration
}

// Token mints a token for the given scope.
func (s *Signer) Token(tenant, project string, actor Actor, scopes []string, requestID string) (string, error) {
	now := time.Now()
	life := s.Lifetime
	if life == 0 {
		life = 60 * time.Second
	}
	c := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: s.Issuer, Audience: jwt.ClaimStrings{s.Audience}, Subject: actor.ID,
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(life)),
		},
		TenantID: tenant, ProjectID: project, Actor: actor, Scopes: scopes, RequestID: requestID,
	}
	t := jwt.NewWithClaims(jwt.SigningMethodEdDSA, c)
	t.Header["kid"] = s.KID
	return t.SignedString(s.Key)
}

// AllScopes lists every scope (tests and dev tokens).
var AllScopes = []string{ScopeRead, ScopeWrite, ScopeReview, ScopeApprove, ScopeMerge, ScopeRelease,
	ScopeCheckout, ScopeChecks, ScopeAdmin, ScopePurge}
