"""Data-boundary jobs (todo10 §6.1, Phase 7): the worker's half of "build outside, verify inside".

    fingerprint          sample → structure, values dropped (fingerprint.py)
    synthesize_fixtures  fingerprint → synthetic files (fixtures.py); never sees the sample
    verify_plugin        agent source + sample → fixed-schema report (verify_harness.py, a
                         child process with no network, no subprocesses, no writes)
    probe                sample + typed probes → typed answers (probe.py)
    build_plugin         agent source → canonical bundle, digest, signature (build.py)

The kernel hands these out on the normal claim (`builtin: "boundary"`), serves the sample and
source per job, and validates every report against `schemas/boundary/*.json`. Failures go back
as an error class only; exception text never leaves this process (and isn't logged either:
the log line names the class).
"""

from __future__ import annotations

import json
import logging
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx

from . import build, fingerprint, fixtures, probe

log = logging.getLogger("studio_worker.boundary")
HARNESS = Path(__file__).with_name("verify_harness.py")
RUNNER = "verify-v1"
MAX_SAMPLE_BYTES = 512 * 1024 * 1024


class JobFailed(Exception):
    def __init__(self, error_class: str, recoverable: bool = False):
        super().__init__(error_class)
        self.error_class, self.recoverable = error_class, recoverable


def _python_version() -> str:
    v = sys.version_info
    return f"{v.major}.{v.minor}.{v.micro}"


class BoundaryRunner:
    def __init__(self, http: httpx.Client, worker_id: str, scratch: Path, *, signer=None, verify_python: str | None = None, verify_memory_mb: int = 2048):
        self.http = http
        self.worker_id = worker_id
        self.scratch = scratch
        self.signer = signer
        self.verify_python = verify_python or sys.executable
        self.verify_memory_mb = verify_memory_mb

    # ---- kernel I/O ----------------------------------------------------------------------

    def _get(self, job_id: str, what: str) -> bytes:
        r = self.http.get(f"/api/v1/worker/boundary/jobs/{job_id}/{what}", params={"workerId": self.worker_id}, timeout=300)
        if r.status_code >= 400:
            raise JobFailed("Other", recoverable=r.status_code >= 500)
        if len(r.content) > MAX_SAMPLE_BYTES:
            raise JobFailed("MemoryLimit")
        return r.content

    def _put(self, job_id: str, path: str, data: bytes, media_type: str) -> dict:
        r = self.http.put(f"/api/v1/worker/boundary/jobs/{job_id}/{path}", params={"workerId": self.worker_id}, content=data, headers={"Content-Type": media_type}, timeout=120)
        if r.status_code >= 400:
            raise JobFailed("Other", recoverable=r.status_code >= 500)
        return r.json()

    def _complete(self, job_id: str, result: dict) -> str:
        r = self.http.post(f"/api/v1/worker/boundary/jobs/{job_id}/complete", json={"workerId": self.worker_id, "result": result})
        return str(r.json().get("state")) if r.is_success else f"refused {r.status_code}"

    def _fail(self, job_id: str, error_class: str, recoverable: bool) -> None:
        self.http.post(f"/api/v1/worker/boundary/jobs/{job_id}/fail", json={"workerId": self.worker_id, "errorClass": error_class, "recoverable": recoverable})

    # ---- dispatch ------------------------------------------------------------------------

    def run(self, claim: dict) -> str:
        job = claim["job"]
        job_id, tool, inp = job["jobId"], job["tool"], job.get("input") or {}
        handler = {"fingerprint": self.fingerprint, "synthesize_fixtures": self.fixtures, "verify_plugin": self.verify, "probe": self.probe, "build_plugin": self.build}.get(tool)
        try:
            if handler is None:
                raise JobFailed("Other")
            state = self._complete(job_id, handler(job_id, inp, int(job.get("timeoutSeconds") or 120)))
        except JobFailed as e:
            self._fail(job_id, e.error_class, e.recoverable)
            state = f"failed {e.error_class}"
        except httpx.HTTPError:
            raise
        except Exception as e:  # noqa: BLE001 — the class only; the message may quote the sample
            self._fail(job_id, "Crash", True)
            state = f"failed Crash ({type(e).__name__})"
        log.info("boundary job done", extra={"job_id": job_id, "tool": tool, "state": state})
        return state

    # ---- jobs ----------------------------------------------------------------------------

    def fingerprint(self, job_id: str, inp: dict, _timeout: int) -> dict:
        return fingerprint.fingerprint(inp["sampleId"], self._get(job_id, "sample"))

    def fixtures(self, job_id: str, inp: dict, _timeout: int) -> dict:
        fp, set_id = inp["fingerprint"], inp["fixtureSetId"]
        seed = fixtures.seed_for(set_id)
        listed = []
        if (fp.get("table") or {}).get("profile") is not None:
            return self._table_fixtures(job_id, inp, seed)
        for f in fixtures.synthesize(fp, int(inp.get("count") or 3), seed):
            meta = self._put(job_id, f"fixtures/{f['name']}", f["data"], f["mediaType"])
            listed.append({"name": f["name"], "bytes": meta["bytes"], "sha256": meta["sha256"], "mediaType": f["mediaType"], "variant": f["variant"]})
        return {"schema": "boundary.fixtures/v1", "fixtureSetId": set_id, "sampleId": inp["sampleId"], "fingerprintDigest": inp["fingerprintDigest"], "generator": fixtures.GENERATOR, "seed": seed, "fixtures": listed}

    def _table_fixtures(self, job_id: str, inp: dict, seed: int) -> dict:
        """todo23 W4: profile → fixtures with planted truth. The truth goes to the kernel's
        verifier store; the response names it by id and digest only."""
        set_id = inp["fixtureSetId"]
        gen, made, truth = fixtures.synthesize_table(inp["fingerprint"], int(inp.get("count") or 3), seed, inp.get("generator"))
        listed = []
        for f in made:
            meta = self._put(job_id, f"fixtures/{f['name']}", f["data"], f["mediaType"])
            listed.append({"name": f["name"], "bytes": meta["bytes"], "sha256": meta["sha256"], "mediaType": f["mediaType"], "variant": f["variant"]})
        meta = self._put(job_id, "truth", json.dumps(truth, sort_keys=True).encode(), "application/json")
        plants = sum(len(p) for p in truth["fixtures"].values())
        return {"schema": "boundary.fixtures/v1", "fixtureSetId": set_id, "sampleId": inp["sampleId"], "fingerprintDigest": inp["fingerprintDigest"], "generator": gen, "seed": seed, "fixtures": listed,
                "truth": {"truthId": f"{set_id}-truth", "sha256": meta["sha256"], "plants": plants}}

    def probe(self, job_id: str, inp: dict, _timeout: int) -> dict:
        data = self._get(job_id, "sample")
        fp = fingerprint.fingerprint(inp["sampleId"], data)
        return {"schema": "boundary.probe/v1", "sampleId": inp["sampleId"], "sampleDigest": fp["sampleDigest"], "answers": probe.run(inp["sampleId"], data, inp.get("probes") or []), "budget": inp.get("budget") or {"used": 0, "limit": 0, "remaining": 0}}

    def verify(self, job_id: str, inp: dict, timeout: int) -> dict:
        import hashlib

        sample = self._get(job_id, "sample")
        source = build.unpack(self._get(job_id, "source"))
        self.scratch.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="verify-", dir=self.scratch))
        try:
            src = work / "source"
            for rel, data in source.items():
                (src / rel).parent.mkdir(parents=True, exist_ok=True)
                (src / rel).write_bytes(data)
            sample_path = work / "input" / "sample"
            sample_path.parent.mkdir()
            sample_path.write_bytes(sample)
            # Read-only input: the file, its directory and the source tree.
            sample_path.chmod(0o444)
            sample_path.parent.chmod(0o555)
            for p in sorted(src.rglob("*"), reverse=True):
                p.chmod(0o555 if p.is_dir() else 0o444)
            out = work / "report.json"
            budget = max(5, min(timeout - 10, 170))
            report, timed_out = self._run_harness(work, {"source": str(src), "sample": str(sample_path), "entrypoint": inp["entrypoint"], "out": str(out)}, budget)
        finally:
            for p in [work, *work.rglob("*")]:
                try:
                    p.chmod(0o700)
                except OSError:
                    pass
            shutil.rmtree(work, ignore_errors=True)
        base = {
            "schema": "boundary.verify-report/v1",
            "sampleId": inp["sampleId"],
            "sampleDigest": f"sha256:{hashlib.sha256(sample).hexdigest()}",
            "sourceDigest": inp["sourceDigest"],
            "timedOut": timed_out,
            "toolchain": {"python": _python_version(), "runner": RUNNER},
        }
        if report is None:
            return {**base, "pass": False, "stage": "convert", "errorClass": "Timeout" if timed_out else "Crash", "errorFile": None, "errorLine": None, "outputs": [], "durationMs": int(budget * 1000) if timed_out else 0}
        keep = ("pass", "stage", "errorClass", "errorFile", "errorLine", "outputs", "durationMs")
        return {**base, **{k: report.get(k) for k in keep}}

    def _run_harness(self, work: Path, args: dict, budget: int) -> tuple[dict | None, bool]:
        mem = self.verify_memory_mb * 1024 * 1024

        def limits() -> None:
            os.setsid()
            resource.setrlimit(resource.RLIMIT_CPU, (budget + 2, budget + 5))
            if sys.platform != "darwin":  # macOS counts the user's processes, not the child's
                resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
            for lim in ("RLIMIT_AS", "RLIMIT_DATA"):
                try:
                    resource.setrlimit(getattr(resource, lim), (mem, mem))
                except (ValueError, OSError, AttributeError):
                    pass

        # No proxy, no credentials, no HOME with config: an empty environment.
        env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1", "no_proxy": "*", "NO_PROXY": "*"}
        proc = subprocess.Popen([self.verify_python, "-I", str(HARNESS)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env, cwd=str(work), preexec_fn=limits)
        try:
            proc.communicate(json.dumps(args).encode(), timeout=budget)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            return None, True
        try:
            return json.loads(Path(args["out"]).read_text()), False
        except (OSError, ValueError):
            return None, False

    def build(self, job_id: str, inp: dict, _timeout: int) -> dict:
        from studio_signing import envelope

        kept, dropped, errors = build.rebuild(self._get(job_id, "source"))
        base = {"schema": "boundary.build/v1", "pluginId": None, "version": None, "sourceDigest": inp["sourceDigest"], "sandboxDigest": inp.get("sandboxDigest"), "matchesSandbox": None, "dropped": dropped, "registered": False, "duplicate": False, "toolchain": build.toolchain()}
        if errors or self.signer is None:
            return {**base, "pass": False, "artifactDigest": None, "signature": None, "errors": (errors or ["the worker has no signing key configured"])[:50]}
        digest = build.files_digest(kept)
        self._put(job_id, "bundle", build.canonical_tar(kept), "application/x-tar")
        return {**base, "pass": True, "artifactDigest": digest, "signature": envelope(self.signer, digest), "errors": []}

