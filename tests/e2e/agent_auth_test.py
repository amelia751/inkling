"""The agent behind WorkOS sign-in (todo9 Phase 5). Skeleton: skips unless a workos-mode stack is up.

Needs the API in workos mode (INKLING_API_AUTH_MODE=workos, against WorkOS Emulate or staging),
the agent in workos mode (INKLING_AGENT_AUTH_MODE=workos, INKLING_AGENT_WORKOS_CLIENT_ID, and for
Emulate INKLING_AGENT_WORKOS_BASE_URL=http://localhost:4100), and the web proxy in workos mode
(Vite: INKLING_WEB_AUTH_MODE=workos with INKLING_API_URL; nginx: the same env var). Sign in as two
people in two organizations once (browser or Emulate), then hand their session cookies over:

    INKLING_E2E_COOKIE_A='<naming id>_session=…'   # person A, org A
    INKLING_E2E_COOKIE_B='<naming id>_session=…'   # person B, org B
    INKLING_E2E_PROJECT_B=<a project id in org B>  # optional: the cross-org check
    python3 tests/e2e/agent_auth_test.py --port 5173

Covers: an agent call without a session is 401; with one, the session is created and listed for
that person only (the agent recorded the verified user, not the shared local principal); person A
can't open B's conversation; A's cookie can't open org B's project (404, not 403).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMING = json.loads((ROOT / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def call(base: str, method: str, path: str, cookie: str | None = None, body: object | None = None) -> tuple[int, object]:
    headers = {"X-Requested-With": "fetch"}
    if cookie:
        headers["Cookie"] = cookie
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except ValueError:
            return e.code, raw.decode(errors="replace")


def workos_stack(base: str) -> str | None:
    """None when the stack runs in workos mode, else why the test is skipped."""
    try:
        status, body = call(base, "GET", "/api/auth/session")
    except OSError as e:
        return f"nothing answers at {base} ({e})"
    if status == 200 and isinstance(body, dict) and body.get("mode") == "dev":
        return "the API runs in dev mode"
    if status == 404:
        return "the API has no /api/auth routes yet"
    if status != 401:
        return f"unexpected /api/auth/session answer {status}"
    if not os.environ.get(f"{P}E2E_COOKIE_A") or not os.environ.get(f"{P}E2E_COOKIE_B"):
        return f"set {P}E2E_COOKIE_A and {P}E2E_COOKIE_B to two signed-in sessions"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--base", help="web origin (default http://localhost:<port>)")
    args = ap.parse_args()
    base = (args.base or f"http://localhost:{args.port}").rstrip("/")

    why = workos_stack(base)
    if why:
        print(f"SKIP agent auth: {why}", flush=True)
        return 0
    a, b = os.environ[f"{P}E2E_COOKIE_A"], os.environ[f"{P}E2E_COOKIE_B"]

    status, _ = call(base, "GET", "/api/agent/status")
    check("agent call without a session is 401", status == 401, f"got {status}")

    status, _ = call(base, "GET", "/api/agent/status", cookie=a)
    check("agent call with a session is accepted", status == 200, f"got {status}")

    _, me = call(base, "GET", "/api/auth/session", cookie=a)
    project = os.environ.get(f"{P}E2E_PROJECT_A", "demo")
    status, created = call(base, "POST", "/api/agent/sessions", cookie=a, body={"projectId": project, "profile": "assistant"})
    check("person A creates a conversation", status == 201, f"got {status} {created}")
    sid = created.get("sessionId") if isinstance(created, dict) else None
    if sid:
        _, listed = call(base, "GET", "/api/agent/sessions", cookie=a)
        ids = [s["id"] for s in (listed or {}).get("sessions", [])] if isinstance(listed, dict) else []
        check("the conversation is listed for A (recorded as the verified user)", sid in ids, f"user {me.get('user', {}).get('id') if isinstance(me, dict) else '?'}")
        _, listed_b = call(base, "GET", "/api/agent/sessions", cookie=b)
        ids_b = [s["id"] for s in (listed_b or {}).get("sessions", [])] if isinstance(listed_b, dict) else []
        check("person B doesn't see A's conversation", sid not in ids_b)
        status, _ = call(base, "GET", f"/api/agent/sessions/{sid}", cookie=b)
        check("person B can't open A's conversation", status == 404, f"got {status}")
        call(base, "DELETE", f"/api/agent/sessions/{sid}", cookie=a)

    project_b = os.environ.get(f"{P}E2E_PROJECT_B")
    if project_b:
        status, _ = call(base, "GET", f"/api/v1/projects/{project_b}", cookie=a)
        check("org A's session can't open org B's project (404)", status == 404, f"got {status}")
    else:
        print(f"SKIP cross-org project: set {P}E2E_PROJECT_B", flush=True)

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
