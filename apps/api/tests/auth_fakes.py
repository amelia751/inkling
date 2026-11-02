"""A fake WorkOS for the todo9 auth tests: no network. Access tokens are real RS256 JWTs signed
with a test key, so the api's verification path runs for real; the JWKS lookup is patched."""

from __future__ import annotations

import time
import uuid
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlencode

import jwt
import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import rsa

from studio_api.auth import bootstrap
from studio_api.auth import client as wclient

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
COOKIE_PASSWORD = Fernet.generate_key().decode()
REDIRECT = "http://localhost:5173/api/auth/callback"
ADMIN_PERMS = ["org:manage", "members:manage", "billing:manage", "apikeys:manage", "audit:read", "project:create"]
MEMBER_PERMS = ["project:create"]


def workos_settings(**extra) -> dict:
    return {"auth_mode": "workos", "workos_api_key": "sk_test_fake", "workos_client_id": "client_fake", "workos_cookie_password": COOKIE_PASSWORD, "workos_redirect_uri": REDIRECT, **extra}


def token(sub: str, org: str | None = None, perms: list[str] | None = None, *, ttl: int = 300, role: str | None = None, sid: str = "session_1") -> str:
    now = int(time.time())
    claims: dict[str, Any] = {"sub": sub, "sid": sid, "iat": now, "exp": now + ttl, "permissions": perms or []}
    if org:
        claims["org_id"] = org
        claims["role"] = role or ("admin" if perms == ADMIN_PERMS else "member")
    return jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": "test"})


def user(sub: str, email: str | None = None) -> dict:
    return {"object": "user", "id": sub, "email": email or f"{sub}@example.com", "first_name": "Ada", "last_name": "Lovelace", "profile_picture_url": None, "email_verified": True, "external_id": None, "last_sign_in_at": None, "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z"}


def sealed(sub: str, org: str | None, perms: list[str] | None = None, *, ttl: int = 300, refresh_token: str = "rt_1") -> str:
    from workos.session import seal_session_from_auth_response

    return seal_session_from_auth_response(access_token=token(sub, org, perms, ttl=ttl), refresh_token=refresh_token, user=user(sub), impersonator=None, cookie_password=COOKIE_PASSWORD)


def auth_response(sub: str, org: str | None, perms: list[str] | None = None, refresh_token: str = "rt_2") -> Any:
    u = user(sub)
    return SimpleNamespace(user=SimpleNamespace(to_dict=lambda: dict(u)), access_token=token(sub, org, perms), refresh_token=refresh_token, impersonator=None, organization_id=org)


class _Page:
    def __init__(self, items: list):
        self.data = items

    async def auto_paging_iter(self):
        for i in self.data:
            yield i


class FakeWorkOS:
    """Records calls; `refresh_error` (an exception) makes the next refreshes fail."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.code_user: dict[str, Any] = {"sub": "user_A", "org": None, "perms": []}
        self.refresh_error: Exception | None = None
        self.orgs: dict[str, str] = {}  # external id → workos id
        self.org_perms: dict[str, list[str]] = {}
        self.memberships: list[Any] = []
        fake = self

        class UM:
            def get_authorization_url(self, **kw):
                fake.calls.append(("authorize", kw))
                return "https://auth.example.test/authorize?" + urlencode({k: v for k, v in kw.items() if v is not None})

            async def authenticate_with_code(self, **kw):
                fake.calls.append(("code", kw))
                u = fake.code_user
                return auth_response(u["sub"], u["org"], u["perms"])

            async def authenticate_with_refresh_token(self, **kw):
                fake.calls.append(("refresh", kw))
                if fake.refresh_error is not None:
                    raise fake.refresh_error
                org = kw.get("organization_id") or fake.code_user.get("org") or "org_W1"
                return auth_response(fake.code_user["sub"], org, fake.org_perms.get(org, ADMIN_PERMS), refresh_token=f"rt_{uuid.uuid4().hex[:6]}")

            def get_logout_url(self, *, session_id, return_to=None):
                fake.calls.append(("logout", {"session_id": session_id}))
                return f"https://auth.example.test/logout?session_id={session_id}"

        class Orgs:
            async def get_organization_by_external_id(self, external_id):
                from workos._errors import NotFoundError

                if external_id in fake.orgs:
                    return SimpleNamespace(id=fake.orgs[external_id])
                raise NotFoundError("not found")

            async def create_organization(self, *, name, external_id=None, **_):
                fake.calls.append(("create_org", {"name": name, "external_id": external_id}))
                fake.orgs[external_id] = f"org_P{len(fake.orgs) + 1}"
                return SimpleNamespace(id=fake.orgs[external_id], name=name)

        class Memberships:
            async def create_organization_membership(self, *, user_id, organization_id, role=None):
                fake.calls.append(("create_membership", {"user_id": user_id, "organization_id": organization_id, "role": getattr(role, "role_slug", None)}))
                return SimpleNamespace(id=f"om_{user_id}_{organization_id}")

            async def list_organization_memberships(self, **kw):
                return _Page(fake.memberships)

        self.user_management, self.organizations, self.organization_membership = UM(), Orgs(), Memberships()

    def count(self, name: str) -> int:
        return sum(1 for n, _ in self.calls if n == name)


@pytest.fixture
def fake_workos(monkeypatch):
    fake = FakeWorkOS()
    wclient.reset()
    bootstrap.forget_memberships()
    monkeypatch.setattr(wclient, "signing_key", lambda _t: KEY.public_key())
    wclient.set_client(fake)
    yield fake
    wclient.reset()
    bootstrap.forget_memberships()


def signed_in(client, sub: str, org: str | None, perms: list[str] | None = None, **kw) -> None:
    from studio_api.auth.cookie import session_cookie_name

    # The domain httpx files the server's host-only cookies under, so a refresh replaces this one.
    client.cookies.set(session_cookie_name(), sealed(sub, org, perms, **kw), domain="testserver.local")


FETCH = {"X-Requested-With": "fetch"}
