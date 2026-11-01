"""Content-addressed artifact store and verification (todo10 Phase 3, D4/D5).

Blobs live in the BlobStore's data namespace at `artifacts/sha256/<hex>`: immutable, written
once, named by their own hash (a CDN can cache them forever). The registry entry is a
`plugin_artifacts` row. Verification runs on every load, not only at install:

    manifest digest → manifest blob → package layer → files → tree digest == the pin
    signature over the manifest digest by a trusted key (the configured Signer, or a
        trusted import key)
    the registry row's plugin.yaml == the signed config blob (permissions come from it)
    the attestation (DSSE, in-toto SLSA provenance) names this manifest

Any failure raises `oci.ArtifactRefused` with a reason; callers audit it.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from studio_signing import PublicKeyVerifier, Signer, SignerError, check_envelope, dsse_verify, make_signer, oci

from .. import blobstore
from fastapi import HTTPException

from ..config import key_name, settings
from ..context import RequestContext
from ..naming import naming

PREFIX = "artifacts/sha256/"


def media_types() -> oci.MediaTypes:
    return oci.MediaTypes.for_namespace(naming()["namespace"])


def key(digest: str) -> str:
    return PREFIX + digest.removeprefix("sha256:")


def put(blobs: dict[str, bytes], media: dict[str, str] | None = None) -> None:
    """Write-once: an existing key is never rewritten (same digest, same bytes)."""
    store = blobstore.data()
    for d, data in blobs.items():
        if oci.sha256_digest(data) != d:
            raise oci.ArtifactRefused(f"blob {d} doesn't match its digest")
        if store.stat(key(d)) is None:
            store.put(key(d), data, (media or {}).get(d) or "application/octet-stream")


def get(digest: str) -> bytes:
    try:
        return blobstore.data().read(key(digest))
    except blobstore.BlobNotFound as e:
        raise KeyError(digest) from e


# ---- keys ----------------------------------------------------------------------------------


@lru_cache(maxsize=4)
def _signer(kind: str, key_file: str, kms_key: str | None) -> Signer:
    return make_signer(kind, key_file=Path(key_file), kms_key=kms_key)


def signer() -> Signer:
    """The installation's signer (`INKLING_API_SIGNER`): signs what this kernel builds."""
    s = settings()
    if s.production and s.signer == "local" and not s.signer_key_file:
        # A key generated into a replica's /tmp would differ per pod and vanish on restart.
        raise HTTPException(503, f"plugin signing isn't configured: set {key_name('signer')}=gcpkms or {key_name('signer_key_file')}")
    return _signer(s.signer, str(s.signer_key_file or s.data_dir / "plugin-signing.key"), s.signer_kms_key)


def trusted_keys() -> dict[str, PublicKeyVerifier]:
    """Other installations' public keys accepted on import (`INKLING_API_SIGNER_TRUSTED_KEYS_FILE`:
    a JSON object `{keyId: PEM}`), e.g. the curated tier's key. Never used to sign."""
    f = settings().signer_trusted_keys_file
    if not f:
        return {}
    try:
        doc = json.loads(Path(f).read_text())
        return {k: PublicKeyVerifier(k, v) for k, v in doc.items()}
    except (OSError, ValueError, SignerError) as e:
        raise oci.ArtifactRefused(f"the trusted keys file can't be read ({e.__class__.__name__})") from e


def verifier_for(key_id: str | None) -> Signer | PublicKeyVerifier | None:
    own = signer()
    if key_id == own.key_id:
        return own
    return trusted_keys().get(key_id or "")


# ---- verification --------------------------------------------------------------------------


def check_signature(manifest_digest: str, signature: dict | None) -> str | None:
    v = verifier_for((signature or {}).get("keyId"))
    if v is None:
        return f"signed by key {(signature or {}).get('keyId')!r}, which this installation doesn't trust" if signature else "not signed"
    return check_envelope(v, manifest_digest, signature)  # type: ignore[arg-type]


def attestation(attestation_digest: str, manifest_digest: str) -> dict:
    """The verified provenance statement in the attestation referrer `attestation_digest`."""
    ref = json.loads(oci.checked(get, attestation_digest, "attestation"))
    if (ref.get("subject") or {}).get("digest") != manifest_digest or ref.get("artifactType") != oci.IN_TOTO:
        raise oci.ArtifactRefused("attestation isn't about this artifact")
    layer = (ref.get("layers") or [{}])[0]
    env = json.loads(oci.checked(get, str(layer.get("digest")), "attestation envelope"))
    keyid = ((env.get("signatures") or [{}])[0] or {}).get("keyid")
    v = verifier_for(keyid)
    if v is None:
        raise oci.ArtifactRefused(f"attestation signed by key {keyid!r}, which this installation doesn't trust")
    st, err = dsse_verify(v, env)  # type: ignore[arg-type]
    if err:
        raise oci.ArtifactRefused(err)
    assert st is not None
    if [s.get("digest", {}).get("sha256") for s in st.get("subject") or []] != [manifest_digest.removeprefix("sha256:")]:
        raise oci.ArtifactRefused("attestation statement names a different artifact")
    return st


def verify(*, manifest_digest: str | None, artifact_digest: str, signature: dict | None, manifest: dict, attestation_digest: str | None) -> dict[str, bytes]:
    """Every check above; returns the verified package files."""
    if not manifest_digest:
        raise oci.ArtifactRefused("no artifact manifest recorded for this version")
    _, files, config = oci.unpack(get, manifest_digest, media_types(), expect_tree=artifact_digest)
    if bad := check_signature(manifest_digest, signature):
        raise oci.ArtifactRefused(bad)
    if oci.canonical_json(config) != oci.canonical_json(manifest):
        raise oci.ArtifactRefused("the registry's plugin.yaml differs from the signed artifact's")
    if attestation_digest:
        attestation(attestation_digest, manifest_digest)
    return files


def audit_refusal(ctx: RequestContext, target: str, reason: str, *, where: str, manifest_digest: str | None = None) -> None:
    """Record a refusal in its own transaction, so it survives the request's error response."""
    from .. import db
    from ..kernel import audit

    with db.session_scope() as s:
        audit.record(s, ctx, "plugins.artifact.refused", target=target, after={"reason": reason, "where": where, "manifestDigest": manifest_digest})
