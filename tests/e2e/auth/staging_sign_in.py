"""Nightly against WorkOS staging (todo9 Phase 13): one password sign-in through the WorkOS API
with the staging test user, and the access token verified against the environment's JWKS, the
way the api verifies it. Run by .github/workflows/auth-nightly.yml; never prints a secret.

    <envPrefix>E2E_WORKOS_API_KEY    staging environment key (sk_test_…)
    <envPrefix>E2E_WORKOS_CLIENT_ID  staging client id (client_…)
    <envPrefix>E2E_WORKOS_EMAIL      the staging test user (password sign-in enabled, no MFA)
    <envPrefix>E2E_WORKOS_PASSWORD   its password
    <envPrefix>E2E_WORKOS_ISSUER     optional: the expected `iss` (the api's API_WORKOS_ISSUER)
    <envPrefix>E2E_WORKOS_BASE_URL   optional: default https://api.workos.com

    uv run --package studio-api python tests/e2e/auth/staging_sign_in.py

Env-var names come from schemas/naming.json (`envPrefix`); never the SDK's unprefixed WORKOS_*.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import jwt

REPO = Path(__file__).resolve().parents[3]
P = json.loads((REPO / "schemas" / "naming.json").read_text())["envPrefix"]


def need(name: str) -> str:
    v = os.environ.get(f"{P}{name}")
    if not v:
        raise SystemExit(f"{P}{name} is not set")
    return v


def post(url: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "User-Agent": "auth-nightly"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except ValueError:
            return e.code, {}


def main() -> int:
    key, client_id = need("E2E_WORKOS_API_KEY"), need("E2E_WORKOS_CLIENT_ID")
    email, password = need("E2E_WORKOS_EMAIL"), need("E2E_WORKOS_PASSWORD")
    base = (os.environ.get(f"{P}E2E_WORKOS_BASE_URL") or "https://api.workos.com").rstrip("/")
    url = f"{base}/user_management/authenticate"
    creds = {"client_id": client_id, "client_secret": key}

    status, body = post(url, {**creds, "grant_type": "password", "email": email, "password": password})
    if status != 200 and body.get("code") == "organization_selection_required":
        org = body["organizations"][0]["id"]
        status, body = post(url, {**creds, "grant_type": "urn:workos:oauth:grant-type:organization-selection", "pending_authentication_token": body["pending_authentication_token"], "organization_id": org})
    if status != 200:
        # Only WorkOS's error code: its message can quote the email.
        print(f"FAIL password sign-in: {status} {body.get('code') or body.get('error') or 'error'}")
        return 1
    print("PASS password sign-in")

    token = body["access_token"]
    signing_key = jwt.PyJWKClient(f"{base}/sso/jwks/{client_id}", timeout=10).get_signing_key_from_jwt(token).key
    issuer = os.environ.get(f"{P}E2E_WORKOS_ISSUER") or None
    claims = jwt.decode(token, signing_key, algorithms=["RS256"], options={"verify_aud": False, "verify_iss": issuer is not None}, issuer=issuer, leeway=5)
    ok = claims.get("sub") == body["user"]["id"] and claims.get("exp", 0) > time.time() and bool(claims.get("sid"))
    print(("PASS" if ok else "FAIL") + f" access token verifies against the JWKS (org {'yes' if claims.get('org_id') else 'none'}, {len(claims.get('permissions') or [])} permissions)")
    if not body.get("refresh_token"):
        print("FAIL no refresh token")
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
