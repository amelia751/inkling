// Command devtoken generates a dev Ed25519 key pair and mints service JWTs
// the way apps/api does, for local development and the load harness only.
//
//	devtoken keygen <dir>                      # writes jwt.key (private) and jwks.json
//	devtoken mint <dir> <tenant> <project> <actor> [kind] [on_behalf_of]
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"

	"studio.local/versioning/internal/authn"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "devtoken:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: devtoken keygen <dir> | mint <dir> <tenant> <project> <actor> [kind] [on_behalf_of]")
	}
	dir := args[1]
	switch args[0] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		der, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "jwt.key"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
			return err
		}
		jwks, _ := json.Marshal(map[string]any{"keys": []map[string]string{{"kty": "OKP", "crv": "Ed25519", "kid": "dev",
			"x": base64.RawURLEncoding.EncodeToString(pub)}}})
		return os.WriteFile(filepath.Join(dir, "jwks.json"), jwks, 0o644) // #nosec G306 -- public key
	case "mint":
		if len(args) < 5 {
			return fmt.Errorf("mint needs <dir> <tenant> <project> <actor>")
		}
		b, err := os.ReadFile(filepath.Join(dir, "jwt.key")) // #nosec G304 -- dev tool
		if err != nil {
			return err
		}
		blk, _ := pem.Decode(b)
		if blk == nil {
			return fmt.Errorf("jwt.key is not PEM")
		}
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return err
		}
		actor := authn.Actor{ID: args[4], Kind: authn.KindUser}
		if len(args) > 5 {
			actor.Kind = args[5]
		}
		if len(args) > 6 {
			actor.OnBehalfOf = args[6]
		}
		s := authn.Signer{Key: k.(ed25519.PrivateKey), KID: "dev", Issuer: "api", Audience: "versioning"}
		tok, err := s.Token(args[2], args[3], actor, authn.AllScopes, "")
		if err != nil {
			return err
		}
		fmt.Println(tok)
		return nil
	}
	return fmt.Errorf("unknown command %q", args[0])
}
