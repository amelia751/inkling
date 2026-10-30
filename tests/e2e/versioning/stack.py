"""Start (and stop) the dataset-versioning e2e stack: Postgres + an S3-compatible store in
Docker, apps/versioning (Go), apps/api (uvicorn) and apps/worker (the de-identification check),
all on offset localhost ports. See README.md.

Env-var names come from schemas/naming.json (`envPrefix`), never a literal product name.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
NAMING = json.loads((REPO / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]
PG = "postgres://postgres:postgres@127.0.0.1:56432/studio?sslmode=disable"
S3 = "http://127.0.0.1:59900"
S3_KEY, S3_SECRET = "e2eaccess", "e2esecret-123"
VERSIONING_PORT, API_PORT = 58890, 58800
WORKER_TOKEN = "e2e-worker-token-0123456789"


def log(msg: str) -> None:
    print(f"[stack] {msg}", flush=True)


def wait(url: str, what: str, timeout: float = 90, ok=lambda r: r.status_code == 200) -> None:
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, timeout=2)
            if ok(r):
                return
            last = f"{r.status_code} {r.text[:200]}"
        except httpx.HTTPError as e:
            last = type(e).__name__
        time.sleep(0.3)
    raise RuntimeError(f"{what} not ready at {url}: {last}")


def retry(fn, what: str, timeout: float = 60):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return fn()
        except (subprocess.CalledProcessError, httpx.HTTPError, RuntimeError) as e:
            if time.monotonic() > deadline:
                raise RuntimeError(f"{what} never became reachable: {getattr(e, 'stderr', None) or e}") from e
            time.sleep(1)


def s3_put_bucket(bucket: str) -> None:
    """PUT a bucket with a hand-rolled SigV4 signature (no AWS SDK needed)."""
    now = dt.datetime.now(dt.UTC)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    host = urlsplit(S3).netloc
    payload = hashlib.sha256(b"").hexdigest()
    canonical = f"PUT\n/{bucket}\n\nhost:{host}\nx-amz-content-sha256:{payload}\nx-amz-date:{amz}\n\nhost;x-amz-content-sha256;x-amz-date\n{payload}"
    scope = f"{day}/us-east-1/s3/aws4_request"
    to_sign = f"AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    k = f"AWS4{S3_SECRET}".encode()
    for part in (day, "us-east-1", "s3", "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    auth = f"AWS4-HMAC-SHA256 Credential={S3_KEY}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={sig}"
    r = httpx.put(f"{S3}/{bucket}", headers={"Authorization": auth, "x-amz-date": amz, "x-amz-content-sha256": payload})
    if r.status_code not in (200, 409) and "BucketAlready" not in r.text:
        raise RuntimeError(f"create bucket {bucket}: {r.status_code} {r.text[:300]}")


class Stack:
    def __init__(self, workdir: Path, keep: bool = False):
        self.dir = workdir
        self.keep = keep
        self.procs: list[tuple[str, subprocess.Popen]] = []
        self.api = f"http://127.0.0.1:{API_PORT}"
        self.versioning = f"http://127.0.0.1:{VERSIONING_PORT}"

    def _spawn(self, name: str, cmd: list[str], env: dict, cwd: Path) -> None:
        out = open(self.dir / f"{name}.log", "w")  # noqa: SIM115
        self.procs.append((name, subprocess.Popen(cmd, env={**os.environ, **env}, cwd=cwd, stdout=out, stderr=subprocess.STDOUT)))

    def up(self) -> "Stack":
        compose = ["docker", "compose", "-f", str(HERE / "compose.yaml")]
        log("docker compose up (postgres, object store)")
        subprocess.run([*compose, "up", "-d", "--wait"], check=True)
        bin_dir = self.dir / "bin"
        log("building apps/versioning")
        subprocess.run(["go", "build", "-o", str(bin_dir) + "/", "./cmd/server", "./cmd/migrate"], cwd=REPO / "apps" / "versioning", check=True)
        mig = {f"{P}VERSIONING_ADMIN_DATABASE_URL": PG, f"{P}VERSIONING_OWNER_PASSWORD": "owner-e2e", f"{P}VERSIONING_APP_PASSWORD": "app-e2e",
               f"{P}VERSIONING_MIGRATE_DATABASE_URL": PG.replace("postgres:postgres@", "versioning_owner:owner-e2e@")}
        # Postgres restarts once after initdb and the object store has no healthcheck, so
        # "healthy" can still refuse connections for a moment: retry.
        retry(lambda: subprocess.run([str(bin_dir / "migrate"), "bootstrap"], env={**os.environ, **mig}, cwd=REPO, check=True, capture_output=True), "postgres")
        subprocess.run([str(bin_dir / "migrate"), "up"], env={**os.environ, **mig}, cwd=REPO, check=True)
        for b in ("objects", "manifests"):
            retry(lambda b=b: s3_put_bucket(f"{NAMING['resourcePrefix']}-{b}"), "object store")

        api_data = self.dir / "api-data"
        api_env = {f"{P}API_DATA_DIR": str(api_data), f"{P}API_DATABASE_URL": f"sqlite:///{api_data / 'api.db'}", f"{P}API_VERSIONING_URL": self.versioning,
                   f"{P}API_WORKER_TOKEN": WORKER_TOKEN, f"{P}API_DEV_TRUST_HEADERS": "1"}
        # The API's dev key pair: the private key stays in its data dir, the service reads the JWKS.
        subprocess.run(["uv", "run", "--project", str(REPO / "apps" / "api"), "python", "-c", "from studio_api.kernel.versioning import auth; auth.signing_key(); print(auth.key_paths()[1])"], env={**os.environ, **api_env}, check=True, capture_output=True)
        jwks = api_data / "versioning-jwks.json"
        assert jwks.is_file(), "the API didn't write its JWKS file"

        vers_env = {f"{P}VERSIONING_HTTP_ADDR": f"127.0.0.1:{VERSIONING_PORT}", f"{P}VERSIONING_DATABASE_URL": PG.replace("postgres:postgres@", "versioning_app:app-e2e@"),
                    f"{P}VERSIONING_OBJECT_ENDPOINT": S3, f"{P}VERSIONING_S3_ACCESS_KEY_ID": S3_KEY, f"{P}VERSIONING_S3_SECRET_ACCESS_KEY": S3_SECRET,
                    f"{P}VERSIONING_JWT_PUBLIC_KEY_FILE": str(jwks), f"{P}VERSIONING_EVENT_BUS": "log"}
        self._spawn("versioning", [str(bin_dir / "server")], vers_env, REPO)
        wait(f"{self.versioning}/readyz", "apps/versioning")
        self._spawn("api", ["uv", "run", "--project", str(REPO / "apps" / "api"), "uvicorn", "studio_api.app:app", "--port", str(API_PORT), "--log-level", "warning"], api_env, REPO / "apps" / "api")
        wait(f"{self.api}/api/v1/versioning/status", "apps/api", ok=lambda r: r.status_code == 200 and r.json().get("ready"))
        self._spawn("worker", ["uv", "run", "--project", str(REPO / "apps" / "worker"), "studio-worker", "--kernel", self.api, "--token", WORKER_TOKEN, "--poll", "0.3", "--data-dir", str(self.dir / "worker-data")], {}, REPO / "apps" / "worker")
        log(f"up: api {self.api}, versioning {self.versioning}, logs in {self.dir}")
        return self

    def down(self) -> None:
        for name, p in reversed(self.procs):
            p.terminate()
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        if not self.keep:
            subprocess.run(["docker", "compose", "-f", str(HERE / "compose.yaml"), "down", "-v"], check=False, capture_output=True)

    def tail(self, name: str, n: int = 40) -> str:
        f = self.dir / f"{name}.log"
        return "\n".join(f.read_text().splitlines()[-n:]) if f.is_file() else ""


def main_for(*flows) -> None:
    """CLI for a flow file: `--api URL` uses a running stack, otherwise one is started."""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--api", help="apps/api URL of a running stack (see run.py --keep)")
    ap.add_argument("--keep", action="store_true", help="leave the containers running")
    a = ap.parse_args()
    if a.api:
        for f in flows:
            f(a.api)
        return
    with running(a.keep) as s:
        for f in flows:
            f(s.api)


@contextmanager
def running(keep: bool = False):
    workdir = Path(tempfile.mkdtemp(prefix="versioning-e2e-"))
    s = Stack(workdir, keep)
    try:
        yield s.up()
    except BaseException:
        for name in ("versioning", "api", "worker"):
            print(f"---- {name}.log ----\n{s.tail(name)}", file=sys.stderr)
        raise
    finally:
        s.down()
        if not keep:
            shutil.rmtree(workdir, ignore_errors=True)
