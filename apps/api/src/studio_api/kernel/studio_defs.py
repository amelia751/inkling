"""Studio definitions (todo10 §3.2): the plugin lockfile and environment revision provenance.

A Studio is defined by data: each task's environment (JSON, edited by JSON Patch) and the
workspace's `plugins.lock.json`, the exact plugin versions it runs, pinned by digest. Both are
identified by their RFC 8785 content hash (`canonical.py`), so the same definition always
hashes the same in the kernel and in the browser (`packages/contracts/src/lockfile.ts`).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import PluginPackage, PluginVersion, WorkspaceEnvironmentRevision, WorkspacePlugin, WorkspacePluginGrant
from .canonical import NULL_CONTENT_HASH, content_hash

LOCKFILE_VERSION = 1
FIRST_PARTY_SIGNER = "first-party"
UNSIGNED = "unsigned"
FIRST_PARTY_TIERS = {"first-party", "builtin"}
ACTIVE = "ACTIVATED"
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# The agent service names its run (`X-Agent-Run`, as for proposals) and the hash of the prompt
# that started it (`X-Agent-Prompt-Hash`). The Studio's own assistant panel runs the agent's
# environment tools in the person's session, so it sends the same two values in the body.
RUN_HEADER = "X-Agent-Run"
PROMPT_HASH_HEADER = "X-Agent-Prompt-Hash"
RUN_RE = re.compile(r"^run_[A-Za-z0-9-]{1,64}$")


# ---- Lockfile ---------------------------------------------------------------------------------


def _signer(db: Session, plugin_id: str, version: str) -> str:
    pkg = db.get(PluginPackage, plugin_id)
    if pkg is not None and pkg.trust_tier in FIRST_PARTY_TIERS:
        return FIRST_PARTY_SIGNER
    pv = db.get(PluginVersion, (plugin_id, version))
    try:
        sig = json.loads(pv.signature) if pv is not None and pv.signature else None
    except ValueError:
        sig = None
    if isinstance(sig, dict):
        key = sig.get("keyId") or sig.get("key_id")
        if key:
            return f"{sig.get('alg') or 'key'}:{key}"[:256]
    return UNSIGNED


def lockfile(db: Session, workspace_id: str) -> dict:
    """`plugins.lock.json` for a workspace: its ACTIVATED pins, sorted, with granted permissions."""
    rows = db.scalars(select(WorkspacePlugin).where(WorkspacePlugin.workspace_id == workspace_id, WorkspacePlugin.state == ACTIVE)).all()
    grants: dict[tuple[str, str], set[str]] = {}
    for g in db.scalars(select(WorkspacePluginGrant).where(WorkspacePluginGrant.workspace_id == workspace_id)):
        grants.setdefault((g.plugin_id, g.version), set()).add(g.permission)
    plugins = []
    for r in sorted(rows, key=lambda r: r.plugin_id):
        pv = None if r.artifact_digest else db.get(PluginVersion, (r.plugin_id, r.version))
        digest = r.artifact_digest or (pv.artifact_digest if pv else None)
        if not digest or not DIGEST_RE.fullmatch(digest):
            # Never a tag without a digest in the load path (todo10 §5): an undigested pin
            # can't be locked, so it can't be restored either.
            continue
        plugins.append({
            "id": r.plugin_id,
            "version": r.version,
            "digest": digest,
            "signer": _signer(db, r.plugin_id, r.version),
            "permissions": sorted(grants.get((r.plugin_id, r.version), set())),
            "configRevision": int(r.config_revision or 0),
        })
    return {"lockfileVersion": LOCKFILE_VERSION, "plugins": plugins}


def normalize_lockfile(lock: dict) -> dict:
    return {
        "lockfileVersion": LOCKFILE_VERSION,
        "plugins": sorted(({**p, "permissions": sorted(set(p.get("permissions") or []))} for p in lock.get("plugins") or []), key=lambda p: p["id"]),
    }


def lockfile_hash(lock: dict) -> str:
    return content_hash(normalize_lockfile(lock))


# ---- Revision provenance ----------------------------------------------------------------------


@dataclass(frozen=True)
class Provenance:
    author: str
    kind: str  # person | agent
    run_id: str | None = None
    prompt_hash: str | None = None


def provenance(ctx: RequestContext, headers, body: dict) -> Provenance:
    """Who made a change. An agent session is always `agent` and can't name another author;
    a person's session may record that its assistant made the change (`author: agent:…`),
    which only ever narrows trust."""
    claimed = body.get("provenance") if isinstance(body.get("provenance"), dict) else {}
    if ctx.principal.startswith("agent:"):
        run = headers.get(RUN_HEADER) or ""
        run_id = run if RUN_RE.fullmatch(run) else None
        ph = headers.get(PROMPT_HASH_HEADER) or ""
        return Provenance(f"agent:{run_id}" if run_id else ctx.principal, "agent", run_id, ph if DIGEST_RE.fullmatch(ph) else None)
    author = str(body.get("author") or ctx.principal.removeprefix("user:"))[:256]
    if author.startswith("agent:") or claimed.get("kind") == "agent":
        run = str(claimed.get("runId") or "")
        ph = str(claimed.get("promptHash") or "")
        return Provenance(author, "agent", run if RUN_RE.fullmatch(run) else None, ph if DIGEST_RE.fullmatch(ph) else None)
    return Provenance(author, "person")


def parent_hash(db: Session, workspace_id: str, task_id: str, seen: int, base: dict | None) -> str:
    """The content hash of the revision being replaced; for a first revision, its base's."""
    if seen > 0:
        prev = db.scalar(select(WorkspaceEnvironmentRevision.content_hash).where(WorkspaceEnvironmentRevision.workspace_id == workspace_id, WorkspaceEnvironmentRevision.task_id == task_id, WorkspaceEnvironmentRevision.revision == seen))
        if prev:
            return prev
    return content_hash(base) if base is not None else NULL_CONTENT_HASH


def revision_meta(r: WorkspaceEnvironmentRevision) -> dict:
    out = {"contentHash": r.content_hash, "parentHash": r.parent_hash, "authorKind": r.author_kind}
    if r.agent_run_id:
        out["agentRunId"] = r.agent_run_id
    if r.prompt_hash:
        out["promptHash"] = r.prompt_hash
    return out
