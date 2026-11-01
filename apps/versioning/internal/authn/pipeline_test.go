package authn

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
)

const (
	tenant  = "11111111-1111-4111-8111-111111111111"
	project = "22222222-2222-4222-8222-222222222222"
)

func keys(t *testing.T) (*Verifier, *Signer, *Signer) {
	t.Helper()
	apiPub, apiKey, _ := ed25519.GenerateKey(rand.Reader)
	pipePub, pipeKey, _ := ed25519.GenerateKey(rand.Reader)
	v := NewStaticVerifier(map[string]ed25519.PublicKey{"api": apiPub, PipelineKID: pipePub}, "versioning", "api")
	return v, &Signer{Key: apiKey, KID: "api", Issuer: "api", Audience: "versioning"},
		&Signer{Key: pipeKey, KID: PipelineKID, Issuer: PipelineIssuer, Audience: "versioning"}
}

var pipelineActor = Actor{ID: PipelineActorID, Kind: KindService}

func TestPipelineKeyIsThePipelinePrincipal(t *testing.T) {
	v, _, pipe := keys(t)
	tok, err := pipe.Token(tenant, project, pipelineActor, []string{ScopeRead, ScopeWrite, ScopeReview, ScopeMerge, ScopeCheckout}, "r1")
	if err != nil {
		t.Fatal(err)
	}
	p, err := v.Verify(tok)
	if err != nil {
		t.Fatal(err)
	}
	if !p.IsPipeline() || p.Actor.ID != PipelineActorID {
		t.Fatalf("%+v", p)
	}
}

func TestPipelineTokensAreFenced(t *testing.T) {
	v, api, pipe := keys(t)
	cases := []struct {
		name string
		s    *Signer
		a    Actor
		sc   []string
	}{
		{"pipeline key cannot claim approve", pipe, pipelineActor, []string{ScopeApprove}},
		{"pipeline key cannot claim admin", pipe, pipelineActor, []string{ScopeRead, ScopeAdmin}},
		{"pipeline key cannot claim release", pipe, pipelineActor, []string{ScopeRelease}},
		{"pipeline key cannot act as a user", pipe, Actor{ID: "user-alice", Kind: KindUser}, []string{ScopeRead}},
		{"pipeline key cannot act for someone", pipe, Actor{ID: PipelineActorID, Kind: KindService, OnBehalfOf: "user-alice"}, []string{ScopeRead}},
		{"api key cannot claim the pipeline identity", api, pipelineActor, []string{ScopeRead}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tok, err := c.s.Token(tenant, project, c.a, c.sc, "")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := v.Verify(tok); !errors.Is(err, ErrUnauthenticated) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	// Issuers are per key: the pipeline key with the api's issuer, and the api key with the pipeline's.
	for _, s := range []*Signer{{Key: pipe.Key, KID: PipelineKID, Issuer: "api", Audience: "versioning"},
		{Key: api.Key, KID: "api", Issuer: PipelineIssuer, Audience: "versioning"}} {
		tok, _ := s.Token(tenant, project, Actor{ID: "svc", Kind: KindService}, []string{ScopeRead}, "")
		if _, err := v.Verify(tok); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("kid %s with issuer %s accepted", s.KID, s.Issuer)
		}
	}
	// The api's own tokens are unaffected.
	tok, _ := api.Token(tenant, project, Actor{ID: "user-alice", Kind: KindUser}, AllScopes, "")
	if p, err := v.Verify(tok); err != nil || p.IsPipeline() {
		t.Fatal(p, err)
	}
}
