"""The WorkOS sign-in stack end to end (todo9 Phase 13): Emulate + api (workos mode) + Vite
(WEB_AUTH_MODE=workos). No browser: it checks what the browser tests build on.

    python3 tests/e2e/auth/smoke_test.py            # starts and stops its own stack
    python3 tests/e2e/auth/smoke_test.py --no-web   # api only

Covers: signed out is 401 through the proxy; password sign-in for each seeded person lands in
the right organization with the right permissions; the multi-org person picks an organization
and switches; `/api/auth/verify` hands the agent proxy a token; logout clears the cookie; the
org boundary holds through the proxy; a wrong password is refused.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stack import ACME, GLOBEX, USERS, AuthStack, SignInError, request, session_of  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def call(base: str, method: str, path: str, cookie: str | None = None, body: object | None = None) -> tuple[int, object, dict]:
    headers = {"X-Requested-With": "fetch", **({"Cookie": cookie} if cookie else {})}
    status, h, raw = request(method, base + path, body=body, headers=headers)
    try:
        return status, json.loads(raw) if raw else None, h
    except ValueError:
        return status, raw.decode(errors="replace"), h


def run(st: AuthStack) -> None:
    base = st.base
    status, _, _ = call(base, "GET", "/api/auth/session")
    check("signed out: /api/auth/session is 401", status == 401, f"got {status}")
    status, _, _ = call(base, "GET", "/api/v1/projects")
    check("signed out: /api/v1/projects is 401", status == 401, f"got {status}")

    if st.web:
        status, _, _ = call(base, "GET", "/api/agent/status")
        check("signed out: the agent proxy answers 401 itself", status == 401, f"got {status}")

    member = st.sign_in(*USERS["member"])
    s = session_of(base, member)
    check("member signs in into Acme", s["organization"]["workosOrgId"] == ACME and s["permissions"] == ["project:create"], json.dumps(s["organization"]))

    billing = st.sign_in(*USERS["billing"])
    s = session_of(base, billing)
    check("billing has billing:manage only", s["permissions"] == ["billing:manage"], str(s["permissions"]))

    admin = st.sign_in(*USERS["admin"], organization=ACME)
    s = session_of(base, admin)
    check("admin picks Acme and is its admin", s["organization"]["workosOrgId"] == ACME and "members:manage" in s["permissions"])
    check("admin's switcher lists both organizations", {o["workosOrgId"] for o in s["organizations"]} == {ACME, GLOBEX})

    status, body, h = call(base, "POST", "/api/auth/switch-org", admin, {"organizationId": GLOBEX})
    rotated = [c for c in h.get("set-cookie", []) if c.startswith(member.split("=", 1)[0] + "=")]
    check("switch-org into Globex", status == 200 and body == {"ok": True} and bool(rotated), f"{status} {body}")
    if rotated:
        admin = rotated[0].split(";", 1)[0]
        s = session_of(base, admin)
        check("in Globex the admin is a member", s["organization"]["workosOrgId"] == GLOBEX and s["role"] == "member", s["role"])

    status, _, h = call(st.api, "GET", "/api/auth/verify", member)
    check("verify hands the agent proxy the access token", status == 200 and bool(h.get("x-access-token")), f"got {status}")

    status, body, _ = call(base, "POST", "/api/v1/projects", member, {"title": "Acme e2e"})
    pid = body.get("id") if isinstance(body, dict) else None
    check("member creates a project in Acme", status == 201 and bool(pid), f"{status} {body}")
    if pid:
        status, _, _ = call(base, "GET", f"/api/v1/projects/{pid}", admin)  # admin is in Globex now
        check("org boundary: Globex can't see it (404)", status == 404, f"got {status}")
        status, _, _ = call(base, "GET", f"/api/v1/projects/{pid}", billing)
        check("billing (not a project member) can't see it (404)", status == 404, f"got {status}")

    status, body, h = call(base, "POST", "/api/auth/logout", member)
    cleared = any(c.startswith(member.split("=", 1)[0] + "=") and "max-age=0" in c.lower() for c in h.get("set-cookie", []))
    check("logout returns the WorkOS logout URL and clears the cookie", status == 200 and "session_id=" in str((body or {}).get("url")) and cleared, f"{status} {body}")

    try:
        st.sign_in("member@example.com", "wrong-password")
        check("a wrong password is refused", False, "signed in")
    except SignInError as e:
        check("a wrong password is refused", "invalid_credentials" in str(e), str(e)[:120])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-web", action="store_true", help="api only (no Vite)")
    args = ap.parse_args()
    with AuthStack(web=not args.no_web) as st:
        try:
            run(st)
        except Exception as e:  # noqa: BLE001
            check("stack run", False, f"{type(e).__name__}: {e}")
            print(st.logs("api"), file=sys.stderr)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
