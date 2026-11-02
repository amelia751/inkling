"""Signer: signs and verifies a sha256 digest (todo10 Phase 3, D5).

    sign(digest) -> signature        digest is "sha256:<64 hex>"; signature is base64
    verify(digest, signature) -> bool
    key_id                           stable, public name of the key

What is signed is the 32 raw digest bytes, so a KMS can sign without ever seeing the
artifact. Implementations:

- `local`: an Ed25519 key in a PEM file (development and tests only; generated on first use).
- `gcpkms`: a Cloud KMS asymmetric key version (algorithm EC_SIGN_P256_SHA256). The private
  key never leaves KMS; verification uses the cached public key, offline. The key id is the
  `gcpkms://` URI cosign also accepts, so `cosign verify-blob --key <key_id>` works.

The service picks one with `make_signer(kind, ...)`; which kind comes from the service's
own config module (`STUDIO_API_SIGNER`, `STUDIO_WORKER_SIGNER`). This package reads no
environment variables and imports no app.

`envelope` / `check_envelope` wrap a signature with its algorithm and key id;
`dsse_sign` / `dsse_verify` sign an attestation (in-toto statement) as a DSSE envelope.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

__all__ = [
    "DIGEST_RE",
    "GcpKmsSigner",
    "LocalSigner",
    "PublicKeyVerifier",
    "Signer",
    "SignerError",
    "check_envelope",
    "digest_bytes",
    "dsse_sign",
    "dsse_verify",
    "envelope",
    "make_signer",
    "sha256_digest",
]

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
KMS_ALGORITHM = "EC_SIGN_P256_SHA256"


class SignerError(RuntimeError):
    pass


@runtime_checkable
class Signer(Protocol):
    kind: str
    alg: str

    @property
    def key_id(self) -> str: ...
    def sign(self, digest: str) -> str: ...
    def verify(self, digest: str, signature: str) -> bool: ...
    def public_key_pem(self) -> str: ...


def sha256_digest(data: bytes) -> str:
    return f"sha256:{hashlib.sha256(data).hexdigest()}"


def digest_bytes(digest: str) -> bytes:
    if not isinstance(digest, str) or not DIGEST_RE.match(digest):
        raise SignerError(f"not a sha256 digest: {digest!r}")
    return bytes.fromhex(digest[len("sha256:"):])


def _b64decode(signature: str) -> bytes | None:
    try:
        return base64.b64decode(signature, validate=True)
    except (ValueError, TypeError):
        return None


# ---- local (Ed25519, development) ---------------------------------------------------------


class LocalSigner:
    """An Ed25519 key in a PEM file. Never for production: the key sits on disk next to the service."""

    kind = "local"
    alg = "ed25519"

    def __init__(self, key: Ed25519PrivateKey):
        self._key = key
        self._pub: Ed25519PublicKey = key.public_key()
        raw = self._pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self._key_id = f"ed25519:{hashlib.sha256(raw).hexdigest()[:16]}"

    @classmethod
    def from_file(cls, path: Path, *, create: bool = True) -> LocalSigner:
        path = Path(path)
        if not path.is_file():
            if not create:
                raise SignerError(f"signing key {path} doesn't exist")
            path.parent.mkdir(parents=True, exist_ok=True)
            pem = Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
            path.write_bytes(pem)
            path.chmod(0o600)
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise SignerError(f"{path} is not an Ed25519 private key")
        return cls(key)

    @classmethod
    def generate(cls) -> LocalSigner:
        return cls(Ed25519PrivateKey.generate())

    @property
    def key_id(self) -> str:
        return self._key_id

    def sign(self, digest: str) -> str:
        return base64.b64encode(self._key.sign(digest_bytes(digest))).decode()

    def verify(self, digest: str, signature: str) -> bool:
        sig = _b64decode(signature)
        if sig is None:
            return False
        try:
            self._pub.verify(sig, digest_bytes(digest))
        except (InvalidSignature, SignerError):
            return False
        return True

    def public_key_pem(self) -> str:
        return self._pub.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()


# ---- Cloud KMS ------------------------------------------------------------------------------


def _crc32c(data: bytes) -> int | None:
    try:
        import google_crc32c  # type: ignore[import-not-found]
    except ImportError:
        return None
    return int(google_crc32c.value(data))


class GcpKmsSigner:
    """A Cloud KMS key version, `projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/N`.

    `client` is a `google.cloud.kms.KeyManagementServiceClient` (or anything with
    `asymmetric_sign` and `get_public_key`); by default one is built from Application Default
    Credentials (Workload Identity in GKE; never a service-account key file).
    """

    kind = "gcpkms"
    alg = "ecdsa-p256-sha256"

    def __init__(self, key_version: str, client: Any = None):
        key_version = key_version.removeprefix("gcpkms://")
        if not re.match(r"^projects/[^/]+/locations/[^/]+/keyRings/[^/]+/cryptoKeys/[^/]+/cryptoKeyVersions/\d+$", key_version):
            raise SignerError("the KMS key must be a key *version* resource name (…/cryptoKeyVersions/N)")
        self.key_version = key_version
        self._client = client
        self._pub: ec.EllipticCurvePublicKey | None = None
        self._pem: str | None = None

    def _kms(self) -> Any:
        if self._client is None:
            try:
                from google.cloud import kms  # type: ignore[import-not-found]
            except ImportError as e:
                raise SignerError("the gcpkms signer needs google-cloud-kms (install studio-signing[gcpkms])") from e
            self._client = kms.KeyManagementServiceClient()
        return self._client

    @property
    def key_id(self) -> str:
        return f"gcpkms://{self.key_version}"

    def _public_key(self) -> ec.EllipticCurvePublicKey:
        if self._pub is None:
            resp = self._kms().get_public_key(request={"name": self.key_version})
            alg = getattr(resp, "algorithm", None)
            alg_name = getattr(alg, "name", alg)
            if alg_name is not None and str(alg_name) != KMS_ALGORITHM:
                raise SignerError(f"KMS key algorithm is {alg_name}; expected {KMS_ALGORITHM}")
            pem = resp.pem
            key = serialization.load_pem_public_key(pem.encode() if isinstance(pem, str) else pem)
            if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
                raise SignerError("KMS public key is not P-256")
            self._pub, self._pem = key, pem if isinstance(pem, str) else pem.decode()
        return self._pub

    def sign(self, digest: str) -> str:
        raw = digest_bytes(digest)
        req: dict[str, Any] = {"name": self.key_version, "digest": {"sha256": raw}}
        crc = _crc32c(raw)
        if crc is not None:
            req["digest_crc32c"] = crc
        resp = self._kms().asymmetric_sign(request=req)
        if getattr(resp, "name", self.key_version) != self.key_version:
            raise SignerError("KMS signed with a different key version than requested")
        if crc is not None and not getattr(resp, "verified_digest_crc32c", True):
            raise SignerError("KMS didn't verify the digest checksum (corrupted in transit)")
        sig = bytes(resp.signature)
        if crc is not None and getattr(resp, "signature_crc32c", None) is not None and int(resp.signature_crc32c) != _crc32c(sig):
            raise SignerError("KMS signature checksum mismatch (corrupted in transit)")
        out = base64.b64encode(sig).decode()
        if not self.verify(digest, out):
            raise SignerError("KMS returned a signature its own public key doesn't verify")
        return out

    def verify(self, digest: str, signature: str) -> bool:
        sig = _b64decode(signature)
        if sig is None:
            return False
        try:
            self._public_key().verify(sig, digest_bytes(digest), ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        except (InvalidSignature, SignerError, ValueError):
            return False
        return True

    def public_key_pem(self) -> str:
        self._public_key()
        assert self._pem is not None
        return self._pem


# ---- verifying with a public key only ------------------------------------------------------


class PublicKeyVerifier:
    """Verifies another installation's signatures (imports, Phase 8). It can't sign."""

    kind = "public-key"

    def __init__(self, key_id: str, pem: str):
        key = serialization.load_pem_public_key(pem.encode())
        if isinstance(key, Ed25519PublicKey):
            self.alg = "ed25519"
        elif isinstance(key, ec.EllipticCurvePublicKey) and key.curve.name == "secp256r1":
            self.alg = "ecdsa-p256-sha256"
        else:
            raise SignerError(f"{key_id}: only Ed25519 and P-256 public keys are supported")
        self._pub, self._pem, self._key_id = key, pem, key_id

    @property
    def key_id(self) -> str:
        return self._key_id

    def sign(self, digest: str) -> str:
        raise SignerError("a public-key verifier can't sign")

    def verify(self, digest: str, signature: str) -> bool:
        sig = _b64decode(signature)
        if sig is None:
            return False
        try:
            if isinstance(self._pub, Ed25519PublicKey):
                self._pub.verify(sig, digest_bytes(digest))
            else:
                assert isinstance(self._pub, ec.EllipticCurvePublicKey)
                self._pub.verify(sig, digest_bytes(digest), ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        except (InvalidSignature, SignerError, ValueError):
            return False
        return True

    def public_key_pem(self) -> str:
        return self._pem


# ---- choosing one --------------------------------------------------------------------------

KINDS = ("local", "gcpkms")


def make_signer(kind: str, *, key_file: Path | None = None, kms_key: str | None = None, kms_client: Any = None) -> Signer:
    """`local` needs `key_file` (created if missing); `gcpkms` needs `kms_key` (a key version)."""
    if kind == "local":
        if key_file is None:
            raise SignerError("the local signer needs a key file")
        return LocalSigner.from_file(key_file)
    if kind == "gcpkms":
        if not kms_key:
            raise SignerError("the gcpkms signer needs a KMS key version")
        return GcpKmsSigner(kms_key, kms_client)
    raise SignerError(f"unknown signer {kind!r}; expected one of {', '.join(KINDS)}")


# ---- envelopes -----------------------------------------------------------------------------


def envelope(signer: Signer, digest: str) -> dict:
    """What gets stored next to an artifact: `{signer, alg, keyId, digest, sig}`."""
    return {"signer": signer.kind, "alg": signer.alg, "keyId": signer.key_id, "digest": digest, "sig": signer.sign(digest)}


def check_envelope(signer: Signer, digest: str, env: dict | None) -> str | None:
    """None if `env` is `signer`'s valid signature over `digest`; otherwise why not."""
    if not env or not env.get("sig"):
        return "not signed"
    if env.get("keyId") != signer.key_id:
        return f"signed by key {env.get('keyId')!r}, which this installation doesn't trust"
    if env.get("digest") not in (None, digest):
        return f"signature is for {env.get('digest')}, not {digest}"
    if not signer.verify(digest, str(env["sig"])):
        return "signature doesn't verify"
    return None


def _pae(payload_type: str, payload: bytes) -> bytes:
    t = payload_type.encode()
    return b"DSSEv1 %d %s %d %s" % (len(t), t, len(payload), payload)


def dsse_sign(signer: Signer, payload_type: str, payload: bytes) -> dict:
    """A DSSE envelope: the signature is over sha256(PAE(type, payload))."""
    d = sha256_digest(_pae(payload_type, payload))
    return {"payloadType": payload_type, "payload": base64.b64encode(payload).decode(), "signatures": [{"keyid": signer.key_id, "sig": signer.sign(d)}]}


def dsse_verify(signer: Signer, env: dict) -> tuple[dict | None, str | None]:
    """(the decoded JSON payload, None) if one of the envelope's signatures is `signer`'s; else (None, why)."""
    try:
        payload = base64.b64decode(env["payload"], validate=True)
        d = sha256_digest(_pae(str(env["payloadType"]), payload))
        sigs = list(env.get("signatures") or [])
    except (KeyError, ValueError, TypeError):
        return None, "malformed DSSE envelope"
    mine = [s for s in sigs if s.get("keyid") == signer.key_id]
    if not mine:
        return None, "attestation isn't signed by a trusted key"
    if not any(signer.verify(d, str(s.get("sig"))) for s in mine):
        return None, "attestation signature doesn't verify"
    try:
        return json.loads(payload), None
    except ValueError:
        return None, "attestation payload isn't JSON"
