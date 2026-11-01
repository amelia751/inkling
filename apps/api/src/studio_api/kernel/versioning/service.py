"""Dataset versioning operations (todo4 Phase 6): the one place UI routes, kernel commands,
the agent and the worker reach apps/versioning through.

Every operation: resolve the dataset in the caller's workspace → check the session's kernel
scope and the agent policy → mint a JWT with only the scopes it needs → call the service →
write a kernel audit entry. A service problem keeps its status and `code` for the caller.

Agent policy (spec §16C), enforced here as well as in the service: an `agent:` principal can
never approve, merge, resolve conflicts, release or create datasets, and may write (branch,
commit, revert) only on `work/agent-*` branches.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...context import RequestContext
from ...models import AnnotationDocumentRow, DatasetRepo, VersionedAnnotationPayload
from ...naming import canonical_id, ns
from .. import audit, events, studio_defs
from . import auth, studio
from .auth import ADMIN, APPROVE, CHECKOUT, CHECKS, MERGE, READ, RELEASE, REVIEW, WRITE
from .client import VersioningProblem, client, problem

OID_RE = re.compile(r"^[0-9a-f]{40}$")
DATASET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
AGENT_BRANCH_PREFIX = "work/agent-"
DEID_CHECK = "deidentification"


@dataclass(frozen=True)
class Op:
    scope: str  # kernel session scope (ctx.allows)
    jwt: tuple[str, ...]  # versioning scopes minted for the call
    agent: bool = True  # agents may call it at all
    agent_branch: bool = False  # agents only on work/agent-* branches


OPS: dict[str, Op] = {
    "dataset.create": Op("versioning.admin", (ADMIN, READ, WRITE, CHECKOUT), agent=False),
    "dataset.get": Op("versioning.read", (READ,)),
    "branch": Op("versioning.write", (READ, WRITE), agent_branch=True),
    "branches": Op("versioning.read", (READ,)),
    "artifact": Op("versioning.write", (WRITE,)),
    "commit": Op("versioning.write", (READ, WRITE, CHECKOUT), agent_branch=True),
    "commits": Op("versioning.read", (READ,)),
    "commit.get": Op("versioning.read", (READ,)),
    "revert": Op("versioning.write", (READ, WRITE), agent_branch=True),
    "diff": Op("versioning.read", (READ,)),
    "document": Op("versioning.read", (READ, CHECKOUT)),
    "review.open": Op("versioning.review", (READ, REVIEW)),
    "reviews": Op("versioning.read", (READ,)),
    "review.get": Op("versioning.read", (READ,)),
    "review.approve": Op("versioning.approve", (READ, APPROVE), agent=False),
    "review.resolve": Op("versioning.review", (READ, REVIEW, WRITE, CHECKOUT), agent=False),
    "review.check": Op("versioning.checks", (READ, CHECKS), agent=False),
    # A merge stores the merged (and custom-resolved) annotation revisions: it writes too.
    "merge": Op("versioning.merge", (READ, MERGE, WRITE), agent=False),
    "release": Op("versioning.release", (READ, RELEASE), agent=False),
    "releases": Op("versioning.read", (READ,)),
    "checkout": Op("versioning.checkout", (READ, CHECKOUT)),
    # todo10 Phase 2: the Studio definition (`.studio/`) at a ref, and committing the live one.
    "studio": Op("versioning.read", (READ,)),
    "studio.commit": Op("versioning.write", (READ, WRITE, CHECKOUT), agent_branch=True),
}

# Kernel commands (POST /api/v1/commands, so the agent and MCP get them through the gateway):
# command id → operation.
COMMANDS: dict[str, str] = {
    ns("versioning.commit"): "commit",
    ns("versioning.branch"): "branch",
    ns("versioning.diff"): "diff",
    ns("versioning.review.open"): "review.open",
    ns("versioning.review.approve"): "review.approve",
    ns("versioning.merge"): "merge",
    ns("versioning.release"): "release",
    ns("versioning.checkout"): "checkout",
}


@dataclass
class Call:
    db: Session
    ctx: RequestContext
    dataset_id: str
    op: str
    repo_id: str = ""
    audit_after: dict = field(default_factory=dict)

    def token(self) -> str:
        return auth.mint(self.ctx, list(OPS[self.op].jwt))


# ---- Manifest cache: commits are immutable, so a manifest per oid never goes stale ----------

_MANIFESTS: OrderedDict[tuple[str, str], dict] = OrderedDict()
_MANIFEST_CACHE_SIZE = 256


def _cache_put(repo_id: str, oid: str, m: dict) -> None:
    _MANIFESTS[(repo_id, oid)] = m
    _MANIFESTS.move_to_end((repo_id, oid))
    while len(_MANIFESTS) > _MANIFEST_CACHE_SIZE:
        _MANIFESTS.popitem(last=False)


def clear_cache() -> None:
    _MANIFESTS.clear()


# ---- Helpers ---------------------------------------------------------------------------------


def slug(s: str) -> str:
    out = re.sub(r"[^a-z0-9._-]+", "-", s.lower()).strip("-.")
    return out[:48] or "x"


def work_branch(ctx: RequestContext, dataset_id: str) -> str:
    """`work/<actor>/<dataset>`; an agent's actor slug starts with `agent-`."""
    return f"work/{slug(ctx.principal)}/{slug(dataset_id)}"


def _key(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:40]


def _idem(c: Call, body: dict, *parts: Any) -> str:
    k = body.get("idempotency_key") or c.ctx.idempotency_key
    return str(k) if k and len(str(k)) >= 8 else _key(c.op, c.dataset_id, *parts, uuid.uuid4().hex)


def _repo(c: Call) -> str:
    row = c.db.get(DatasetRepo, (c.ctx.workspace_id, c.dataset_id))
    if row is None:
        raise problem(404, "not_found", f"dataset {c.dataset_id!r} isn't versioned in this workspace")
    return row.repo_id


def _branches(c: Call) -> list[dict]:
    out, cursor = [], None
    while True:
        page = client().list_branches(c.token(), c.repo_id, cursor=cursor, limit=1000)
        out += page.get("items") or []
        cursor = page.get("next_cursor")
        if not cursor:
            return out


def _branch(c: Call, name: str) -> dict | None:
    return next((b for b in _branches(c) if b["name"] == name), None)


def _resolve(c: Call, ref: str) -> str:
    """A branch name or commit oid → commit oid."""
    if OID_RE.fullmatch(ref):
        return ref
    b = _branch(c, ref)
    if b is None:
        raise problem(404, "not_found", f"no branch {ref!r}")
    return b["commit_oid"]


def _load_manifest(c: Call, ref: str, token: str | None = None) -> tuple[str, dict]:
    """The full manifest of a commit (oid, branch or `tag:<name>`) via checkout pages."""
    if OID_RE.fullmatch(ref) and (c.repo_id, ref) in _MANIFESTS:
        return ref, _MANIFESTS[(c.repo_id, ref)]
    tok = token or auth.mint(c.ctx, [READ, CHECKOUT])
    samples, anns, cursor, ontology, oid = [], [], None, None, ref
    while True:
        page = client().create_checkout(tok, c.repo_id, {"ref": ref, "limit": 1000, "include_urls": False, **({"cursor": cursor} if cursor else {})})
        oid, ontology = page["commit_oid"], page.get("ontology") or {"revision_id": "empty", "classes": []}
        samples += page.get("samples") or []
        anns += page.get("annotations") or []
        cursor = page.get("next_cursor")
        if not cursor:
            break
    m = {"schema_version": "1", "ontology": ontology, "samples": samples, "annotations": anns}
    _cache_put(c.repo_id, oid, m)
    return oid, m


def _payloads(c: Call, refs: list[str]) -> dict[str, dict]:
    if not refs:
        return {}
    rows = c.db.scalars(select(VersionedAnnotationPayload).where(VersionedAnnotationPayload.workspace_id == c.ctx.workspace_id, VersionedAnnotationPayload.ref.in_(refs)))
    return {r.ref: r.annotation for r in rows}


def _put_revision(c: Call, token: str, rev: dict, annotation: dict | None) -> str:
    """Store a revision (reusing the ref of an identical earlier save) and its Studio payload."""
    cache_key = _key(annotation and studio.studio_hash(annotation), rev["ontology_rev"], rev["annotation_id"], rev["sample_id"]) if annotation else None
    if cache_key:
        hit = c.db.scalar(select(VersionedAnnotationPayload.ref).where(VersionedAnnotationPayload.workspace_id == c.ctx.workspace_id, VersionedAnnotationPayload.cache_key == cache_key))
        if hit:
            return hit
    ref = client().put_annotation_revision(token, rev)["ref"]
    if annotation is not None and c.db.get(VersionedAnnotationPayload, (c.ctx.workspace_id, ref)) is None:
        c.db.add(VersionedAnnotationPayload(workspace_id=c.ctx.workspace_id, ref=ref, annotation_id=str(annotation.get("id")), cache_key=cache_key or "", annotation=annotation))
        c.db.flush()
    return ref


def _ensure_samples(c: Call, token: str, m: dict, item_ids: set[str], modality: str = "image") -> None:
    have = {s["sample_id"] for s in m["samples"]}
    for item in sorted(item_ids):
        sid = studio.sample_id(item)
        if sid in have:
            continue
        data = studio.pointer(c.ctx.workspace_id, item)
        sha = hashlib.sha256(data).hexdigest()
        client().put_artifact(token, sha, data, studio.POINTER_MEDIA_TYPE)
        m["samples"].append({"sample_id": sid, "modality": modality, "objects": [{"role": studio.POINTER_ROLE, "sha256": sha, "size_bytes": len(data), "media_type": studio.POINTER_MEDIA_TYPE}]})
        have.add(sid)


def _ensure_classes(m: dict, labels: dict[str, str]) -> None:
    """Add classes for labels; a changed class set gets a new ontology revision id."""
    classes = list(m["ontology"].get("classes") or [])
    known = {x["class_id"] for x in classes}
    added = [{"class_id": cid, "name": name[:200] or cid} for cid, name in sorted(labels.items()) if cid not in known]
    if not added:
        return
    classes += added
    rev = "ont-" + _key(sorted(x["class_id"] for x in classes))[:20]
    m["ontology"] = {**m["ontology"], "revision_id": rev, "classes": classes}
    for a in m["annotations"]:
        a["ontology_rev"] = rev


def _studio_entries(c: Call, token: str, m: dict, anns: list[dict]) -> list[dict]:
    """Manifest entries for Studio annotations (samples and classes are added to `m`)."""
    anns = [{**a, "geometry": {**a["geometry"], "type": canonical_id(a["geometry"]["type"])}} if isinstance((a.get("geometry") or {}).get("type"), str) else a for a in anns]
    for a in anns:
        for k in ("id", "itemId"):
            if not isinstance(a.get(k), str) or not a[k]:
                raise problem(422, "validation_failed", f"annotation.{k} must be a non-empty string")
    _ensure_samples(c, token, m, {a["itemId"] for a in anns})
    _ensure_classes(m, {studio.class_id(str(a.get("label", ""))): str(a.get("label", "")) for a in anns})
    rev_id = m["ontology"].get("revision_id") or "empty"
    out = []
    for a in anns:
        rev = studio.revision_for(a, ontology_rev=rev_id, actor_id=c.ctx.principal)
        out.append(studio.manifest_entry(rev, _put_revision(c, token, rev, a)))
    return out


def _upsert(items: list[dict], new: list[dict], key: str) -> list[dict]:
    by = {x[key]: x for x in items}
    for n in new:
        by[n[key]] = n
    return list(by.values())


def _document(c: Call, m: dict, oid: str, token: str | None = None) -> list[dict]:
    """Studio annotations for a manifest: kernel payloads, else rebuilt from the revisions."""
    refs = [a["ref"] for a in m["annotations"]]
    have = _payloads(c, refs)
    missing = [a for a in m["annotations"] if a["ref"] not in have]
    if missing:
        names = {x["class_id"]: x.get("name", x["class_id"]) for x in m["ontology"].get("classes") or []}
        latest: dict[str, dict] = {}
        for r in c.db.scalars(select(VersionedAnnotationPayload).where(VersionedAnnotationPayload.workspace_id == c.ctx.workspace_id, VersionedAnnotationPayload.annotation_id.in_([a["annotation_id"] for a in missing])).order_by(VersionedAnnotationPayload.created_at)):
            latest[studio.safe_id(r.annotation_id, "a")] = r.annotation
        revs = _fetch_revisions(c, oid, [a["ref"] for a in missing], token)
        for a in missing:
            rev = revs.get(a["ref"])
            if rev is not None:
                have[a["ref"]] = studio.annotation_from_revision(rev, latest.get(a["annotation_id"]), names)
    return [have[a["ref"]] for a in m["annotations"] if a["ref"] in have]


def _fetch_revisions(c: Call, oid: str, refs: list[str], token: str | None) -> dict[str, dict]:
    """Revision documents by ref, read through a checkout's signed URLs."""
    if not refs:
        return {}
    want = {r.split(":", 1)[-1]: r for r in refs}
    out: dict[str, dict] = {}
    tok = token or auth.mint(c.ctx, [READ, CHECKOUT])
    cursor = None
    while True:
        page = client().create_checkout(tok, c.repo_id, {"ref": oid, "limit": 1000, "include_urls": True, **({"cursor": cursor} if cursor else {})})
        for o in page.get("objects") or []:
            ref = want.get(o.get("sha256", ""))
            if ref and o.get("url"):
                try:
                    out[ref] = json.loads(client().fetch(o["url"]))
                except (ValueError, VersioningProblem):
                    pass
        cursor = page.get("next_cursor")
        if not cursor:
            break
    return out


def _announce_checks(c: Call, branch: str | None = None, review: dict | None = None) -> None:
    """Publish `versioning.review.checks_requested` for reviews waiting on worker checks."""
    reviews = [review] if review else (client().list_reviews(auth.mint(c.ctx, [READ]), c.repo_id, status="CHECKING").get("items") or [])
    for r in reviews:
        if branch and branch not in (r.get("source_branch"), r.get("target_branch")):
            continue
        _publish_review_event(c, "versioning.review.checks_requested", r)


def _publish_review_event(c: Call, type_: str, r: dict) -> None:
    deid = next((x for x in r.get("checks") or [] if x.get("name") == DEID_CHECK), None)
    if r.get("status") != "CHECKING" or (deid and deid.get("outcome") != "pending"):
        return
    payload = {
        "datasetId": c.dataset_id,
        "reviewId": r["id"],
        "sourceBranch": r.get("source_branch"),
        "targetBranch": r.get("target_branch"),
        "sourceOid": r.get("source_oid"),
        "targetOid": r.get("checked_target_oid"),
    }
    events.publish(c.db, c.ctx, type_, payload, source=ns("kernel.versioning"), idempotency_key=f"review:{r['id']}:{payload['sourceOid']}:{payload['targetOid']}")


def _enrich_review(c: Call, r: dict) -> dict:
    """Attach the Studio annotations behind each conflict's refs (for the review page)."""
    refs = [x for cf in r.get("conflicts") or [] for x in (cf.get("ours_ref"), cf.get("theirs_ref"), cf.get("base_ref")) if x]
    pay = _payloads(c, refs)
    for cf in r.get("conflicts") or []:
        for side in ("ours", "theirs", "base"):
            if cf.get(f"{side}_ref") in pay:
                cf[f"{side}_annotation"] = pay[cf[f"{side}_ref"]]
    return r


# ---- Operations ------------------------------------------------------------------------------


def op_dataset_create(c: Call, body: dict) -> tuple[int, dict]:
    if not DATASET_RE.fullmatch(c.dataset_id):
        raise problem(400, "bad_request", "dataset ids are lowercase letters, digits, '.', '_' and '-'")
    existing = c.db.get(DatasetRepo, (c.ctx.workspace_id, c.dataset_id))
    if existing:
        c.repo_id = existing.repo_id
        return 200, op_dataset_get(c, {})[1] | {"created": False}
    req: dict[str, Any] = {"name": str(body.get("name") or c.dataset_id)[:200]}
    if body.get("required_approvals") is not None:
        req["required_approvals"] = int(body["required_approvals"])
    repo = client().create_repo(c.token(), req, _key("dataset.create", c.ctx.workspace_id, c.dataset_id))
    repo_id = str(repo.get("id") or (repo.get("repo") or {}).get("id") or "")
    c.db.add(DatasetRepo(workspace_id=c.ctx.workspace_id, dataset_id=c.dataset_id, repo_id=repo_id, created_by=c.ctx.principal))
    c.db.flush()
    c.repo_id = repo_id
    out = {"datasetId": c.dataset_id, "repoId": repo_id, "defaultBranch": repo.get("default_branch", "main"), "head": repo.get("head"), "headGeneration": repo.get("head_generation"), "created": True}
    # Bring the workspace's current (pre-versioning) annotations along, on the creator's work
    # branch: `main` is protected, so they reach it through a review like any other change.
    if body.get("import_document"):
        row = c.db.get(AnnotationDocumentRow, (c.ctx.workspace_id, c.ctx.task))
        name = work_branch(c.ctx, c.dataset_id)
        b = client().create_branch(c.token(), repo_id, {"name": name, "from": out["defaultBranch"]}, _key("work", repo_id, name))
        out["workBranch"] = name
        if row and row.annotations:
            res = _commit(c, {"branch": name, "expected_head": b["commit_oid"], "message": "Import existing annotations", "document": {"annotations": row.annotations}})
            out["imported"] = {"commit_oid": res["commit_oid"], "annotations": len(row.annotations)}
    c.audit_after = {"repoId": repo_id, "imported": bool(out.get("imported"))}
    return 201, out


def op_dataset_get(c: Call, body: dict) -> tuple[int, dict]:
    repo = client().get_repo(c.token(), c.repo_id)
    r = repo.get("repo") or repo
    return 200, {"datasetId": c.dataset_id, "repoId": c.repo_id, "defaultBranch": r.get("default_branch", "main"), "head": repo.get("head"), "headGeneration": repo.get("head_generation", repo.get("generation")), "requiredApprovals": r.get("required_approvals")}


def op_branch(c: Call, body: dict) -> tuple[int, dict]:
    """Create a branch; with no `name`, ensure the caller's work branch `work/<actor>/<dataset>`."""
    name = body.get("name") or work_branch(c.ctx, c.dataset_id)
    _agent_branch(c, name)
    existing = _branch(c, name)
    if existing and not body.get("name"):
        return 200, {**existing, "created": False}
    src = body.get("from") or "main"
    b = client().create_branch(c.token(), c.repo_id, {"name": name, "from": src}, _idem(c, body, name, src))
    c.audit_after = {"branch": name, "from": src, "commit_oid": b.get("commit_oid")}
    return 201, {**b, "created": True}


def op_branches(c: Call, body: dict) -> tuple[int, dict]:
    return 200, {"items": _branches(c), "workBranch": work_branch(c.ctx, c.dataset_id)}


def op_artifact(c: Call, body: dict) -> tuple[int, dict]:
    data: bytes = body["data"]
    sha = hashlib.sha256(data).hexdigest()
    art = client().put_artifact(c.token(), sha, data, str(body.get("media_type") or "application/octet-stream"))
    c.audit_after = {"sha256": sha, "size": len(data)}
    return 201, art


def _commit(c: Call, body: dict) -> dict:
    branch = str(body.get("branch") or work_branch(c.ctx, c.dataset_id))
    _agent_branch(c, branch)
    token = auth.mint(c.ctx, [READ, WRITE, CHECKOUT])
    expected = body.get("expected_head") or _resolve(c, branch)
    root = body.get("manifest_root")
    counts: dict = {}
    if not root:
        if body.get("manifest") is not None:
            m = body["manifest"]
        else:
            _, base = _load_manifest(c, expected, token)
            m = json.loads(json.dumps(base))
            ch = body.get("changes") or {}
            if body.get("document") is not None:
                # The Studio's save: the branch's annotation set becomes exactly the document's.
                m["annotations"] = _studio_entries(c, token, m, list((body["document"] or {}).get("annotations") or []))
            if ch.get("remove_samples"):
                drop = set(ch["remove_samples"])
                m["samples"] = [s for s in m["samples"] if s["sample_id"] not in drop]
                m["annotations"] = [a for a in m["annotations"] if a["sample_id"] not in drop]
            if ch.get("samples"):
                m["samples"] = _upsert(m["samples"], list(ch["samples"]), "sample_id")
            if ch.get("ontology_classes"):
                _ensure_classes(m, {x["class_id"]: x.get("name", x["class_id"]) for x in ch["ontology_classes"]})
            if ch.get("remove_annotations"):
                drop = {studio.safe_id(str(x), "a") for x in ch["remove_annotations"]} | set(map(str, ch["remove_annotations"]))
                m["annotations"] = [a for a in m["annotations"] if a["annotation_id"] not in drop]
            if ch.get("annotations"):
                m["annotations"] = _upsert(m["annotations"], _studio_entries(c, token, m, list(ch["annotations"])), "annotation_id")
            if ch.get("revisions"):
                rev_id = m["ontology"].get("revision_id") or "empty"
                entries = []
                for rev in ch["revisions"]:
                    rev = {"schema_version": "1", "ontology_rev": rev_id, "coordinate_frame": "pixel", "status": "draft", "provenance": {"actor_id": c.ctx.principal}, **rev}
                    entries.append(studio.manifest_entry(rev, _put_revision(c, token, rev, None)))
                m["annotations"] = _upsert(m["annotations"], entries, "annotation_id")
        written = client().put_manifest(token, c.repo_id, m)
        root = written["manifest_root"]
        counts = {"sample_count": written.get("sample_count"), "annotation_count": written.get("annotation_count")}
    else:
        m = None
    req = {"branch": branch, "expected_head": expected, "manifest_root": root, "message": str(body.get("message") or "Save annotations")[:2000], "idempotency_key": _idem(c, body, branch, expected, root)}
    if body.get("tool"):
        req["tool"] = str(body["tool"])[:128]
    res = client().create_commit(token, c.repo_id, req)
    if m is not None:
        _cache_put(c.repo_id, res["commit_oid"], m)
    c.audit_after = {"branch": branch, "expected_head": expected, "commit_oid": res["commit_oid"], "manifest_root": root, **counts}
    _announce_checks(c, branch=branch)
    return {**res, **counts}


def op_commit(c: Call, body: dict) -> tuple[int, dict]:
    return 201, _commit(c, body)


def op_commits(c: Call, body: dict) -> tuple[int, dict]:
    return 200, client().list_commits(c.token(), c.repo_id, str(body.get("ref") or "main"), body.get("cursor"), int(body.get("limit") or 50))


def op_commit_get(c: Call, body: dict) -> tuple[int, dict]:
    return 200, client().get_commit(c.token(), c.repo_id, str(body["oid"]))


def op_revert(c: Call, body: dict) -> tuple[int, dict]:
    branch = str(body.get("branch") or work_branch(c.ctx, c.dataset_id))
    _agent_branch(c, branch)
    expected = body.get("expected_head") or _resolve(c, branch)
    req = {"branch": branch, "expected_head": expected, "target_oid": str(body["target_oid"]), "message": str(body.get("message") or f"Revert to {str(body['target_oid'])[:10]}"), "idempotency_key": _idem(c, body, branch, expected, body["target_oid"])}
    res = client().revert(c.token(), c.repo_id, req)
    c.audit_after = {"branch": branch, "target_oid": req["target_oid"], "commit_oid": res.get("commit_oid")}
    # Restoring an old version restores its Studio setup (todo10 Phase 2): when a person reverts
    # their own work branch (the one their Studio runs), the live environments and plugin pins
    # follow the version's `.studio/` tree.
    if body.get("restore_studio", True) and not auth.is_agent(c.ctx) and branch == work_branch(c.ctx, c.dataset_id):
        files = _studio_at(c, res["commit_oid"])["files"]
        if files:
            res["restoredStudio"] = studio_defs.restore_definition(c.db, c.ctx, files, f"revert to {req['target_oid'][:10]}")
            c.audit_after["restoredStudio"] = True
    _announce_checks(c, branch=branch)
    return 201, res


# ---- Studio definitions (todo10 §3.2, Phase 2) ------------------------------------------------


def _studio_at(c: Call, ref: str) -> dict:
    return client().get_studio(auth.mint(c.ctx, [READ]), c.repo_id, ref)


def _studio_summary(s: dict) -> dict:
    """What a `.studio/` tree pins, in a few hashes (and one fingerprint over them)."""
    p = studio_defs.parse_files(s.get("files") or {})
    out: dict[str, Any] = {"tasks": {t: d.get("contentHash") for t, d in sorted(p["tasks"].items()) if d.get("contentHash")}}
    if s.get("studio_tree"):
        out["tree"] = s["studio_tree"]
    if p.get("lockfileHash"):
        out["lockfileHash"] = p["lockfileHash"]
    out["fingerprint"] = studio_defs.content_hash({"lockfileHash": out.get("lockfileHash"), "tasks": out["tasks"]})
    return out


def _commit_studio(c: Call, branch: str, message: str) -> dict | None:
    """Commit the live Studio definition onto `branch` (same manifest as its head) unless the
    branch already carries exactly it. None when unchanged."""
    _agent_branch(c, branch)
    token = auth.mint(c.ctx, [READ, WRITE, CHECKOUT])
    b = _branch(c, branch)
    if b is None:
        b = client().create_branch(token, c.repo_id, {"name": branch, "from": "main"}, _key("work", c.repo_id, branch))
    files = studio_defs.studio_files(c.db, c.ctx, c.dataset_id)
    if client().get_studio(token, c.repo_id, b["commit_oid"]).get("files") == files:
        return None
    head = client().get_commit(token, c.repo_id, b["commit_oid"])
    req = {"branch": branch, "expected_head": b["commit_oid"], "manifest_root": head["manifest_root"], "message": message[:2000], "tool": "studio", "studio": {"files": files},
           "idempotency_key": _key("studio", c.repo_id, branch, b["commit_oid"], studio_defs.content_hash(files))}
    res = client().create_commit(token, c.repo_id, req)
    return {**res, "studio": _studio_summary({"files": files, "studio_tree": res.get("studio_tree")})}


def op_studio(c: Call, body: dict) -> tuple[int, dict]:
    """The Studio setup at a ref (branch, oid or `tag:<release>`), parsed; with `current`, also
    the live one, so the Versions page can diff them."""
    s = _studio_at(c, str(body.get("ref") or work_branch(c.ctx, c.dataset_id)))
    out = {"commitOid": s["commit_oid"], "studioTree": s.get("studio_tree"), **studio_defs.parse_files(s.get("files") or {}), "summary": _studio_summary(s)}
    if body.get("current"):
        live = studio_defs.studio_files(c.db, c.ctx, c.dataset_id)
        out["current"] = {**studio_defs.parse_files(live), "summary": _studio_summary({"files": live})}
    return 200, out


def op_studio_commit(c: Call, body: dict) -> tuple[int, dict]:
    """Commit the live Studio setup (todo10 §3.2 moments: Task setup saved, an agent change
    approved) onto the caller's work branch, or `branch`."""
    branch = str(body.get("branch") or work_branch(c.ctx, c.dataset_id))
    res = _commit_studio(c, branch, str(body.get("message") or f"Studio setup: {str(body.get('reason') or 'saved')[:200]}"))
    c.audit_after = {"branch": branch, "reason": body.get("reason"), "commit_oid": (res or {}).get("commit_oid"), "unchanged": res is None}
    if res is None:
        return 200, {"branch": branch, "unchanged": True}
    _announce_checks(c, branch=branch)
    return 201, res


def op_diff(c: Call, body: dict) -> tuple[int, dict]:
    base, head = _resolve(c, str(body.get("base") or "main")), _resolve(c, str(body.get("head") or work_branch(c.ctx, c.dataset_id)))
    page = client().get_diff(c.token(), c.repo_id, base, head, body.get("cursor"), int(body.get("limit") or 200))
    if page.get("changes"):
        refs = [x for ch in page["changes"] for x in (ch.get("base_ref"), ch.get("head_ref")) if x]
        pay = _payloads(c, refs)
        for ch in page["changes"]:
            for side in ("base", "head"):
                if ch.get(f"{side}_ref") in pay:
                    ch[f"{side}_annotation"] = pay[ch[f"{side}_ref"]]
    return 200, page


def op_document(c: Call, body: dict) -> tuple[int, dict]:
    """The Studio's AnnotationDocument at a ref (branch, oid or `tag:<release>`)."""
    ref = str(body.get("ref") or work_branch(c.ctx, c.dataset_id))
    branch = None if OID_RE.fullmatch(ref) or ref.startswith("tag:") else _branch(c, ref)
    if branch is None and not (OID_RE.fullmatch(ref) or ref.startswith("tag:")):
        raise problem(404, "not_found", f"no branch {ref!r}")
    oid, m = _load_manifest(c, branch["commit_oid"] if branch else ref)
    anns = _document(c, m, oid)
    c.audit_after = {"ref": ref, "commit_oid": oid}
    return 200, {"revision": int(branch["generation"]) if branch else 0, "annotationsVersion": 2, "annotations": anns, "head": oid, "branch": branch["name"] if branch else None}


def op_review_open(c: Call, body: dict) -> tuple[int, dict]:
    source = str(body.get("source_branch") or work_branch(c.ctx, c.dataset_id))
    target = str(body.get("target_branch") or "main")
    # todo10 §3.2: a person's Studio setup travels to main (and so into releases) with the
    # review. An agent's never rides along unasked: its changes reach the setup only once a
    # person approves them (studio.commit).
    if source == work_branch(c.ctx, c.dataset_id) and body.get("studio", True) and not auth.is_agent(c.ctx):
        _commit_studio(c, source, "Studio setup for review")
    req: dict[str, Any] = {"title": str(body.get("title") or f"Changes from {source}")[:300], "source_branch": source, "target_branch": target}
    if body.get("description"):
        req["description"] = str(body["description"])[:20000]
    if body.get("draft"):
        req["draft"] = True
    r = client().create_review(c.token(), c.repo_id, req, _idem(c, body, source, target))
    _publish_review_event(c, "versioning.review.opened", r)
    c.audit_after = {"reviewId": r["id"], "source": source, "target": target, "source_oid": r.get("source_oid")}
    return 201, _enrich_review(c, r)


def op_reviews(c: Call, body: dict) -> tuple[int, dict]:
    page = client().list_reviews(c.token(), c.repo_id, body.get("status"), body.get("cursor"), int(body.get("limit") or 50))
    return 200, {**page, "items": [_enrich_review(c, r) for r in page.get("items") or []]}


def op_review_get(c: Call, body: dict) -> tuple[int, dict]:
    return 200, _enrich_review(c, client().get_review(c.token(), c.repo_id, str(body["review_id"])))


def op_review_approve(c: Call, body: dict) -> tuple[int, dict]:
    rid = str(body["review_id"])
    source = body.get("source_oid") or client().get_review(c.token(), c.repo_id, rid)["source_oid"]
    r = client().approve_review(c.token(), c.repo_id, rid, {"source_oid": source})
    c.audit_after = {"reviewId": rid, "source_oid": source}
    return 200, _enrich_review(c, r)


def op_review_resolve(c: Call, body: dict) -> tuple[int, dict]:
    rid = str(body["review_id"])
    token = c.token()
    cur = client().get_review(token, c.repo_id, rid)
    source, target = body.get("source_oid") or cur["source_oid"], body.get("target_oid") or cur.get("checked_target_oid")
    out = []
    _, tm = _load_manifest(c, str(target), token) if any((x.get("choice") == "custom" and x.get("annotation")) for x in body.get("resolutions") or []) else (None, None)
    for x in body.get("resolutions") or []:
        res: dict[str, Any] = {"conflict_key": str(x["conflict_key"]), "choice": str(x["choice"])}
        if res["choice"] == "custom":
            if x.get("annotation"):
                m = json.loads(json.dumps(tm))
                res["custom"] = _studio_entries(c, token, m, [x["annotation"]])[0]
            else:
                res["custom"] = x.get("custom") or {}
        out.append(res)
    r = client().resolve_conflicts(token, c.repo_id, rid, {"source_oid": source, "target_oid": target, "resolutions": out})
    c.audit_after = {"reviewId": rid, "keys": [x["conflict_key"] for x in out]}
    return 200, _enrich_review(c, r)


def op_review_check(c: Call, body: dict) -> tuple[int, dict]:
    rid, name = str(body["review_id"]), str(body.get("name") or DEID_CHECK)
    req = {"source_oid": str(body["source_oid"]), "target_oid": str(body["target_oid"]), "outcome": str(body["outcome"]), "details": body.get("details") or {}}
    r = client().report_check(c.token(), c.repo_id, rid, name, req)
    c.audit_after = {"reviewId": rid, "check": name, "outcome": req["outcome"]}
    return 200, _enrich_review(c, r)


def op_merge(c: Call, body: dict) -> tuple[int, dict]:
    rid = str(body["review_id"])
    req = {"idempotency_key": _idem(c, body, rid), **({"message": str(body["message"])[:2000]} if body.get("message") else {})}
    try:
        r = client().merge_review(c.token(), c.repo_id, rid, req)
    except VersioningProblem as e:
        if e.code == "stale_head":  # the target moved: the review is back in CHECKING
            try:
                _announce_checks(c, review=client().get_review(c.token(), c.repo_id, rid))
            except VersioningProblem:
                pass
        raise
    c.audit_after = {"reviewId": rid, "merge_oid": r.get("merge_oid"), "target": r.get("target_branch")}
    _announce_checks(c, branch=r.get("target_branch"))
    return 200, _enrich_review(c, r)


def op_release(c: Call, body: dict) -> tuple[int, dict]:
    tag = str(body["tag"])
    oid = body.get("commit_oid") or _resolve(c, str(body.get("ref") or "main"))
    req = {"tag": tag, "commit_oid": oid, **({"retention_policy": body["retention_policy"]} if body.get("retention_policy") else {})}
    r = client().create_release(c.token(), c.repo_id, req, _key("release", c.repo_id, tag, oid))
    # The release pins the Studio setup of its commit (todo10 §3.2): say what it pinned, and
    # whether that is what the Studio runs now.
    pinned = _studio_at(c, oid)
    r["studio"] = _studio_summary(pinned)
    if not pinned["files"]:
        r["studioWarning"] = "this commit carries no Studio setup; request a review from the Studio first so main has one"
    elif _studio_summary({"files": studio_defs.studio_files(c.db, c.ctx, c.dataset_id)})["fingerprint"] != r["studio"]["fingerprint"]:
        r["studioWarning"] = "the Studio has changed since this commit; the release pins the setup at the commit"
    c.audit_after = {"tag": tag, "commit_oid": oid, "studio_tree": pinned.get("studio_tree"), "lockfileHash": r["studio"].get("lockfileHash")}
    return 201, r


def op_releases(c: Call, body: dict) -> tuple[int, dict]:
    return 200, {"items": client().list_releases(c.token(), c.repo_id)}


def op_checkout(c: Call, body: dict) -> tuple[int, dict]:
    req = {"ref": str(body.get("ref") or "main"), "include_urls": bool(body.get("include_urls", True))}
    for k in ("filter", "cursor", "limit"):
        if body.get(k) is not None:
            req[k] = body[k]
    page = client().create_checkout(c.token(), c.repo_id, req)
    c.audit_after = {"ref": req["ref"], "commit_oid": page.get("commit_oid"), "samples": len(page.get("samples") or [])}
    return 200, page


HANDLERS: dict[str, Callable[[Call, dict], tuple[int, dict]]] = {
    "dataset.create": op_dataset_create,
    "dataset.get": op_dataset_get,
    "branch": op_branch,
    "branches": op_branches,
    "artifact": op_artifact,
    "commit": op_commit,
    "commits": op_commits,
    "commit.get": op_commit_get,
    "revert": op_revert,
    "diff": op_diff,
    "document": op_document,
    "review.open": op_review_open,
    "reviews": op_reviews,
    "review.get": op_review_get,
    "review.approve": op_review_approve,
    "review.resolve": op_review_resolve,
    "review.check": op_review_check,
    "merge": op_merge,
    "release": op_release,
    "releases": op_releases,
    "checkout": op_checkout,
    "studio": op_studio,
    "studio.commit": op_studio_commit,
}
assert set(HANDLERS) == set(OPS)

# Audited reads would flood the log; writes and checkouts (data leaves) are always audited.
_UNAUDITED = {"dataset.get", "branches", "commits", "commit.get", "diff", "reviews", "review.get", "releases", "studio"}


def _agent_branch(c: Call, branch: str) -> None:
    if auth.is_agent(c.ctx) and OPS[c.op].agent_branch and not branch.startswith(AGENT_BRANCH_PREFIX):
        raise problem(403, "forbidden", f"agents may only write to {AGENT_BRANCH_PREFIX}* branches, not {branch!r}")


def run(db: Session, ctx: RequestContext, op: str, dataset_id: str, body: dict | None = None) -> tuple[int, dict]:
    """Run one operation; returns (status, body). Problems come back as (status, problem body)
    rather than exceptions, so the audit entry recording a denial is committed too."""
    spec = OPS[op]
    c = Call(db, ctx, dataset_id, op)
    body = body or {}
    target = f"dataset:{dataset_id}"
    try:
        if not ctx.allows(spec.scope):
            raise problem(403, "forbidden", f"this session lacks {spec.scope}")
        if auth.is_agent(ctx) and not spec.agent:
            raise problem(403, "forbidden", f"agents can't {op.replace('.', ' ')}: a person has to (spec §16C)")
        if op != "dataset.create":
            c.repo_id = _repo(c)
        status, out = HANDLERS[op](c, body)
    except KeyError as e:
        return 422, problem(422, "bad_request", f"missing field {e.args[0]!r}").body
    except VersioningProblem as e:
        audit.record(db, ctx, "versioning.denied" if e.status in (401, 403) else "versioning.failed", target=target, after={"op": op, "status": e.status, "code": e.code})
        return e.status, e.body
    if op not in _UNAUDITED:
        audit.record(db, ctx, f"versioning.{op}", target=target, after=c.audit_after or None)
    return status, out


def command(db: Session, ctx: RequestContext, command_id: str, payload: dict) -> tuple[int, dict]:
    """A kernel command (`<ns>.versioning.*`) through the gateway. `input.dataset` names the
    dataset; the rest is the operation's body (the same as its HTTP route)."""
    op = COMMANDS[command_id]
    dataset = payload.get("dataset") or payload.get("dataset_id")
    if not isinstance(dataset, str) or not dataset:
        return 422, {"type": "about:blank", "title": "bad request", "status": 422, "code": "bad_request", "detail": "input.dataset is required"}
    status, out = run(db, ctx, op, dataset, {k: v for k, v in payload.items() if k not in ("dataset", "dataset_id")})
    if status >= 400:
        return status, out
    return status, {"command": command_id, "result": out}
