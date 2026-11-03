"""The WorkOS sign-in e2e stack (todo9 Phase 13): WorkOS Emulate, the api in `workos` mode
pointing at it, and Vite with `<envPrefix>WEB_AUTH_MODE=workos` proxying `/api` to that api.
See README.md next to this file.

    from stack import AuthStack, sign_in        # with tests/e2e/auth on sys.path
    with AuthStack() as st:                    # or AuthStack(web=False) for api-only tests
        cookie = st.sign_in("member@example.com", "test-password-member")   # "<ns>_session=…"
        ...

    python3 tests/e2e/auth/stack.py up [--agent | --no-web]   # start it, print the env, wait for ^C

Sign-in never drives a hosted page: the password is checked with a password grant on the WorkOS
API, then the api's own login → Emulate's authorize (it issues a code without a page) → the
api's callback mint the session cookie, exactly as a browser's sign-in would (user and
membership mirrored, personal org bootstrapped). Standard library only, so it runs in any of
the repo's Python environments.

Env-var names come from schemas/naming.json (`envPrefix`), never a literal product name.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
NAMING = json.loads((REPO / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]
SESSION_COOKIE = f"{NAMING['namespace']}_session"
STATE_COOKIE = f"{NAMING['namespace']}_auth_state"

EMULATE_IMAGE = "ghcr.io/workos/emulate:0.18.0"
EMULATE_NPM = "@workos/emulate@0.18.0"
SEED = REPO / "infra" / "workos" / "emulate.yaml"
API_KEY, CLIENT_ID = "sk_test_default", "client_emulated"

# infra/workos/emulate.yaml
ACME, GLOBEX = "org_01JTODO9ACME000000000000AC", "org_01JTODO9GLOBEX0000000000GL"
USERS = {
    "admin": ("admin@example.com", "test-password-admin"),  # Acme admin, Globex member (multi-org)
    "member": ("member@example.com", "test-password-member"),  # Acme member
    "billing": ("billing@example.com", "test-password-billing"),  # Acme billing
}

# <envPrefix>E2E_AUTH_PORT_BASE=N puts Emulate on N, the api on N+1, Vite on N+2, the agent on N+3.
_BASE = int(os.environ.get(f"{P}E2E_AUTH_PORT_BASE") or 58700)


def log(msg: str) -> None:
    print(f"[auth-stack] {msg}", flush=True)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_a, **_k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def request(method: str, url: str, *, body: object | None = None, headers: dict[str, str] | None = None, timeout: float = 15.0) -> tuple[int, dict[str, list[str]], bytes]:
    """One HTTP exchange without following redirects: (status, headers by lower-case name, body)."""
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        r = _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        r = e
    hdrs: dict[str, list[str]] = {}
    for k, v in r.headers.items():
        hdrs.setdefault(k.lower(), []).append(v)
    return r.status if hasattr(r, "status") else r.code, hdrs, r.read()


def wait_for(url: str, what: str, timeout: float = 90.0, proc: subprocess.Popen | None = None) -> None:
    deadline, last = time.monotonic() + timeout, ""
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"{what} exited ({proc.returncode}) before answering {url}")
        try:
            status, _, body = request("GET", url, timeout=2.0)
            if status < 500:
                return
            last = f"{status} {body[:200]!r}"
        except (OSError, http.client.HTTPException) as e:
            last = type(e).__name__
        time.sleep(0.3)
    raise RuntimeError(f"{what} not ready at {url}: {last}")


def _cookie_value(set_cookies: list[str], name: str) -> str | None:
    for h in set_cookies:
        first = h.split(";", 1)[0]
        if first.startswith(f"{name}="):
            v = first[len(name) + 1:]
            return v.strip('"') or None
    return None


def password_grant(emulate_url: str, email: str, password: str, organization: str | None = None) -> dict:
    """WorkOS `authenticate` with a password; completes `organization_selection_required` with
    `organization` when given. Raises `SignInError` with WorkOS's answer otherwise."""
    url = f"{emulate_url}/user_management/authenticate"
    status, _, raw = request("POST", url, body={"client_id": CLIENT_ID, "client_secret": API_KEY, "grant_type": "password", "email": email, "password": password})
    body = json.loads(raw or b"{}")
    if status != 200 and body.get("code") == "organization_selection_required" and organization:
        status, _, raw = request("POST", url, body={"client_id": CLIENT_ID, "client_secret": API_KEY, "grant_type": "urn:workos:oauth:grant-type:organization-selection", "pending_authentication_token": body["pending_authentication_token"], "organization_id": organization})
        body = json.loads(raw or b"{}")
    if status != 200 and body.get("code") != "organization_selection_required":
        raise SignInError(f"WorkOS refused {email}: {status} {body}")
    return body


class SignInError(RuntimeError):
    pass


def sign_in(email: str, password: str, *, base: str, emulate_url: str, organization: str | None = None, return_to: str = "/") -> str:
    """Sign `email` in and return the session cookie as `"<ns>_session=<sealed>"` (a `Cookie`
    header value; `playwright_cookie` turns it into a browser cookie).

    `base` is the origin that serves `/api/auth/*` (Vite, or the api itself); `emulate_url` the
    emulator the api talks to; `organization` a WorkOS org id for people in several."""
    password_grant(emulate_url, email, password, organization)  # the credential check
    q = {"login_hint": email, "return_to": return_to, **({"organization_id": organization} if organization else {})}
    status, h, raw = request("GET", f"{base}/api/auth/login?{urlencode(q)}")
    if status != 302:
        raise SignInError(f"/api/auth/login answered {status}: {raw[:300]!r} (is the api in workos mode?)")
    state = _cookie_value(h.get("set-cookie", []), STATE_COOKIE)
    status, h2, raw = request("GET", h["location"][0])
    if status not in (302, 303):
        raise SignInError(f"the emulator's authorize answered {status}: {raw[:300]!r}")
    callback = urlsplit(h2["location"][0])
    params = {k: v[0] for k, v in parse_qs(callback.query).items()}
    status, h3, raw = request("GET", f"{base}/api/auth/callback?{urlencode(params)}", headers={"Cookie": f"{STATE_COOKIE}={state}"})
    sealed = _cookie_value(h3.get("set-cookie", []), SESSION_COOKIE)
    if status != 302 or not sealed:
        raise SignInError(f"/api/auth/callback answered {status}: {raw[:300]!r}")
    return f"{SESSION_COOKIE}={sealed}"


def playwright_cookie(cookie: str, origin: str) -> dict:
    """A `sign_in` result as a cookie for `BrowserContext.add_cookies` on `origin`."""
    name, value = cookie.split("=", 1)
    return {"name": name, "value": value, "url": origin, "httpOnly": True, "sameSite": "Lax"}


def session_of(base: str, cookie: str) -> dict:
    status, _, raw = request("GET", f"{base}/api/auth/session", headers={"Cookie": cookie})
    if status != 200:
        raise SignInError(f"/api/auth/session answered {status}: {raw[:300]!r}")
    return json.loads(raw)


def fernet_key() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()


# ---- The stack ----------------------------------------------------------------------------------


AGENT_TOKEN = "e2e-agent-token"
AGENT_SCRIPT = REPO / "tests" / "e2e" / "fixtures" / "agent-script.json"


class AuthStack:
    """Emulate (docker, else npx), the api (uvicorn, SQLite in a temp dir), with `web=True` Vite,
    and with `agent=True` the agent (scripted model, no sandbox) in workos mode behind Vite.
    `<envPrefix>E2E_WORKOS_EMULATE_URL` reuses a running emulator instead (it must have been
    started with `--issuer` equal to that URL and seeded with infra/workos/emulate.yaml)."""

    def __init__(self, web: bool = True, agent: bool = False, base_port: int = _BASE, agent_script: Path = AGENT_SCRIPT, worker: bool = False):
        self.web, self.agent, self.worker = web or agent, agent, worker
        self.worker_token = secrets.token_urlsafe(24)
        self.agent_script = agent_script
        self.emulate_port, self.api_port, self.web_port, self.agent_port = base_port, base_port + 1, base_port + 2, base_port + 3
        self.emulate_url = (os.environ.get(f"{P}E2E_WORKOS_EMULATE_URL") or "").rstrip("/") or f"http://localhost:{self.emulate_port}"
        self.api = f"http://127.0.0.1:{self.api_port}"
        self.origin = f"http://localhost:{self.web_port}"
        self.cookie_password = fernet_key()
        self.procs: list[tuple[str, subprocess.Popen]] = []
        self.specs: dict[str, tuple[list[str], dict[str, str], Path]] = {}
        self.container: str | None = None
        self.tmp = Path(tempfile.mkdtemp(prefix="auth-e2e-"))

    @property
    def base(self) -> str:
        """Where `/api/auth/*` is reached: Vite when it runs, else the api."""
        return self.origin if self.web else self.api

    # -- lifecycle

    def __enter__(self) -> AuthStack:
        try:
            self.start()
        except BaseException:
            self.stop()
            raise
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()

    def _spawn(self, name: str, cmd: list[str], env: dict[str, str], cwd: Path) -> subprocess.Popen:
        out = open(self.tmp / f"{name}.log", "ab")  # noqa: SIM115 — closed with the process
        proc = subprocess.Popen(cmd, env={**os.environ, **env}, cwd=cwd, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        self.procs.append((name, proc))
        self.specs[name] = (cmd, env, cwd)
        return proc

    def restart(self, *names: str) -> None:
        """Stop `names` (e.g. "api", "agent") and start them again with the same command, env and
        data (the SQLite file and the agent's data dir live in `self.tmp`): a redeploy, locally."""
        for name in names:
            for i, (n, proc) in enumerate(self.procs):
                if n == name:
                    self._kill(proc)
                    del self.procs[i]
                    break
            cmd, env, cwd = self.specs[name]
            proc = self._spawn(name, cmd, env, cwd)
            ready = {"api": f"{self.api}/healthz", "agent": f"http://127.0.0.1:{self.agent_port}/health/live", "web": f"{self.origin}/"}.get(name)
            if ready:
                wait_for(ready, name, timeout=120, proc=proc)
            log(f"restarted {name}")

    @staticmethod
    def _kill(proc: subprocess.Popen) -> None:
        if proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def start(self) -> None:
        if not os.environ.get(f"{P}E2E_WORKOS_EMULATE_URL"):
            self._start_emulate()
        wait_for(f"{self.emulate_url}/health", "WorkOS Emulate", timeout=60)
        issuer = f"{self.emulate_url}/user_management/{CLIENT_ID}"
        api_env = {
            f"{P}API_AUTH_MODE": "workos",
            f"{P}API_WORKOS_API_KEY": API_KEY,
            f"{P}API_WORKOS_CLIENT_ID": CLIENT_ID,
            f"{P}API_WORKOS_COOKIE_PASSWORD": self.cookie_password,
            f"{P}API_WORKOS_REDIRECT_URI": f"{self.origin}/api/auth/callback",
            f"{P}API_WORKOS_ISSUER": issuer,
            f"{P}API_WORKOS_BASE_URL": self.emulate_url,
            f"{P}API_PUBLIC_URL": self.origin,
            f"{P}API_DEV_TRUST_HEADERS": "0",
            f"{P}API_DATA_DIR": str(self.tmp / "api"),
            f"{P}API_DATABASE_URL": f"sqlite:///{self.tmp / 'api.db'}",
            f"{P}API_SECRET_KEY": secrets.token_urlsafe(32),
            f"{P}API_WORKER_TOKEN": self.worker_token,
        }
        (self.tmp / "api").mkdir(exist_ok=True)
        api = self._spawn("api", ["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--host", "127.0.0.1", "--port", str(self.api_port), "--log-level", "warning"], api_env, REPO / "apps" / "api")
        wait_for(f"{self.api}/healthz", "api", timeout=120, proc=api)
        log(f"api (workos mode) on {self.api}, Emulate on {self.emulate_url}")
        if self.worker:  # inspection and conversion of imports (drops)
            self._spawn("worker", ["uv", "run", "--package", "studio-worker", "studio-worker", "--kernel", self.api], {f"{P}API_WORKER_TOKEN": self.worker_token}, REPO)
            log("worker")
        if self.agent:
            agent_env = {
                f"{P}ENV": "test", f"{P}AGENT_MODEL": "scripted", f"{P}AGENT_SCRIPT": str(self.agent_script), f"{P}AGENT_SANDBOX": "off",
                f"{P}AGENT_PORT": str(self.agent_port), f"{P}AGENT_DATA_DIR": str(self.tmp / "agent"), f"{P}AGENT_TOKEN": AGENT_TOKEN,
                f"{P}AGENT_AUTH_MODE": "workos", f"{P}AGENT_WORKOS_CLIENT_ID": CLIENT_ID, f"{P}AGENT_WORKOS_ISSUER": issuer,
                f"{P}AGENT_WORKOS_BASE_URL": self.emulate_url, f"{P}API_URL": self.api, f"{P}LOG_LEVEL": "warn",
            }
            agent = self._spawn("agent", ["pnpm", "--filter", "@studio/agent", "start:dev"], agent_env, REPO)
            wait_for(f"http://127.0.0.1:{self.agent_port}/health/live", "agent", timeout=120, proc=agent)
            log(f"agent (workos mode, scripted model) on 127.0.0.1:{self.agent_port}")
        if self.web:
            web_env = {f"{P}E2E": "1", f"{P}API_URL": self.api, f"{P}WEB_AUTH_MODE": "workos"}
            if self.agent:
                web_env |= {f"{P}AGENT_URL": f"http://127.0.0.1:{self.agent_port}", f"{P}AGENT_TOKEN": AGENT_TOKEN}
            web = self._spawn("web", ["pnpm", "exec", "vite", "--port", str(self.web_port), "--strictPort"], web_env, REPO / "apps" / "web")
            wait_for(f"{self.origin}/", "Vite", timeout=120, proc=web)
            log(f"web (WEB_AUTH_MODE=workos) on {self.origin}")

    def _start_emulate(self) -> None:
        cmd = ["--seed", "/seed/emulate.yaml", "--issuer", self.emulate_url]
        if shutil.which("docker") and subprocess.run(["docker", "info"], capture_output=True).returncode == 0:
            self.container = f"auth-e2e-emulate-{self.emulate_port}"
            subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
            subprocess.run(["docker", "run", "-d", "--rm", "--name", self.container, "-p", f"{self.emulate_port}:4100", "-v", f"{SEED}:/seed/emulate.yaml:ro",
                            EMULATE_IMAGE, "--host", "0.0.0.0", *cmd], check=True, capture_output=True)
            log(f"Emulate in docker ({self.container})")
            return
        if not shutil.which("npx"):
            raise RuntimeError("WorkOS Emulate needs docker or npx")
        cmd = ["--port", str(self.emulate_port), "--seed", str(SEED), "--issuer", self.emulate_url]
        self._spawn("emulate", ["npx", "--yes", EMULATE_NPM, *cmd], {"NO_UPDATE_NOTIFIER": "1", "WORKOS_EMULATE_DISABLE_UPDATE_CHECK": "1"}, REPO)
        log("Emulate via npx")

    def stop(self) -> None:
        for name, proc in reversed(self.procs):
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                    proc.wait(timeout=10)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            log(f"stopped {name}")
        self.procs.clear()
        if self.container:
            subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
            log(f"removed {self.container}")
            self.container = None

    def logs(self, name: str, tail: int = 3000) -> str:
        f = self.tmp / f"{name}.log"
        return f.read_text(errors="replace")[-tail:] if f.exists() else ""

    # -- signing in

    def sign_in(self, email: str, password: str, organization: str | None = None, return_to: str = "/") -> str:
        return sign_in(email, password, base=self.base, emulate_url=self.emulate_url, organization=organization, return_to=return_to)

    def env(self) -> dict[str, str]:
        """What other tests read to use this stack (tests/e2e/agent_auth_test.py, apps/web/e2e/auth_test.py)."""
        return {f"{P}E2E_AUTH_BASE": self.base, f"{P}E2E_WORKOS_EMULATE_URL": self.emulate_url}


def main() -> int:
    if sys.argv[1:2] != ["up"]:
        print(__doc__)
        return 2
    web, agent = "--no-web" not in sys.argv, "--agent" in sys.argv
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))  # `kill` cleans up too
    with AuthStack(web=web, agent=agent) as st:
        a = st.sign_in(*USERS["member"])
        b = st.sign_in(*USERS["admin"], organization=GLOBEX)
        for k, v in {**st.env(), f"{P}E2E_COOKIE_A": a, f"{P}E2E_COOKIE_B": b}.items():
            print(f"export {k}='{v}'")
        print(f"# logs in {st.tmp}; Ctrl-C stops everything", flush=True)
        try:
            while all(p.poll() is None for _, p in st.procs):
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
