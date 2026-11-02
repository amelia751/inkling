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
    raw = body.get("provenance")
    claimed: dict = raw if isinstance(raw, dict) else {}
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


# ---- The `.studio/` tree (todo10 §3.2, Phase 2) -----------------------------------------------

LOCK_PATH = "plugins.lock.json"
# The dataset's structure (DatasetStructure v1, todo13 D8): the draft, kept by the kernel.
STRUCTURE_PATH = "structure.json"
# The project's rules (todo17 D3) at the time of the commit, so each dataset version carries them.
RULES_PATH = "rules.json"
TASK_PATH = re.compile(r"^tasks/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/(environment\.json|README\.md)$")
README_MAX = 64 * 1024


def env_path(task_id: str) -> str:
    return f"tasks/{task_id}/environment.json"


def readme_path(task_id: str) -> str:
    return f"tasks/{task_id}/README.md"


def effective_environment(db: Session, workspace_id: str, task_id: str) -> dict | None:
    """What a task boots with: its saved environment, else its seed's manifest environment."""
    from ..models import WorkspaceEnvironment
    from . import projects

    row = db.get(WorkspaceEnvironment, (workspace_id, task_id))
    if row is not None and row.revision > 0 and row.environment is not None:
        return row.environment
    return projects.base_environment(db, task_id)


def readme(db: Session, workspace_id: str, task_id: str) -> str | None:
    from ..models import TaskStudioNotes

    n = db.get(TaskStudioNotes, (workspace_id, task_id))
    return n.readme if n is not None else None


def set_readme(db: Session, ctx: RequestContext, task_id: str, text: str, author: str) -> None:
    from ..models import TaskStudioNotes, now

    text = text[:README_MAX]
    n = db.get(TaskStudioNotes, (ctx.workspace_id, task_id))
    if n is None:
        db.add(TaskStudioNotes(workspace_id=ctx.workspace_id, task_id=task_id, readme=text, updated_by=author, updated_at=now()))
    else:
        n.readme, n.updated_by, n.updated_at = text, author, now()
    db.flush()


def tasks_of(db: Session, ctx: RequestContext, dataset_id: str | None) -> list[str]:
    """The current task plus every task of the dataset (seeds: task, dataset and project share an id)."""
    from ..models import TaskRow

    ids = {ctx.task}
    if dataset_id:
        ids |= set(db.scalars(select(TaskRow.id).where(TaskRow.dataset_id == dataset_id)))
    return sorted(i for i in ids if TASK_PATH.fullmatch(env_path(i)))


def studio_files(db: Session, ctx: RequestContext, dataset_id: str | None = None) -> dict[str, str]:
    """The live Studio definition as `.studio/` files: lockfile and each task's environment and
    README, JSON in RFC 8785 canonical form (what apps/versioning requires)."""
    from ..plugins import installer
    from .canonical import canonicalize

    installer.bootstrap(db, ctx)  # a workspace nobody opened yet still has its first-party pins
    files = {LOCK_PATH: canonicalize(lockfile(db, ctx.workspace_id))}
    for t in tasks_of(db, ctx, dataset_id):
        env = effective_environment(db, ctx.workspace_id, t)
        if env is not None:
            files[env_path(t)] = canonicalize(env)
        notes = readme(db, ctx.workspace_id, t)
        if notes:
            files[readme_path(t)] = notes
    if dataset_id:
        from ..models import DatasetStructureRow

        draft = db.get(DatasetStructureRow, (dataset_id, "draft"))
        if draft is not None and draft.structure:
            files[STRUCTURE_PATH] = canonicalize(draft.structure)
    rules = rules_file(db, ctx.workspace_id)
    if rules is not None:
        files[RULES_PATH] = rules
    return files


def rules_file(db: Session, project_id: str) -> str | None:
    """The project's rules as canonical JSON (`.studio/rules.json`), or None for no project."""
    from ..models import ProjectRow
    from . import rules as krules
    from .canonical import canonicalize

    p = db.get(ProjectRow, project_id)
    return canonicalize(krules.get(db, p)["rules"]) if p is not None else None


def parse_files(files: dict[str, str]) -> dict:
    """`.studio/` files → `{lockfile, lockfileHash, tasks: {id: {environment, contentHash, readme}}, structure?}`."""
    out: dict = {"lockfile": None, "tasks": {}}
    if RULES_PATH in files:
        try:
            out["rules"] = json.loads(files[RULES_PATH])
        except ValueError:
            out["rules"] = None
    if STRUCTURE_PATH in files:
        try:
            out["structure"] = json.loads(files[STRUCTURE_PATH])
        except ValueError:
            out["structure"] = None
    if LOCK_PATH in files:
        try:
            out["lockfile"] = json.loads(files[LOCK_PATH])
            out["lockfileHash"] = lockfile_hash(out["lockfile"])
        except (ValueError, KeyError, TypeError):
            out["lockfile"] = None
    for path, text in files.items():
        m = TASK_PATH.fullmatch(path)
        if not m:
            continue
        t = out["tasks"].setdefault(m.group(1), {})
        if m.group(2) == "README.md":
            t["readme"] = text
        else:
            try:
                t["environment"] = json.loads(text)
                t["contentHash"] = content_hash(t["environment"])
            except ValueError:
                t["environment"] = None
    return out


# ---- Writing and restoring a definition ------------------------------------------------------


# `environment.updated` carries the patch when it's small; a client refetches otherwise.
PATCH_EVENT_MAX = 64 * 1024


def save_revision(db: Session, ctx: RequestContext, row, seen: int, environment, prov: Provenance, parent: str, patch: list | None = None) -> WorkspaceEnvironmentRevision | None:
    """Store revision `seen + 1` of `ctx.task`'s environment only if nobody else saved since
    (conditional UPDATE / unique INSERT) and append it to the history with its hashes and
    provenance. None on a lost race. Every write publishes `environment.updated` on the
    project's event stream in the same transaction (todo11 §6), so an open Studio applies it."""
    from sqlalchemy import update
    from sqlalchemy.exc import IntegrityError

    from ..models import WorkspaceEnvironment, now

    at = now()
    rev = seen + 1
    try:
        if row is None:
            db.add(WorkspaceEnvironment(workspace_id=ctx.workspace_id, task_id=ctx.task, revision=rev, environment=environment, author=prov.author, saved_at=at))
        else:
            res = db.execute(
                update(WorkspaceEnvironment)
                .where(WorkspaceEnvironment.workspace_id == ctx.workspace_id, WorkspaceEnvironment.task_id == ctx.task, WorkspaceEnvironment.revision == seen)
                .values(revision=rev, environment=environment, author=prov.author, saved_at=at)
                .execution_options(synchronize_session=False)
            )
            if res.rowcount != 1:  # type: ignore[attr-defined]
                return None
        hist = WorkspaceEnvironmentRevision(
            workspace_id=ctx.workspace_id, task_id=ctx.task, revision=rev, environment=environment, author=prov.author, saved_at=at,
            content_hash=content_hash(environment), parent_hash=parent, author_kind=prov.kind, agent_run_id=prov.run_id, prompt_hash=prov.prompt_hash,
        )
        db.add(hist)
        db.flush()
    except IntegrityError:
        return None
    from . import events

    payload: dict = {"taskId": ctx.task, "revision": rev, "author": prov.author, "authorKind": prov.kind, "contentHash": hist.content_hash, "parentHash": parent}
    if prov.run_id:
        payload["runId"] = prov.run_id
    if patch is not None and len(json.dumps(patch)) <= PATCH_EVENT_MAX:
        payload["patch"] = patch
    events.publish(db, ctx, "environment.updated", payload, source="kernel")
    return hist


def write_environment(db: Session, ctx: RequestContext, task_id: str, environment, prov: Provenance) -> WorkspaceEnvironmentRevision | None:
    """A new revision of a task's environment unless it already is `environment` (None then).
    Raises on a concurrent save (the caller's transaction rolls back)."""
    from fastapi import HTTPException

    from ..models import WorkspaceEnvironment
    from ..context import ensure_workspace

    ensure_workspace(db, ctx.workspace_id)
    c = ctx.for_scope(ctx.workspace_id, task_id)
    db.expire_all()
    row = db.get(WorkspaceEnvironment, (ctx.workspace_id, task_id))
    seen = row.revision if row is not None else 0
    current = effective_environment(db, ctx.workspace_id, task_id)
    if current is not None and environment is not None and content_hash(current) == content_hash(environment):
        return None
    hist = save_revision(db, c, row, seen, environment, prov, parent_hash(db, ctx.workspace_id, task_id, seen, current))
    if hist is None:
        raise HTTPException(409, "the environment changed while restoring it; try again")
    return hist


def restore_pins(db: Session, ctx: RequestContext, lock: dict) -> dict:
    """Make the workspace's ACTIVATED pins exactly `lock`'s: plugins not in it are disabled,
    the rest re-pinned to the locked version, digest and config. A locked version the catalogue
    no longer has, or whose digest changed, is reported and not loaded (pin by digest). Grants
    beyond the lockfile's are revoked; missing ones are re-granted only for a person."""
    from ..models import WorkspacePlugin, WorkspacePluginGrant
    from ..plugins import catalog, installer

    want = {p["id"]: p for p in (lock.get("plugins") or [])}
    out: dict[str, list] = {"disabled": [], "restored": [], "unchanged": [], "refused": []}
    for row in installer.installations(db, ctx.workspace_id):
        if row.state == ACTIVE and row.plugin_id not in want:
            installer._pin(db, ctx, row.plugin_id, row.version, row.artifact_digest, row.config_revision, "DISABLED")
            out["disabled"].append(row.plugin_id)
    for pid, p in sorted(want.items()):
        row = db.get(WorkspacePlugin, (ctx.workspace_id, pid))
        if not (row is not None and row.state == ACTIVE and (row.version, row.artifact_digest, row.config_revision) == (p["version"], p["digest"], p["configRevision"])):
            e = catalog.get(pid, p["version"])
            if e is None or e.artifact_digest != p["digest"]:
                out["refused"].append({"id": pid, "version": p["version"], "reason": "not in the catalogue" if e is None else "digest changed"})
                continue
            installer._register_version(db, e)
            installer._pin(db, ctx, pid, p["version"], p["digest"], int(p["configRevision"]), ACTIVE)
            out["restored"].append(pid)
        else:
            out["unchanged"].append(pid)
        granted = {g.permission: g for g in db.scalars(select(WorkspacePluginGrant).where(WorkspacePluginGrant.workspace_id == ctx.workspace_id, WorkspacePluginGrant.plugin_id == pid, WorkspacePluginGrant.version == p["version"]))}
        locked = set(p.get("permissions") or [])
        for perm, g in granted.items():
            if perm not in locked:
                db.delete(g)
        if not ctx.principal.startswith("agent:"):
            for perm in sorted(locked - set(granted)):
                db.add(WorkspacePluginGrant(workspace_id=ctx.workspace_id, plugin_id=pid, version=p["version"], permission=perm, granted_by=ctx.principal))
    db.flush()
    return out


def restore_definition(db: Session, ctx: RequestContext, files: dict[str, str], reason: str) -> dict:
    """Make the live Studio (environments and plugin pins) match a `.studio/` tree: what
    restoring a version does (todo10 Phase 2). A person only: pins are capability changes."""
    from fastapi import HTTPException

    if ctx.principal.startswith("agent:"):
        raise HTTPException(403, "only a person can restore a Studio setup (it changes plugin pins)")
    parsed = parse_files(files)
    prov = Provenance(ctx.principal.removeprefix("user:"), "person")
    envs = {}
    for t, d in sorted(parsed["tasks"].items()):
        if d.get("environment") is not None:
            h = write_environment(db, ctx, t, d["environment"], prov)
            envs[t] = {"revision": h.revision, "contentHash": h.content_hash} if h is not None else "unchanged"
        if "readme" in d:
            set_readme(db, ctx, t, d["readme"], prov.author)
    pins = restore_pins(db, ctx, parsed["lockfile"]) if parsed["lockfile"] is not None else None
    return {"reason": reason, "environments": envs, "plugins": pins}


# ---- last-known-good, safe mode and rollback (todo10 §3.4, Phase 4) ---------------------------

PERSON, CHECKS = "person", "checks"


def known_good_doc(k) -> dict:
    return {
        "revision": k.revision, "environment": k.environment, "contentHash": k.content_hash, "lockfile": k.lockfile, "lockfileHash": k.lockfile_hash,
        **({"commitOid": k.commit_oid} if k.commit_oid else {}), "movedBy": k.moved_by, "movedBecause": k.moved_because, "movedAt": k.moved_at.isoformat(),
    }


def known_good(db: Session, workspace_id: str, task_id: str):
    from ..models import StudioKnownGood

    return db.get(StudioKnownGood, (workspace_id, task_id))


def _widens(new: dict, old: dict) -> list[str]:
    """Capability-widening changes from `old` to `new` (todo10 §3.4: a new plugin, new
    permissions, a new signer), which only a person may make known-good."""
    before = {p["id"]: p for p in old.get("plugins") or []}
    out = []
    for p in new.get("plugins") or []:
        o = before.get(p["id"])
        if o is None:
            out.append(f"new plugin {p['id']}")
            continue
        extra = set(p.get("permissions") or []) - set(o.get("permissions") or [])
        if extra:
            out.append(f"{p['id']} gains {', '.join(sorted(extra))}")
        if p.get("signer") != o.get("signer"):
            out.append(f"{p['id']} has a new signer")
    return out


def move_known_good(db: Session, ctx: RequestContext, task_id: str, revision: int, because: str, commit_oid: str | None = None) -> dict:
    """Point `last-known-good` at a task's environment revision (0: its base) and the
    workspace's current lockfile. A person may move it anywhere; passing checks only to a
    person's revision that widens nothing (todo10 §3.4)."""
    from fastapi import HTTPException

    from ..models import StudioKnownGood, WorkspaceEnvironment, now
    from ..plugins import installer
    from . import audit, projects

    if ctx.principal.startswith("agent:"):
        raise HTTPException(403, "only a person or passing checks move last-known-good")
    row = db.get(WorkspaceEnvironment, (ctx.workspace_id, task_id))
    current = row.revision if row is not None else 0
    if revision != current:
        raise HTTPException(409, {"message": "only the current setup can become known good", "current": current})
    if revision > 0:
        assert row is not None  # revision > 0 is the row's current revision
        rev = db.scalar(select(WorkspaceEnvironmentRevision).where(WorkspaceEnvironmentRevision.workspace_id == ctx.workspace_id, WorkspaceEnvironmentRevision.task_id == task_id, WorkspaceEnvironmentRevision.revision == revision))
        env, kind = (rev.environment, rev.author_kind) if rev is not None else (row.environment, "person")
    else:
        env, kind = projects.base_environment(db, task_id), PERSON
    installer.bootstrap(db, ctx.for_scope(ctx.workspace_id, task_id))
    lock = lockfile(db, ctx.workspace_id)
    prev = known_good(db, ctx.workspace_id, task_id)
    if because == CHECKS:
        if kind != PERSON:
            return {"moved": False, "reason": "an agent's change becomes known good only when a person marks it"}
        widened = _widens(lock, prev.lockfile) if prev is not None else []
        if widened:
            return {"moved": False, "reason": "the plugins widen what the Studio may do: " + "; ".join(widened)}
    h, lh = content_hash(env), lockfile_hash(lock)
    if prev is not None and prev.revision == revision and prev.content_hash == h and prev.lockfile_hash == lh:
        return {"moved": False, "reason": "already known good", "knownGood": known_good_doc(prev)}
    before = {"revision": prev.revision, "contentHash": prev.content_hash, "lockfileHash": prev.lockfile_hash} if prev is not None else None
    if prev is None:
        prev = StudioKnownGood(workspace_id=ctx.workspace_id, task_id=task_id)
        db.add(prev)
    prev.revision, prev.environment, prev.content_hash, prev.lockfile, prev.lockfile_hash = revision, env, h, lock, lh
    prev.commit_oid, prev.moved_by, prev.moved_because, prev.moved_at = commit_oid, ctx.principal, because, now()
    db.flush()
    audit.record(db, ctx.for_scope(ctx.workspace_id, task_id), "studio.known_good.moved", target=f"task:{task_id}", before=before, after={"revision": revision, "contentHash": h, "lockfileHash": lh, "because": because, "authorKind": kind})
    return {"moved": True, "knownGood": known_good_doc(prev), "authorKind": kind}


def rollback(db: Session, ctx: RequestContext, task_id: str) -> dict:
    """Restore `last-known-good` in one transaction (the caller's): the environment as a new
    revision and the plugin pins exactly as locked, with a hash-chained audit entry. No model
    call, no versioning service: a pointer move a person makes (todo10 §1.6)."""
    from fastapi import HTTPException

    from . import audit

    if ctx.principal.startswith("agent:"):
        raise HTTPException(403, "only a person can roll the Studio back")
    k = known_good(db, ctx.workspace_id, task_id)
    if k is None:
        raise HTTPException(404, "this task has no last-known-good setup yet")
    before = {"lockfileHash": lockfile_hash(lockfile(db, ctx.workspace_id))}
    env = effective_environment(db, ctx.workspace_id, task_id)
    before["contentHash"] = content_hash(env)
    prov = Provenance(ctx.principal.removeprefix("user:"), PERSON)
    hist = write_environment(db, ctx, task_id, k.environment, prov) if k.environment is not None else None
    pins = restore_pins(db, ctx, k.lockfile)
    after_lock = lockfile_hash(lockfile(db, ctx.workspace_id))
    entry = audit.record(db, ctx.for_scope(ctx.workspace_id, task_id), "studio.rollback", target=f"task:{task_id}", before=before,
                         after={"revision": hist.revision if hist else None, "contentHash": k.content_hash, "lockfileHash": after_lock, "knownGoodLockfileHash": k.lockfile_hash, "plugins": pins})
    return {"knownGood": known_good_doc(k), "revision": hist.revision if hist else None, "contentHash": k.content_hash, "lockfileHash": after_lock, "plugins": pins, "audit": {"id": entry.id, "hash": entry.entry_hash, "prev": entry.prev_hash}}
