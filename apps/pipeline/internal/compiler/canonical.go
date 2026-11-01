package compiler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/gowebpki/jcs"
)

// Canonical is the RFC 8785 (JCS) form of v, the same bytes the plugin
// lockfile hashes (packages/contracts/src/canonical.ts,
// apps/api/.../kernel/canonical.py): members sorted by UTF-16 code units, no
// whitespace, ECMAScript number and string serialisation. It is checked
// against packages/contracts/test-vectors/canonical.json. Unlike the
// versioning manifests it applies no Unicode normalisation, so a graph hashes
// identically in the browser, the kernel and here.
func Canonical(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return CanonicalJSON(raw)
}

// CanonicalJSON canonicalises JSON text.
func CanonicalJSON(raw []byte) ([]byte, error) { return jcs.Transform(raw) }

// Digest is "sha256:<hex>" of v's canonical form.
func Digest(v any) (string, error) {
	b, err := Canonical(v)
	if err != nil {
		return "", err
	}
	return HashBytes(b), nil
}

// HashBytes is "sha256:<hex>" of b.
func HashBytes(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}
