"""Service-to-service auth for apps/versioning (todo4 V4, V5).

The API mints a short-lived (60 s) Ed25519-signed JWT for every call: tenant (an
organisation; `default` in dev), project (the workspace), the actor (user, agent with
`on_behalf_of`, or service), the scopes the operation needs, the request id and the
service's audience. apps/versioning verifies it with the public key in
`<envPrefix>VERSIONING_JWT_PUBLIC_KEY_FILE` (a JWKS file) and re-checks scope against its own
rows. In dev the key pair is generated under apps/api/.data on first use.

The service wants uuids for tenant and project, so the kernel's string ids map to stable
uuid5s: the same workspace always lands in the same versioning project.
"""

from __future__ import annotations

import base64
import json
import os
import time
import uuid
from functools import cache
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ...config import settings
from ...context import RequestContext
from ...naming import naming

KID = "api-dev"
LIFETIME_S = 60

# Scopes apps/versioning understands (internal/authn).
READ, WRITE, REVIEW, APPROVE, MERGE, RELEASE, CHECKOUT, CHECKS, ADMIN = (
    "versioning:read",
    "versioning:write",
    "versioning:review",
    "versioning:approve",
    "versioning:merge",
    "versioning:release",
    "versioning:checkout",
    "versioning:checks",
    "versioning:admin",
)


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def key_paths() -> tuple[Path, Path]:
    s = settings()
    return (s.versioning_key_file or s.data_dir / "versioning-jwt.key", s.versioning_jwks_file or s.data_dir / "versioning-jwks.json")


def _write_jwks(key: Ed25519PrivateKey, path: Path) -> None:
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"keys": [{"kty": "OKP", "crv": "Ed25519", "kid": KID, "x": _b64(raw), "use": "sig", "alg": "EdDSA"}]}))


@cache
def _key(key_file: str, jwks_file: str) -> Ed25519PrivateKey:
    kp, jp = Path(key_file), Path(jwks_file)
    if kp.is_file():
        key = serialization.load_pem_private_key(kp.read_bytes(), password=None)
        assert isinstance(key, Ed25519PrivateKey), "versioning JWT key must be Ed25519"
    else:
        key = Ed25519PrivateKey.generate()
        kp.parent.mkdir(parents=True, exist_ok=True)
        kp.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.chmod(kp, 0o600)
    if not jp.is_file():
        _write_jwks(key, jp)
    return key


def signing_key() -> Ed25519PrivateKey:
    """The API's private key, generating the dev pair (and the service's JWKS file) if absent."""
    kp, jp = key_paths()
    return _key(str(kp), str(jp))


def tenant_uuid() -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{naming()['resourcePrefix']}:tenant:{settings().versioning_tenant}"))


def project_uuid(workspace_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"{naming()['resourcePrefix']}:workspace:{workspace_id}"))


def is_agent(ctx: RequestContext) -> bool:
    return ctx.principal.startswith("agent:")


def actor_of(ctx: RequestContext) -> dict:
    """user:… → user, agent:… → agent (acting for whoever minted its session), else service."""
    if is_agent(ctx):
        return {"id": ctx.principal, "kind": "agent", "on_behalf_of": ctx.on_behalf_of or "user:unattributed"}
    if ctx.principal.startswith("user:"):
        return {"id": ctx.principal, "kind": "user"}
    return {"id": ctx.principal.replace("@", ".")[:128] or "service", "kind": "service"}


def mint(ctx: RequestContext, scopes: list[str], *, lifetime_s: int = LIFETIME_S) -> str:
    """A token for one call: only the scopes this operation needs."""
    now = int(time.time())
    actor = actor_of(ctx)
    s = settings()
    claims = {
        "iss": s.versioning_issuer,
        "aud": [s.versioning_audience],
        "sub": actor["id"],
        "iat": now,
        "exp": now + lifetime_s,
        "tenant_id": tenant_uuid(),
        "project_id": project_uuid(ctx.workspace_id),
        "actor": actor,
        "scopes": sorted(set(scopes)),
        "request_id": ctx.correlation_id,
    }
    header = {"alg": "EdDSA", "typ": "JWT", "kid": KID}
    signing_input = f"{_b64(json.dumps(header, separators=(',', ':')).encode())}.{_b64(json.dumps(claims, separators=(',', ':')).encode())}"
    return f"{signing_input}.{_b64(signing_key().sign(signing_input.encode()))}"


def decode_unverified(token: str) -> dict:
    """Claims of a token (tests and debugging only; the service is what verifies)."""
    body = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
