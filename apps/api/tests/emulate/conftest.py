"""WorkOS Emulate fixtures (todo9 Phase 13): the api in `workos` mode against a real emulator.

The emulator is found at `<envPrefix>TEST_WORKOS_EMULATE_URL` (default `http://localhost:4100`,
the compose service `workos-emulate` of `pnpm infra:up`), seeded with infra/workos/emulate.yaml.
When nothing answers there every test here is skipped, unless
`<envPrefix>TEST_WORKOS_EMULATE_REQUIRED=1` (CI), which turns the skip into a failure.

    docker run -d --rm --name emulate -p 4100:4100 \\
      -v "$PWD/infra/workos/emulate.yaml:/seed/emulate.yaml:ro" ghcr.io/workos/emulate:0.18.0 \\
      --host 0.0.0.0 --seed /seed/emulate.yaml --issuer http://localhost:4100
    uv run --package studio-api pytest apps/api/tests/emulate -q

The api reaches the emulator through `FaultProxy`, a local forwarding proxy that counts requests
and can answer refresh-token grants with a 5xx (fault injection). People sign in by password
through the WorkOS API and the test injects the sealed cookie (`Emulate.sign_in`), or through
the api's own login and callback, with Emulate's non-interactive authorize standing in for the
hosted page (`Emulate.callback_sign_in`). Hosted AuthKit is never driven.

The emulator's state lives as long as its process: tests create their own users when they need
a fresh person, and never assume a clean slate.
"""

from __future__ import annotations

import json
import threading
import uuid
from collections import Counter
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
import pytest
from cryptography.fernet import Fernet

from studio_api.auth import bootstrap
from studio_api.auth import client as wclient
from studio_api.auth import session as wsession
from studio_api.auth.cookie import session_cookie_name
from studio_api.config import env

API_KEY = "sk_test_default"
CLIENT_ID = "client_emulated"
REDIRECT = "http://localhost:5173/api/auth/callback"
PUBLIC_URL = "http://localhost:5173"
FETCH = {"X-Requested-With": "fetch"}
COOKIE_DOMAIN = "testserver.local"  # where httpx files the TestClient's host-only cookies

# infra/workos/emulate.yaml
ACME, GLOBEX = "org_01JTODO9ACME000000000000AC", "org_01JTODO9GLOBEX0000000000GL"
USERS = {
    "admin": ("admin@example.com", "test-password-admin"),
    "member": ("member@example.com", "test-password-member"),
    "billing": ("billing@example.com", "test-password-billing"),
}
ADMIN_PERMS = {"org:manage", "members:manage", "billing:manage", "apikeys:manage", "audit:read", "project:create"}


def _emulate_url() -> str:
    return (env("TEST_WORKOS_EMULATE_URL") or "http://localhost:4100").rstrip("/")


def _required() -> bool:
    return (env("TEST_WORKOS_EMULATE_REQUIRED") or "") not in ("", "0", "false")


def unverified(token: str) -> dict[str, Any]:
    return jwt.decode(token, options={"verify_signature": False})


# ---- The fault-injecting proxy ------------------------------------------------------------------


class FaultProxy:
    """Forwards everything to the emulator. `fail_refresh = 503` answers refresh-token grants
    with that status instead; `hits` counts requests by kind (`refresh`, `password`, `code`, path)."""

    def __init__(self, upstream: str):
        self.upstream = upstream
        self.fail_refresh: int | None = None
        self.hits: Counter[str] = Counter()
        self._http = httpx.Client(base_url=upstream, timeout=10.0, follow_redirects=False)
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):  # quiet
                pass

            def _forward(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) or None
                kind = urlsplit(self.path).path
                if kind.endswith("/user_management/authenticate") and body:
                    try:
                        kind = str(json.loads(body).get("grant_type", kind)).replace("refresh_token", "refresh").replace("authorization_code", "code")
                    except ValueError:
                        pass
                proxy.hits[kind] += 1
                if kind == "refresh" and proxy.fail_refresh:
                    payload = json.dumps({"message": "injected fault"}).encode()
                    self.send_response(proxy.fail_refresh)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "connection", "accept-encoding")}
                r = proxy._http.request(self.command, self.path, content=body, headers=headers)
                self.send_response(r.status_code)
                for k, v in r.headers.items():
                    if k.lower() not in ("content-length", "transfer-encoding", "connection", "content-encoding", "keep-alive"):
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(r.content)))
                self.end_headers()
                self.wfile.write(r.content)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _forward

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def reset(self) -> None:
        self.fail_refresh = None
        self.hits.clear()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._http.close()


# ---- Talking to the emulator as WorkOS (the way a sign-in would) --------------------------------


class Emulate:
    def __init__(self, url: str, proxy: FaultProxy, issuer: str):
        self.url, self.proxy, self.issuer = url, proxy, issuer
        self.cookie_password = Fernet.generate_key().decode()
        self.http = httpx.Client(base_url=url, timeout=10.0, follow_redirects=False, headers={"Authorization": f"Bearer {API_KEY}"})

    def authenticate(self, **body: Any) -> httpx.Response:
        return self.http.post("/user_management/authenticate", json={"client_id": CLIENT_ID, "client_secret": API_KEY, **body})

    def password(self, email: str, password: str, organization: str | None = None) -> dict[str, Any]:
        """A password grant; `organization_selection_required` is completed with `organization`
        (a WorkOS org id) or, when none is given, raised as an AssertionError."""
        r = self.authenticate(grant_type="password", email=email, password=password)
        body = r.json()
        if r.status_code != 200 and body.get("code") == "organization_selection_required":
            assert organization, f"{email} must choose one of {[o['id'] for o in body['organizations']]}"
            r = self.authenticate(grant_type="urn:workos:oauth:grant-type:organization-selection", pending_authentication_token=body["pending_authentication_token"], organization_id=organization)
            body = r.json()
        assert r.status_code == 200, body
        return body

    def seal(self, auth: dict[str, Any]) -> str:
        from workos.session import seal_session_from_auth_response

        return seal_session_from_auth_response(access_token=auth["access_token"], refresh_token=auth["refresh_token"], user=auth["user"], impersonator=auth.get("impersonator"), cookie_password=self.cookie_password)

    def sign_in(self, client, email: str, password: str, organization: str | None = None) -> dict[str, Any]:
        """Password sign-in through the WorkOS API; the sealed session goes into `client`'s jar."""
        auth = self.password(email, password, organization)
        client.cookies.set(session_cookie_name(), self.seal(auth), domain=COOKIE_DOMAIN)
        return auth

    def callback_sign_in(self, client, login_hint: str, **login: str) -> httpx.Response:
        """The api's login → the emulator's authorize (it issues a code without a page) → the
        api's callback. Returns the callback's response."""
        r = client.get("/api/auth/login", params={"login_hint": login_hint, **login}, follow_redirects=False)
        assert r.status_code == 302, r.text
        hop = httpx.get(r.headers["location"], follow_redirects=False, timeout=10.0)
        assert hop.status_code == 302, hop.text
        q = parse_qs(urlsplit(hop.headers["location"]).query)
        return client.get("/api/auth/callback", params={k: v[0] for k, v in q.items()}, follow_redirects=False)

    def create_user(self, password: str = "test-password-fresh") -> tuple[str, str, dict[str, Any]]:
        email = f"fresh-{uuid.uuid4().hex[:10]}@example.com"
        r = self.http.post("/user_management/users", json={"email": email, "password": password, "first_name": "Fresh", "last_name": "Person", "email_verified": True})
        assert r.status_code in (200, 201), r.text
        return email, password, r.json()

    def session_data(self, client) -> dict[str, Any]:
        from workos.session import unseal_data

        return unseal_data(client.cookies.get(session_cookie_name()), self.cookie_password)

    def close(self) -> None:
        self.http.close()


@pytest.fixture(scope="session")
def emulate() -> Iterator[Emulate]:
    url = _emulate_url()
    try:
        ok = httpx.get(f"{url}/health", timeout=2.0).status_code == 200
    except httpx.HTTPError:
        ok = False
    if not ok:
        msg = f"WorkOS Emulate isn't reachable at {url} (start it: apps/api/tests/emulate/conftest.py)"
        if _required():
            pytest.fail(msg)
        pytest.skip(msg)
    # The issuer the emulator stamps (`<--issuer>/user_management/<client id>`), from a real token.
    email, pw = USERS["member"]
    probe = httpx.post(f"{url}/user_management/authenticate", json={"client_id": CLIENT_ID, "client_secret": API_KEY, "grant_type": "password", "email": email, "password": pw}, timeout=10.0)
    assert probe.status_code == 200, f"the emulator isn't seeded with infra/workos/emulate.yaml: {probe.text}"
    issuer = unverified(probe.json()["access_token"])["iss"]
    proxy = FaultProxy(url)
    e = Emulate(url, proxy, issuer)
    yield e
    e.close()
    proxy.close()


@pytest.fixture
def eclient(make_client, emulate: Emulate, monkeypatch):
    """A TestClient for an api in workos mode, talking to the emulator through the proxy."""
    wclient.reset()
    bootstrap.forget_memberships()
    emulate.proxy.reset()
    c = make_client(
        auth_mode="workos", workos_api_key=API_KEY, workos_client_id=CLIENT_ID, workos_cookie_password=emulate.cookie_password,
        workos_redirect_uri=REDIRECT, workos_issuer=emulate.issuer, workos_base_url=emulate.proxy.url, public_url=PUBLIC_URL,
    )
    yield c
    wclient.reset()
    bootstrap.forget_memberships()


@pytest.fixture
def expire(monkeypatch, emulate: Emulate):
    """`expire(client)`: the access token in `client`'s cookie now counts as expired (the
    emulator's tokens live 5 minutes; tests don't wait). Everything else verifies for real."""
    expired: set[str] = set()
    real = wsession.decode_access_token

    def decode(token: str, *, verify_exp: bool = True) -> dict[str, Any]:
        claims = real(token, verify_exp=verify_exp)
        if verify_exp and token in expired:
            raise jwt.ExpiredSignatureError("Signature has expired")
        return claims

    monkeypatch.setattr(wsession, "decode_access_token", decode)

    def mark(client) -> str:
        token = emulate.session_data(client)["access_token"]
        expired.add(token)
        return token

    return mark


def set_cookie_headers(r) -> list[str]:
    return [v for k, v in r.headers.multi_items() if k.lower() == "set-cookie"]


def cleared(r) -> bool:
    name = session_cookie_name()
    return any(h.startswith(f"{name}=") and ("max-age=0" in h.lower() or "01 jan 1970" in h.lower()) for h in set_cookie_headers(r))
