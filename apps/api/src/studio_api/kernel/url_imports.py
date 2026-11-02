"""Add data without the assistant seeing it (todo16 D10): import from a link, copy from a
sample or another project.

    POST /api/v1/projects/{id}/imports/url    {url, attested: true, folderId?}        -> 202 {importId, state: "fetching"}
    POST /api/v1/projects/{id}/imports/copy   {fromProjectId | sampleId, attested: true, nodeIds?, folderId?} -> {importId, ...}

`attested: true` is the person's rights confirmation ("Do you have the rights to add this
data?"); without it both answer 422. A link import is a background job (todo16 round 2): the
route checks the link, makes an import session in state `fetching` and enqueues
`imports.fetch_url` on the JobQueue (reserved plugin `<ns>.imports`, tool `fetch_url`). The
worker claims it and asks the kernel to run it (`POST /worker/imports/jobs/{id}/run`); the
fetch lands in that same session, so `GET /imports/{id}` shows its progress.

Both land through the normal import path (`imports.create_session` + `complete`): the bytes
go to the content-addressed `sources/<project>/<sha256><ext>` key in the data BlobStore, the
session's files are marked uploaded, `complete` makes assets and nodes and emits
`source.uploaded`, and the worker inspects them as for any drop. Callers (the assistant's
tools) get the session dict back: names, sizes and counts, never bytes.

Links: `https://` (no credentials in the URL, no private, loopback, link-local or reserved
address, redirects re-checked hop by hop) and `gs://bucket/object` read with the service's own
identity. DNS rebinding: each hop's host is resolved once, every address checked, and the
connection goes to that checked address (Host header and TLS SNI = the host name, so the
certificate is still verified for it). The size cap is `INKLING_API_URL_IMPORT_MAX_BYTES` (5 GB); the fetch stops as soon
as it passes it. The fetcher is a module-level hook so tests replace it.
"""

from __future__ import annotations

import hashlib
import ipaddress
import os
import posixpath
import socket
import tempfile
import time
from collections.abc import Callable, Iterator
from contextvars import ContextVar
from dataclasses import dataclass
from urllib.parse import unquote, urljoin, urlsplit

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import blobstore
from ..config import settings
from ..context import RequestContext
from ..models import Asset, ImportSession, PluginJob, ProjectRow, SourceNode, UploadFile, now
from ..naming import ns
from . import assets, imports, jobs, projects, samples, tree

PLUGIN = ns("imports")  # reserved: kernel jobs of the import path, run by the worker's built-in
VERSION = "1"
TOOL = "fetch_url"
JOB_TIMEOUT_S = 3600

MAX_REDIRECTS = 5
TIMEOUT_S = 60.0


class TooLarge(Exception):
    pass


@dataclass
class Fetched:
    name: str
    path: str  # a temp file under /tmp; the caller deletes it
    size: int
    sha256: str


# ---- Link checks --------------------------------------------------------------------------------


def _public_ip(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    return a.is_global and not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified)


def resolve(host: str) -> list[str]:
    """The host's addresses (a hook: tests replace it)."""
    return sorted({ai[4][0] for ai in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)})


def check_url(url: object) -> tuple[str, str]:
    """`(scheme, url)` for an allowed link, else 422 with a sentence a person can act on."""
    scheme, url, _ = pin(url)
    return scheme, url


def pin(url: object) -> tuple[str, str, str | None]:
    """`(scheme, url, ip)`: the link checked, with the one checked address to connect to (an
    https link; None for gs://). The host is resolved once here: connecting to `ip` means a
    second lookup can't swap in a private address (DNS rebinding)."""
    if not isinstance(url, str) or not url.strip() or len(url) > 4096:
        raise HTTPException(422, "url must be a link")
    url = url.strip()
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme == "gs":
        if not parts.netloc or not parts.path.strip("/"):
            raise HTTPException(422, "A gs:// link needs a bucket and an object: gs://bucket/path/file")
        return "gs", url, None
    if scheme != "https":
        raise HTTPException(422, "Only https:// and gs:// links can be imported")
    if parts.username or parts.password:
        raise HTTPException(422, "Links with a user name or password can't be imported")
    host = (parts.hostname or "").rstrip(".")
    if not host or host.lower() == "localhost" or host.lower().endswith((".localhost", ".internal", ".local")):
        raise HTTPException(422, "That link points at a private address")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        addrs = [str(literal)]
    else:
        try:
            addrs = resolve(host)
        except OSError:
            raise HTTPException(422, f"Couldn't find {host}") from None
    if not addrs or not all(_public_ip(a) for a in addrs):
        raise HTTPException(422, "That link points at a private address")
    return "https", url, addrs[0]


def _name_of(url: str, header: str | None = None) -> str:
    if header and "filename=" in header:
        n = header.split("filename=", 1)[1].split(";", 1)[0].strip().strip('"')
        if n:
            return posixpath.basename(n.replace("\\", "/"))[:255] or "download"
    return posixpath.basename(unquote(urlsplit(url).path).rstrip("/"))[:255] or "download"


# ---- Fetchers ----------------------------------------------------------------------------------


# todo18: bytes fetched so far (and the declared total) for the import being fetched; set by
# `run_fetch` around the fetch, called by the fetchers. A ContextVar, so concurrent jobs don't mix.
PROGRESS: ContextVar[Callable[[int, int | None], None] | None] = ContextVar("url_import_progress", default=None)


def _report(n: int, total: int | None) -> None:
    cb = PROGRESS.get()
    if cb is not None:
        try:
            cb(n, total)
        except Exception:  # noqa: BLE001 - progress is best effort, never fails the fetch
            pass


def _spool(chunks: Iterator[bytes], max_bytes: int, total: int | None = None) -> tuple[str, int, str]:
    h = hashlib.sha256()
    n = 0
    tmp = tempfile.NamedTemporaryFile(delete=False, prefix="urlimp-")
    try:
        with tmp:
            for chunk in chunks:
                n += len(chunk)
                if n > max_bytes:
                    raise TooLarge()
                h.update(chunk)
                tmp.write(chunk)
                _report(n, total)
    except BaseException:
        os.unlink(tmp.name)
        raise
    return tmp.name, n, h.hexdigest()


def _client():
    """The HTTP client (a hook: tests give it a mock transport)."""
    import httpx

    return httpx.Client(follow_redirects=False, timeout=TIMEOUT_S)


def pinned_request(url: str, ip: str) -> tuple[str, dict, dict]:
    """`(url to connect to, headers, httpx extensions)`: the request goes to `ip`, while the
    Host header and the TLS server name (SNI, and so certificate checks) stay the host name."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    literal = f"[{ip}]" if ":" in ip else ip
    netloc = literal + (f":{parts.port}" if parts.port else "")
    target = parts._replace(netloc=netloc).geturl()
    return target, {"Host": host + (f":{parts.port}" if parts.port else "")}, {"sni_hostname": host}


def _fetch_https(url: str, max_bytes: int) -> Fetched:
    _, url, ip = pin(url)
    with _client() as client:
        for _ in range(MAX_REDIRECTS + 1):
            assert ip is not None
            target, headers, ext = pinned_request(url, ip)
            with client.stream("GET", target, headers=headers, extensions=ext) as r:
                if r.is_redirect:
                    nxt = urljoin(url, r.headers.get("location", ""))
                    if urlsplit(nxt).scheme.lower() != "https":
                        raise HTTPException(422, "That link redirects somewhere that can't be imported")
                    _, url, ip = pin(nxt)  # every hop re-resolved, re-checked and pinned
                    continue
                if r.status_code >= 400:
                    raise HTTPException(422, f"The link answered {r.status_code}")
                declared = r.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise TooLarge()
                path, size, sha = _spool(r.iter_bytes(1024 * 1024), max_bytes, int(declared) if declared and declared.isdigit() else None)
                return Fetched(_name_of(url, r.headers.get("content-disposition")), path, size, sha)
    raise HTTPException(422, "That link redirects too many times")


def _fetch_gs(url: str, max_bytes: int) -> Fetched:
    from google.cloud import storage  # the service's own identity (workload identity in GKE)

    parts = urlsplit(url)
    blob = storage.Client(project=settings().gcs_project or None).bucket(parts.netloc).get_blob(parts.path.lstrip("/"))
    if blob is None:
        raise HTTPException(422, "That gs:// object doesn't exist or this project can't read it")
    if (blob.size or 0) > max_bytes:
        raise TooLarge()
    tmp = tempfile.NamedTemporaryFile(delete=False, prefix="urlimp-")
    tmp.close()
    try:
        blob.download_to_filename(tmp.name)
        h = hashlib.sha256()
        with open(tmp.name, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(chunk)
        size = os.path.getsize(tmp.name)
        if size > max_bytes:
            raise TooLarge()
    except BaseException:
        os.unlink(tmp.name)
        raise
    return Fetched(posixpath.basename(blob.name) or "download", tmp.name, size, h.hexdigest())


def fetch(scheme: str, url: str, max_bytes: int) -> Fetched:
    return _fetch_gs(url, max_bytes) if scheme == "gs" else _fetch_https(url, max_bytes)


FETCH: Callable[[str, str, int], Fetched] = fetch  # tests replace this


# ---- Landing -----------------------------------------------------------------------------------


@dataclass
class Landed:
    rel: str
    size: int
    sha256: str


def _land(db: Session, ctx: RequestContext, p: ProjectRow, files: list[Landed], *, folder_id: object, title: str, origin: dict, session_id: str | None = None) -> dict:
    """The normal import path for bytes already at their `sources/` keys."""
    body = {
        "files": [{"clientFileId": f"f{i}", "relPath": f.rel, "size": f.size, "sha256": f.sha256} for i, f in enumerate(files)],
        "attested": True,
        "title": title,
        **({"targetNodeId": str(folder_id)} if folder_id else {}),
    }
    s = imports.create_session(db, ctx, p, body, internal=True, session_id=session_id)
    sid = s["id"]
    for f in db.scalars(select(UploadFile).where(UploadFile.session_id == sid, UploadFile.state == "pending")):
        f.state, f.received = "uploaded", f.size
    db.flush()
    sess = db.get(ImportSession, sid)
    assert sess is not None
    sess.totals = {**(sess.totals or {}), "origin": origin}
    out = imports.complete(db, ctx, sess, p)
    return {"importId": sid, **_facts(out)}


def _facts(session: dict) -> dict:
    """What a caller (the assistant) may see: names, sizes, states. Never bytes."""
    return {
        "state": session["state"],
        "files": [{"name": f["relPath"], "size": f["size"], "state": f["state"], **({"reason": f["reason"]} if f.get("reason") else {})} for f in session.get("files", [])],
        "totals": {k: session["totals"].get(k) for k in ("files", "bytes", "committed")},
    }


def _require_attested(body: dict) -> None:
    if body.get("attested") is not True:
        raise HTTPException(422, "confirm that you have the rights to add this data (attested: true)")


def import_url(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> dict:
    """Check the link and queue the fetch; `{importId, state: "fetching"}` at once."""
    _require_attested(body)
    _, url = check_url(body.get("url"))
    folder = body.get("folderId")
    host = urlsplit(url).netloc
    who = projects.person(ctx)
    s = ImportSession(id=projects.new_id("imp"), project_id=p.id, source_id="", target_node_id=str(folder) if folder else None, state="fetching", totals={"origin": {"kind": "url", "host": host}}, created_by=who, attested_by=who, attested_at=now())
    db.add(s)
    db.flush()
    j, _ = jobs.enqueue(db, ctx, plugin_id=PLUGIN, version=VERSION, tool=TOOL, input={"importId": s.id, "projectId": p.id, "url": url, "folderId": folder, "onBehalfOf": ctx.on_behalf_of}, capability=None, provider=None, estimated_cost_usd=0.0, timeout_s=JOB_TIMEOUT_S)
    s.totals = {**s.totals, "jobId": j.job_id}
    imports._publish(db, ctx, s)
    return {"importId": s.id, "state": "fetching", "jobId": j.job_id}


def worker_job(db: Session, job_id: str, worker_id: str) -> PluginJob:
    j = jobs._owned(db, job_id, worker_id)
    if j.plugin_id != PLUGIN or j.tool != TOOL:
        raise HTTPException(404, "not an import job")
    return j


def _fail_session(db: Session, s: ImportSession, error: str) -> None:
    s.state, s.error, s.finished_at = "failed", error, now()


def record_progress(db: Session, import_id: str, fetched: int, total: int | None) -> None:
    """`totals.fetchedBytes` / `fetchTotalBytes` of a `fetching` session (the imports list shows them)."""
    s = db.get(ImportSession, import_id)
    if s is not None and s.state == "fetching":
        s.totals = {**(s.totals or {}), "fetchedBytes": fetched, **({"fetchTotalBytes": total} if total else {})}


def _progress_writer(import_id: str) -> Callable[[int, int | None], None]:
    from ..db import session_scope

    last = [0.0]

    def write(n: int, total: int | None) -> None:
        if time.monotonic() - last[0] < 1.0 and (total is None or n < total):
            return
        last[0] = time.monotonic()
        with session_scope() as w:
            record_progress(w, import_id, n, total)

    return write


def run_fetch(db: Session, j: PluginJob) -> dict:
    """The worker's `imports.fetch_url`: fetch the link (pinned, capped), land the bytes in the
    session the route made, settle the job. A link that fails fails the session with a
    sentence a person can act on; the job fails as not recoverable."""
    inp = j.input or {}
    s = db.get(ImportSession, inp.get("importId"))
    p = db.get(ProjectRow, inp.get("projectId"))
    if s is None or p is None or s.state != "fetching":
        j.state, j.error, j.recoverable = "failed", "the import is gone", False
        jobs.settle(db, j, "invalid_input")
        return {"state": "failed"}
    ctx = RequestContext(j.workspace_id, j.principal, j.correlation_id or "", task_id=j.task_id, on_behalf_of=inp.get("onBehalfOf"))
    cap = settings().url_import_max_bytes
    try:
        scheme, url = check_url(inp.get("url"))
        # The fetch can take minutes: end this transaction so progress writes (their own
        # sessions) don't leave it on a stale snapshot, then report bytes about once a second.
        sid0 = s.id
        db.commit()
        token = PROGRESS.set(_progress_writer(sid0))
        try:
            got = FETCH(scheme, url, cap)
        except TooLarge:
            raise HTTPException(413, f"That file is larger than {imports._human(cap)}, the limit for an import from a link") from None
        finally:
            PROGRESS.reset(token)
        try:
            key = imports.upload_key(p.id, got.sha256, got.name)
            store = blobstore.data()
            if store.stat(key) is None:
                imports._put_file(store, key, got.path)
        finally:
            os.unlink(got.path)
    except HTTPException as e:
        _fail_session(db, s, str(e.detail))
        imports._publish(db, ctx, s)
        j.state, j.error, j.recoverable = "failed", str(e.detail), False
        jobs.settle(db, j, "invalid_input")
        return {"state": "failed", "error": str(e.detail)}
    host = urlsplit(url).netloc
    sid, folder = s.id, inp.get("folderId")
    db.delete(s)  # the placeholder; `_land` makes the real session under the same id
    db.flush()
    out = _land(db, ctx, p, [Landed(got.name, got.size, got.sha256)], folder_id=folder, title=f"From {host}", origin={"kind": "url", "host": host}, session_id=sid)
    j.state, j.progress, j.result = "succeeded", 1.0, {"importId": sid, "state": out["state"]}
    jobs.settle(db, j)
    return out


def _source_project(db: Session, ctx: RequestContext, body: dict) -> tuple[ProjectRow, str]:
    sample_id, from_pid = body.get("sampleId"), body.get("fromProjectId")
    if bool(sample_id) == bool(from_pid):
        raise HTTPException(422, "give fromProjectId or sampleId")
    if sample_id:
        raw = projects.seed_entry(str(sample_id)) if projects.ID_RE.fullmatch(str(sample_id)) else None
        tpl = db.get(ProjectRow, str(sample_id)) if raw is not None else None
        if raw is None or tpl is None or not tpl.seed or not samples.offered(raw) or not settings().samples_enabled:
            raise HTTPException(404, "no such sample")
        return tpl, "sample"
    return projects.require_project(db, ctx, str(from_pid)), "project"  # 404 unless the caller may read it


def copy_into(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> dict:
    _require_attested(body)
    src, kind = _source_project(db, ctx, body)
    if src.id == p.id:
        raise HTTPException(422, "that's this project: move files instead")
    node_ids = body.get("nodeIds")
    if node_ids is not None and (not isinstance(node_ids, list) or not all(isinstance(x, str) for x in node_ids)):
        raise HTTPException(422, "nodeIds must be a list of ids")
    starts = [n for n in db.scalars(select(SourceNode).where(SourceNode.id.in_(node_ids), SourceNode.project_id == src.id))] if node_ids else []
    if node_ids and len(starts) != len(set(node_ids)):
        raise HTTPException(404, "no such file in that project")
    if not node_ids:
        starts = [db.get(SourceNode, tree.drive_root_id(src.id)) or db.get(SourceNode, tree.node_id(src.id, ""))]  # type: ignore[list-item]
        starts = [s for s in starts if s is not None]
    files = [n for n in tree.files_under(db, [s.id for s in starts]) if n.asset_id]
    if not files:
        raise HTTPException(422, "nothing to copy there")
    limits = settings()
    if len(files) > limits.upload_max_session_files:
        raise HTTPException(413, f"Too many files: the limit is {limits.upload_max_session_files:,} per import")
    paths = tree.paths_of(db, [n.id for n in files] + [s.id for s in starts])
    prefixes = sorted({paths.get(s.id, "").rsplit("/", 1)[0] if "/" in paths.get(s.id, "") else "" for s in starts} if node_ids else {paths.get(s.id, "") for s in starts}, key=len, reverse=True)
    store = blobstore.data()
    landed: list[Landed] = []
    for n in files:
        full = paths.get(n.id, n.name)
        pre = next((x for x in prefixes if x and full.startswith(x + "/")), "")
        rel = full[len(pre) + 1:] if pre else full
        a = db.get(Asset, n.asset_id)
        if a is None:
            continue
        sha, size = n.sha256, n.size if n.size is not None else a.size
        key = imports.upload_key(p.id, sha, n.name) if sha else None
        if key is None or store.stat(key) is None:
            # Bytes go store to store through /tmp; seeds may carry no hash yet.
            path, size, sha = _spool(assets.store_of(a.path).iter_range(a.path), limits.upload_max_file_bytes)
            try:
                key = imports.upload_key(p.id, sha, n.name)
                if store.stat(key) is None:
                    imports._put_file(store, key, path)
            finally:
                os.unlink(path)
        landed.append(Landed(rel, size or 0, sha))
    if not landed:
        raise HTTPException(422, "nothing to copy there")
    return _land(db, ctx, p, landed, folder_id=body.get("folderId"), title=f"From {src.title}", origin={"kind": kind, "projectId": src.id})
