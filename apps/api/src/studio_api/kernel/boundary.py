"""The data boundary (todo10 §6, Phase 7): build outside, verify inside.

The agent (in `spurby-ai`) never sees a real sample. It asks for work on one, and gets back
only fixed-schema results (`schemas/boundary/*.json`):

| Agent asks                | Worker job            | Agent gets back |
|---------------------------|-----------------------|-----------------|
| `get_fingerprint`         | `fingerprint`         | structure; values dropped (DICOM Annex E), names checked |
| `get_fixtures`            | `synthesize_fixtures` | synthetic files made from the fingerprint alone |
| `verify_on_sample`        | `verify_plugin`       | pass/fail, error class, line in the plugin's source, output shapes and ranges |
| `probe_sample`            | `probe`               | typed answers; text through the free-text check; budgeted and audited |
| `build_plugin_artifact`   | `build_plugin`        | our rebuild of the agent's *source*: digest, signature, registration |

Jobs are ordinary `plugin_jobs` rows under the reserved plugin id `<namespace>.boundary`, so
they go through the same `JobQueue` and leases as plugin jobs, and the worker runs them
in-process (fingerprint, fixtures, probe, build) or in a no-network child process (verify).
The kernel is the enforcer: whatever the worker reports is validated against the contract
and re-checked for free text here before it's stored or returned. A worker report that
doesn't fit fails the job as `OutputInvalid`, with nothing of it kept.

`synthesize_fixtures` gets the stored fingerprint in its input and the worker's sample route
refuses it: fixtures are made from structure only, never from the bytes.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import blobstore
from ..config import settings
from ..context import RequestContext
from ..models import Asset, PluginAudit, PluginJob, WorkspaceEnvironment
from ..naming import ns
from . import assets, audit, jobs, privacy_names, textcheck
from .contracts._generated import (
    boundary_annotations_v1,
    boundary_build_v1,
    boundary_fingerprint_v1,
    boundary_fixtures_v1,
    boundary_job_summary_v1,
    boundary_probe_request_v1,
    boundary_probe_v1,
    boundary_verify_report_v1,
)

PLUGIN = ns("boundary")
VERSION = "1"
TOOLS = ("fingerprint", "synthesize_fixtures", "verify_plugin", "probe", "build_plugin")
TIMEOUT_S = {"fingerprint": 120, "synthesize_fixtures": 120, "verify_plugin": 180, "probe": 60, "build_plugin": 300}
# Jobs that may read the sample's bytes (in the worker, never anywhere else).
READS_SAMPLE = {"fingerprint", "verify_plugin", "probe"}
READS_SOURCE = {"verify_plugin", "build_plugin"}
RESULT_MODELS: dict[str, type[BaseModel]] = {
    "fingerprint": boundary_fingerprint_v1.Fingerprint,
    "synthesize_fixtures": boundary_fixtures_v1.FixtureSet,
    "verify_plugin": boundary_verify_report_v1.VerifyReport,
    "probe": boundary_probe_v1.ProbeResult,
    "build_plugin": boundary_build_v1.BuildResult,
}
SMALL_COUNT = 20
MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_FIXTURE_BYTES = 32 * 1024 * 1024
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
SAMPLE_REF = re.compile(r"^[A-Za-z0-9_./@()+,=-]{1,512}$")


def _error_classes() -> set[str]:
    """The contract's error class enum (from the generated model's JSON schema)."""
    schema = boundary_verify_report_v1.VerifyReport.model_json_schema()
    for d in (schema.get("$defs") or {}).values():
        if "enum" in d and "Other" in d["enum"]:
            return set(d["enum"])
    return {"Other"}


ERROR_CLASSES = _error_classes()


def error_class(error: str | None) -> str:
    """A stored job error as a contract error class; any other text becomes `Other`."""
    e = (error or "").strip()
    return e if e in ERROR_CLASSES else "Other"


def suppress(n: int) -> int | str:
    return n if n == 0 or n >= SMALL_COUNT else f"<{SMALL_COUNT}"


def _validate(model: type[BaseModel], doc: Any) -> dict:
    return model.model_validate(doc).model_dump(mode="json", by_alias=True)


def is_agent(ctx: RequestContext) -> bool:
    return ctx.principal.startswith("agent:")


# ---- Samples, sources and blobs ------------------------------------------------------------


def sample(db: Session, ctx: RequestContext, ref: str) -> Asset:
    """A sample is one asset of the caller's workspace, by id or path. Nothing outside it."""
    if not isinstance(ref, str) or not SAMPLE_REF.match(ref) or ".." in ref.split("/"):
        raise HTTPException(422, "sample must be an asset id or path of this workspace")
    return assets.get_asset(db, ctx, ref)


def _key(ws: str, *parts: str) -> str:
    return "/".join(["boundary", ws, *parts])


def _fingerprint_key(a: Asset) -> str:
    return _key(a.workspace_id, "samples", a.id, f"fingerprint-{a.size or 0}.json")


def stored_fingerprint(a: Asset) -> dict | None:
    try:
        return json.loads(blobstore.data().read(_fingerprint_key(a)))
    except (blobstore.BlobNotFound, ValueError):
        return None


def put_source(db: Session, ctx: RequestContext, data: bytes) -> dict:
    """The agent's plugin source (a tarball packed from its build sandbox): checked to be a safe
    archive, stored content-addressed, never executed here."""
    from ..plugins import artifacts, digest

    if not data or len(data) > MAX_SOURCE_BYTES:
        raise HTTPException(413, f"source tarballs are 1 byte to {MAX_SOURCE_BYTES // 1024 // 1024} MB")
    files = artifacts.unpack(data)
    source_digest = digest.files_digest(files)
    key = _key(ctx.workspace_id, "sources", f"{source_digest.split(':', 1)[1]}.tar")
    store = blobstore.data()
    if store.stat(key) is None:
        store.put(key, data, "application/x-tar")
    return {"sourceDigest": source_digest, "key": key, "files": sorted(files)}


# ---- Starting jobs -------------------------------------------------------------------------


def start(db: Session, ctx: RequestContext, tool: str, input: dict) -> PluginJob:
    if tool not in TOOLS:
        raise HTTPException(422, f"unknown boundary job {tool!r}")
    j, _ = jobs.enqueue(db, ctx, plugin_id=PLUGIN, version=VERSION, tool=tool, input=input, capability=None, provider=None, estimated_cost_usd=0.0, timeout_s=TIMEOUT_S[tool])
    return j


def _sample_input(a: Asset) -> dict:
    return {"sampleId": a.id, "size": a.size, "mediaType": a.media_type}


def request_fingerprint(db: Session, ctx: RequestContext, ref: str) -> dict:
    a = sample(db, ctx, ref)
    fp = stored_fingerprint(a)
    if fp is not None:
        return {"fingerprint": fp, "job": None}
    j = start(db, ctx, "fingerprint", _sample_input(a))
    return {"fingerprint": None, "job": summary(j)}


def request_fixtures(db: Session, ctx: RequestContext, ref: str, count: int = 3) -> dict:
    a = sample(db, ctx, ref)
    fp = stored_fingerprint(a)
    if fp is None:
        raise HTTPException(409, "fingerprint this sample first (get_fingerprint)")
    canonical = json.dumps(fp, sort_keys=True, separators=(",", ":")).encode()
    j = start(db, ctx, "synthesize_fixtures", {"sampleId": a.id, "fingerprint": fp, "fingerprintDigest": f"sha256:{hashlib.sha256(canonical).hexdigest()}", "count": max(1, min(int(count), 8)), "fixtureSetId": uuid.uuid4().hex[:24]})
    return {"job": summary(j)}


def request_verify(db: Session, ctx: RequestContext, ref: str, source: bytes, entrypoint: str) -> dict:
    if not re.fullmatch(r"[A-Za-z_][\w.]{0,120}:[A-Za-z_]\w{0,60}", entrypoint or ""):
        raise HTTPException(422, "entrypoint is module.path:function")
    a = sample(db, ctx, ref)
    src = put_source(db, ctx, source)
    j = start(db, ctx, "verify_plugin", {**_sample_input(a), "sourceKey": src["key"], "sourceDigest": src["sourceDigest"], "sourceFiles": src["files"][:400], "entrypoint": entrypoint})
    return {"job": summary(j)}


def probes_used(db: Session, workspace_id: str, sample_id: str) -> int:
    rows = db.scalars(select(PluginAudit).where(PluginAudit.workspace_id == workspace_id, PluginAudit.action == "boundary.probe", PluginAudit.target == sample_id))
    return sum(int((r.after_ref or {}).get("probes") or 0) for r in rows)


def request_probe(db: Session, ctx: RequestContext, ref: str, probes: list) -> dict:
    try:
        req = _validate(boundary_probe_request_v1.ProbeRequest, {"probes": probes})
    except ValidationError as e:
        raise HTTPException(422, f"probes don't fit the probe language: {len(e.errors())} problem(s)") from None
    a = sample(db, ctx, ref)
    limit = settings().boundary_probe_budget
    used = probes_used(db, ctx.workspace_id, a.id)
    if used + len(req["probes"]) > limit:
        raise HTTPException(429, f"probe budget for this sample is spent ({used}/{limit}); work from the fingerprint and verify reports")
    # Charged when asked, whatever the outcome; the audit row is the budget's ledger.
    audit.record(db, ctx, "boundary.probe", target=a.id, after={"probes": len(req["probes"]), "ops": sorted({p["op"] for p in req["probes"]})})
    j = start(db, ctx, "probe", {**_sample_input(a), "probes": req["probes"], "budget": {"used": used + len(req["probes"]), "limit": limit, "remaining": limit - used - len(req["probes"])}})
    return {"job": summary(j)}


def request_build(db: Session, ctx: RequestContext, source: bytes, sandbox_digest: str | None) -> dict:
    if sandbox_digest is not None and not re.fullmatch(r"sha256:[0-9a-f]{64}", sandbox_digest):
        raise HTTPException(422, "sandboxDigest is sha256:<hex>")
    src = put_source(db, ctx, source)
    j = start(db, ctx, "build_plugin", {"sourceKey": src["key"], "sourceDigest": src["sourceDigest"], "sandboxDigest": sandbox_digest})
    return {"job": summary(j)}


# ---- What the agent sees of a job ----------------------------------------------------------


def summary(j: PluginJob) -> dict:
    kind = j.tool if j.plugin_id == PLUGIN and j.tool in TOOLS else "capability"
    done, failed = int(j.state == "succeeded"), int(j.state == "failed")
    doc = {
        "schema": "boundary.job-summary/v1",
        "jobId": j.job_id,
        "kind": kind,
        "state": j.state if j.state in ("queued", "running", "succeeded", "failed", "cancelled") else "queued",
        "progress": max(0.0, min(1.0, float(j.progress or 0))),
        "counts": {"total": suppress(1), "succeeded": suppress(done), "failed": suppress(failed)},
        "errorClasses": [{"errorClass": error_class(j.error), "count": suppress(1)}] if failed else [],
        "createdAt": _iso(j.created_at),
        "updatedAt": _iso(j.updated_at) if j.updated_at else None,
    }
    return _validate(boundary_job_summary_v1.JobSummary, doc)


def _iso(t: datetime) -> str:
    return (t if t.tzinfo else t.replace(tzinfo=UTC)).isoformat()


def job_view(db: Session, ctx: RequestContext, job_id: str) -> dict:
    """A job's summary, and its typed result once it succeeded (boundary jobs only)."""
    j = jobs.get(db, ctx, job_id)
    out: dict = {"job": summary(j), "result": None}
    if j.plugin_id == PLUGIN and j.state == "succeeded" and j.result:
        out["result"] = _validate(RESULT_MODELS[j.tool], j.result)
    elif j.plugin_id != PLUGIN and j.state == "succeeded" and j.result:
        # Capability jobs: annotation ids only (opaque), never outputs.
        ids = [str(x) for x in (j.result.get("annotationIds") or []) if isinstance(x, str)][:1000]
        out["result"] = {"annotationIds": ids}
    return out


# ---- The worker's side ---------------------------------------------------------------------


def worker_job(db: Session, job_id: str, worker_id: str) -> PluginJob:
    j = jobs._owned(db, job_id, worker_id)
    if j.plugin_id != PLUGIN:
        raise HTTPException(404, "not a boundary job")
    return j


def job_sample(db: Session, j: PluginJob) -> Asset:
    if j.tool not in READS_SAMPLE:
        raise HTTPException(403, f"a {j.tool} job doesn't read the sample")
    a = db.get(Asset, j.input.get("sampleId"))
    if a is None or a.workspace_id != j.workspace_id:
        raise HTTPException(404, "the job's sample is gone")
    return a


def job_source(j: PluginJob) -> bytes:
    if j.tool not in READS_SOURCE:
        raise HTTPException(403, f"a {j.tool} job has no source")
    try:
        return blobstore.data().read(str(j.input["sourceKey"]))
    except (blobstore.BlobNotFound, KeyError):
        raise HTTPException(404, "the job's source is gone") from None


def _fixture_key(j: PluginJob, name: str) -> str:
    return _key(j.workspace_id, "fixtures", str(j.input["fixtureSetId"]), name)


def put_fixture(j: PluginJob, name: str, data: bytes, media_type: str) -> dict:
    if j.tool != "synthesize_fixtures":
        raise HTTPException(403, "only fixture jobs write fixtures")
    if not re.fullmatch(r"fixture-\d{2}[a-z0-9-]{0,24}\.[a-z0-9.]{1,12}", name):
        raise HTTPException(422, "bad fixture name")
    if not data or len(data) > MAX_FIXTURE_BYTES:
        raise HTTPException(413, "fixtures are 1 byte to 32 MB")
    blobstore.data().put(_fixture_key(j, name), data, media_type or "application/octet-stream")
    return {"sha256": f"sha256:{hashlib.sha256(data).hexdigest()}", "bytes": len(data)}


def fixture_bytes(db: Session, ctx: RequestContext, fixture_set_id: str, name: str) -> bytes:
    """A synthetic fixture, for the agent to copy into its build sandbox."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", fixture_set_id) or not re.fullmatch(r"fixture-\d{2}[a-z0-9-]{0,24}\.[a-z0-9.]{1,12}", name):
        raise HTTPException(404, "no such fixture")
    # The fixture set must belong to a succeeded fixtures job of this workspace and list the file.
    for j in db.scalars(select(PluginJob).where(PluginJob.workspace_id == ctx.workspace_id, PluginJob.plugin_id == PLUGIN, PluginJob.tool == "synthesize_fixtures", PluginJob.state == "succeeded")):
        if (j.result or {}).get("fixtureSetId") == fixture_set_id and any(f.get("name") == name for f in (j.result or {}).get("fixtures") or []):
            try:
                return blobstore.data().read(_fixture_key(j, name))
            except blobstore.BlobNotFound:
                break
    raise HTTPException(404, "no such fixture")


def put_bundle(j: PluginJob, data: bytes) -> dict:
    if j.tool != "build_plugin":
        raise HTTPException(403, "only build jobs write bundles")
    if not data or len(data) > MAX_BUNDLE_BYTES:
        raise HTTPException(413, "bundle too large")
    key = _key(j.workspace_id, "builds", j.job_id, "bundle.tar")
    blobstore.data().put(key, data, "application/x-tar")
    return {"key": key}


def build_signer():
    from studio_signing import make_signer

    s = settings()
    key_file = s.build_signing_key_file or (s.repo_root / ".data" / "dev-build-signing.key")
    return make_signer(s.build_signer, key_file=Path(key_file), kms_key=s.build_kms_key)


def _ctx_of(j: PluginJob) -> RequestContext:
    return RequestContext(j.workspace_id, j.principal, j.correlation_id or uuid.uuid4().hex, task_id=j.task_id)


def _names(items: list[dict], key: str = "name") -> int:
    n = 0
    for it in items:
        v, red = textcheck.name_or_placeholder(str(it.get(key, "")))
        it[key] = v
        n += red
    return n


def _clean_fingerprint(j: PluginJob, r: dict) -> dict:
    if r.get("sampleId") != j.input.get("sampleId"):
        raise ValueError("fingerprint for another sample")
    redacted = _names(r.get("fields") or []) + _names(r.get("arrays") or []) + _names(r.get("sections") or [])
    if r.get("table"):
        redacted += _names(r["table"].get("columns") or [])
    r.setdefault("scrub", {})
    r["scrub"]["namesRedacted"] = int(r["scrub"].get("namesRedacted") or 0) + redacted
    r["scrub"]["textCheck"] = textcheck.checker()
    return r


def _clean_probe(j: PluginJob, r: dict) -> dict:
    if r.get("sampleId") != j.input.get("sampleId"):
        raise ValueError("probe answers for another sample")
    for a in r.get("answers") or []:
        if a.get("op") == "read_text" and isinstance(a.get("value"), str):
            a["value"] = textcheck.text_or_placeholder(a["value"])
        if a.get("names"):
            a["names"] = [textcheck.name_or_placeholder(str(x))[0] for x in a["names"]]
        if a.get("sections"):
            _names(a["sections"])
    r["budget"] = j.input.get("budget") or r.get("budget")
    return r


def _clean_verify(j: PluginJob, r: dict) -> dict:
    if r.get("sampleId") != j.input.get("sampleId") or r.get("sourceDigest") != j.input.get("sourceDigest"):
        raise ValueError("verify report for another sample or source")
    if r.get("errorFile") is not None and r["errorFile"] not in set(j.input.get("sourceFiles") or []):
        r["errorFile"], r["errorLine"] = None, None  # only lines of the agent's own files
    if r.get("errorClass") is not None:
        r["errorClass"] = error_class(r["errorClass"])
    _names(r.get("outputs") or [])
    return r


def _clean_fixtures(j: PluginJob, r: dict) -> dict:
    if r.get("fixtureSetId") != j.input.get("fixtureSetId") or r.get("fingerprintDigest") != j.input.get("fingerprintDigest"):
        raise ValueError("fixtures for another request")
    for f in r.get("fixtures") or []:
        try:
            data = blobstore.data().read(_fixture_key(j, str(f.get("name"))))
        except blobstore.BlobNotFound:
            raise ValueError("a listed fixture wasn't uploaded") from None
        f["sha256"], f["bytes"] = f"sha256:{hashlib.sha256(data).hexdigest()}", len(data)
    return r


def _finish_build(db: Session, j: PluginJob, r: dict) -> dict:
    """Check our worker's build (digest of the stored bundle, signature), then register it."""
    from studio_signing import check_envelope

    from ..plugins import artifacts, digest

    r["sourceDigest"] = j.input.get("sourceDigest")
    r["sandboxDigest"] = j.input.get("sandboxDigest")
    r.setdefault("registered", False)
    r.setdefault("duplicate", False)
    if not r.get("pass"):
        r["artifactDigest"], r["signature"], r["matchesSandbox"] = r.get("artifactDigest"), None, None
        return r
    try:
        bundle = blobstore.data().read(_key(j.workspace_id, "builds", j.job_id, "bundle.tar"))
    except blobstore.BlobNotFound:
        raise ValueError("the build job uploaded no bundle") from None
    ours = digest.files_digest(artifacts.unpack(bundle))
    if ours != r.get("artifactDigest"):
        raise ValueError("bundle digest doesn't match the reported digest")
    problem = check_envelope(build_signer(), ours, r.get("signature"))
    if problem:
        raise ValueError(f"build signature: {problem}")
    r["matchesSandbox"] = (r["sandboxDigest"] == ours) if r["sandboxDigest"] else None
    ctx = _ctx_of(j)
    try:
        out = artifacts.build(bundle, ctx)
    except HTTPException as e:  # e.g. 409: that version exists with other contents
        r["pass"], r["errors"] = False, [str(e.detail)[:500]]
        return r
    if out.get("artifactDigest") != ours:
        raise ValueError("the registry computed a different digest")
    r["registered"], r["duplicate"] = bool(out.get("registered")), bool(out.get("duplicate"))
    r["pluginId"], r["version"] = out.get("pluginId"), out.get("version")
    r["errors"] = [str(e)[:500] for e in (out.get("errors") or [])][:50]
    if not out.get("ok"):
        r["pass"], r["registered"] = False, False
    # The attestation travels with the bundle: which job, source and sandbox claim produced it.
    attestation = {"job": j.job_id, "principal": j.principal, "sourceDigest": r["sourceDigest"], "sandboxDigest": r["sandboxDigest"], "artifactDigest": ours, "signature": r["signature"], "toolchain": r.get("toolchain"), "at": datetime.now(UTC).isoformat()}
    blobstore.data().put(_key(j.workspace_id, "builds", ours.split(":", 1)[1] + ".attestation.json"), json.dumps(attestation, sort_keys=True).encode(), "application/json")
    audit.record(db, ctx, "boundary.build", target=f"{r['pluginId']}@{r['version']}", after={"artifactDigest": ours, "sourceDigest": r["sourceDigest"], "matchesSandbox": r["matchesSandbox"], "registered": r["registered"], "keyId": (r.get("signature") or {}).get("keyId")})
    return r


CLEAN = {"fingerprint": _clean_fingerprint, "probe": _clean_probe, "verify_plugin": _clean_verify, "synthesize_fixtures": _clean_fixtures}


def complete(db: Session, j: PluginJob, result: Any) -> PluginJob:
    """The worker's report → checked, cleaned, validated, stored. Anything off fails the job
    as `OutputInvalid` and nothing of the report is kept."""
    try:
        if not isinstance(result, dict):
            raise ValueError("result must be an object")
        r = json.loads(json.dumps(result))
        r = _finish_build(db, j, r) if j.tool == "build_plugin" else CLEAN[j.tool](j, r)
        doc = _validate(RESULT_MODELS[j.tool], r)
    except (ValueError, ValidationError, KeyError, TypeError, HTTPException):
        j.state, j.error, j.recoverable, j.result = "failed", "OutputInvalid", False, None
        audit.record(db, _ctx_of(j), "boundary.rejected", target=j.job_id, after={"tool": j.tool})
        return j
    if j.tool == "fingerprint":
        a = db.get(Asset, j.input["sampleId"])
        if a is not None:
            blobstore.data().put(_fingerprint_key(a), json.dumps(doc, sort_keys=True).encode(), "application/json")
    j.state, j.result, j.progress, j.error = "succeeded", doc, 1.0, None
    return j


def fail(db: Session, j: PluginJob, error_cls: str, recoverable: bool) -> PluginJob:
    """Boundary jobs fail with an error class only; free text never reaches the row."""
    j.state, j.error, j.recoverable = "failed", error_class(error_cls), recoverable
    return j


# ---- Filtered annotations (§6.3) -----------------------------------------------------------


def _vocabulary(db: Session, ctx: RequestContext) -> set[str]:
    """Labels the task's environment declares (any `labels` / `classes` / `vocabulary` list)."""
    row = db.get(WorkspaceEnvironment, (ctx.workspace_id, ctx.task))
    out: set[str] = set()

    def walk(v: Any, key: str = "") -> None:
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)
        elif isinstance(v, list):
            for x in v:
                if key in ("labels", "classes", "vocabulary", "values") and isinstance(x, str):
                    out.add(x)
                elif key in ("labels", "classes", "vocabulary") and isinstance(x, dict):
                    for kk in ("id", "name", "label"):
                        if isinstance(x.get(kk), str):
                            out.add(x[kk])
                walk(x, key)

    walk(row.environment if row is not None else None)
    return out


def _geometry(v: Any, depth: int = 0) -> Any:
    if depth > 6:
        return None
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, int | float):
        return v if v == v and abs(v) != float("inf") else None
    if isinstance(v, list):
        return [_geometry(x, depth + 1) for x in v[:100_000]]
    if isinstance(v, dict):
        return {k: _geometry(x, depth + 1) for k, x in v.items() if isinstance(k, str) and textcheck.FIELD_NAME.match(k) and not isinstance(x, str)}
    return None


def filtered_annotations(db: Session, ctx: RequestContext, item_id: str | None, label: str | None, limit: int) -> dict:
    from . import annotations

    vocab = _vocabulary(db, ctx)
    rows = annotations.list_annotations(db, ctx, item_id, label, 100_000)
    out, redacted = [], 0
    for a in rows[: max(1, min(limit, 1000))]:
        item = str(a.get("itemId") or "")
        if privacy_names.path_findings(item) or not re.fullmatch(r"[A-Za-z0-9_./@()+=-]{1,256}", item):
            item, redacted = textcheck.placeholder(item), redacted + 1
        lab = a.get("label")
        if isinstance(lab, str) and lab not in vocab and not textcheck.text_ok(lab):
            lab, redacted = textcheck.placeholder(lab), redacted + 1
        attrs: dict = {}
        for k, v in (a.get("attributes") or {}).items():
            if not isinstance(k, str) or not textcheck.FIELD_NAME.match(k):
                continue
            if isinstance(v, bool) or v is None or (isinstance(v, int | float) and v == v and abs(v) != float("inf")):
                attrs[k] = v
            elif isinstance(v, str):
                ok = v in vocab or textcheck.text_ok(v, vocab)
                attrs[k] = v if ok and re.fullmatch(r"[A-Za-z0-9 _.:/()-]{1,64}", v) else textcheck.placeholder(v)
                redacted += not ok
        g = a.get("geometry")
        geom = None
        if isinstance(g, dict) and isinstance(g.get("type"), str) and textcheck.FIELD_NAME.match(g["type"]):
            geom = {"type": g["type"], **{k: v for k, v in (_geometry({k: x for k, x in g.items() if k != "type"}) or {}).items()}}
        aid = str(a.get("id") or "")
        out.append({
            "id": aid if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", aid) else uuid.uuid5(uuid.NAMESPACE_URL, aid).hex,
            "itemId": item,
            "label": lab if isinstance(lab, str) and lab else None,
            "geometry": geom,
            "provenance": a.get("provenance") if isinstance(a.get("provenance"), str) and re.fullmatch(r"[a-z-]{1,32}", a["provenance"]) else None,
            "review": (a.get("attributes") or {}).get("review_status") if re.fullmatch(r"[a-z_-]{1,32}", str((a.get("attributes") or {}).get("review_status") or "")) else None,
            "attributes": attrs,
        })
    return _validate(boundary_annotations_v1.FilteredAnnotations, {"schema": "boundary.annotations/v1", "total": suppress(len(rows)), "annotations": out, "redacted": redacted})


def export_annotations(db: Session, ctx: RequestContext) -> dict:
    """Snapshot the annotation document as an artifact, server-side: the bytes never pass
    through the agent (the old `export_dataset` read the whole document in the agent)."""
    from . import annotations

    doc = annotations.get_document(db, ctx)
    data = json.dumps(doc).encode()
    art = assets.create_artifact(db, ctx, data, "application/json", "agent.export_dataset")
    audit.record(db, ctx, "boundary.export", target=art.id, after={"bytes": len(data)})
    return {"artifactId": art.id, "bytes": len(data), "annotations": suppress(len(doc.get("annotations") or []))}
