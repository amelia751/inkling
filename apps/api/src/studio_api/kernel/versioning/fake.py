"""An in-memory stand-in for apps/versioning (tests, and `<envPrefix>API_VERSIONING_URL=memory:`
for trying the Studio's versioned save flow without Go, Postgres and object storage).

It follows the service's contract closely enough for the kernel's tests: the same JSON
shapes, problem codes (`stale_head`, `protected_branch`, `self_approval`, `not_ready`…), CAS
on branch heads, a protected `main`, review states with a pending external
`deidentification` check, three-way annotation conflicts and resolutions. It verifies the
minted JWT's scopes and actor the way the service does (but not its signature).
It keeps the Studio definition (`.studio/`, todo10 Phase 2) the same way: a commit's
`studio.files` replace the tree (RFC 8785 canonical JSON only), no `studio` keeps the
parent's, a revert restores the target's, a merge takes the changed side, a release pins it.
Not implemented: chunked manifests, field-level merges, GC, purge, legal holds.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import uuid
from datetime import UTC, datetime

from ..canonical import canonicalize
from .auth import decode_unverified
from .client import VersioningProblem, problem

STUDIO_PATH = re.compile(r"^(plugins\.lock\.json|structure\.json|rules\.json|tasks/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/(environment\.json|README\.md))$")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _canon(v) -> bytes:
    return json.dumps(v, sort_keys=True, separators=(",", ":")).encode()


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class FakeVersioning:
    MANDATORY = ["merge_base", "referential_integrity", "artifact_checksum", "schema_compatibility", "geometry_validity", "deidentification"]

    def __init__(self):
        self.lock = threading.RLock()
        self.repos: dict[str, dict] = {}
        self.blobs: dict[str, tuple[bytes, str]] = {}
        self.manifests: dict[str, dict] = {}
        self.calls: list[tuple[str, dict]] = []  # (method, claims) for assertions
        self.idem: dict[tuple, dict] = {}
        self.studio_trees: dict[str, dict[str, str]] = {}

    # ---- plumbing ----------------------------------------------------------------------

    def _auth(self, method: str, token: str, scope: str) -> dict:
        claims = decode_unverified(token)
        self.calls.append((method, claims))
        if scope not in claims.get("scopes", []):
            raise problem(403, "forbidden", f"missing scope {scope}")
        a = claims.get("actor") or {}
        if a.get("kind") == "agent" and not a.get("on_behalf_of"):
            raise problem(401, "unauthenticated", "agent actors must carry on_behalf_of")
        return claims

    def _repo(self, claims: dict, repo_id: str) -> dict:
        r = self.repos.get(repo_id)
        if r is None or r["tenant_id"] != claims["tenant_id"] or r["project_id"] != claims["project_id"]:
            raise problem(404, "not_found", "repository not found")
        return r

    def _write_manifest(self, m: dict) -> str:
        root = "sha256:" + _sha(_canon(m))
        self.manifests[root] = json.loads(json.dumps(m))
        return root

    def _commit_obj(self, r: dict, root: str, parents: list[str], author: dict, message: str, op: str, studio: str | None = None) -> str:
        oid = hashlib.sha1(_canon([root, parents, author.get("id"), message, uuid.uuid4().hex])).hexdigest()
        m = self.manifests[root]
        r["commits"][oid] = {"oid": oid, "parents": parents, "manifest_root": root, "manifest_format": "json-v1", "sample_count": len(m["samples"]), "annotation_count": len(m["annotations"]), "author_id": author.get("id"), "on_behalf_of": author.get("on_behalf_of"), "message": message, "operation": op, "created_at": _now()}
        if studio:
            r["commits"][oid]["studio_tree"] = studio
        return oid

    def _studio(self, r: dict, oid: str | None) -> str | None:
        return r["commits"][oid].get("studio_tree") if oid in r["commits"] else None

    def _studio_tree(self, files: dict) -> str | None:
        if not isinstance(files, dict):
            raise problem(400, "bad_request", "studio.files must be an object")
        for path, text in files.items():
            if not STUDIO_PATH.fullmatch(path) or ".." in path or not isinstance(text, str):
                raise problem(400, "bad_request", f"{path!r} isn't a .studio path")
            if path.endswith(".json"):
                try:
                    ok = canonicalize(json.loads(text)) == text
                except ValueError:
                    raise problem(400, "bad_request", f"{path} isn't JSON") from None
                if not ok:
                    raise problem(400, "not_canonical", f"{path} must be RFC 8785 canonical JSON")
        if not files:
            return None
        oid = hashlib.sha1(_canon(files)).hexdigest()
        self.studio_trees[oid] = dict(files)
        return oid

    def get_studio(self, token, repo_id, ref):
        with self.lock:
            r = self._repo(self._auth("get_studio", token, "versioning:read"), repo_id)
            if ref.startswith("tag:") and ref[4:] not in r["releases"]:
                raise problem(404, "not_found", "release not found")
            oid = self._resolve(r, ref)
            tree = self._studio(r, oid)
            return {"commit_oid": oid, **({"studio_tree": tree} if tree else {}), "files": dict(self.studio_trees.get(tree, {})) if tree else {}}

    def _branch(self, r: dict, name: str) -> dict:
        b = r["branches"].get(name)
        if b is None:
            raise problem(404, "not_found", "branch not found")
        return b

    def _resolve(self, r: dict, ref: str) -> str:
        if ref in r["commits"]:
            return ref
        if ref.startswith("tag:") and ref[4:] in r["releases"]:
            return r["releases"][ref[4:]]["commit_oid"]
        return self._branch(r, ref)["commit_oid"]

    def _ancestors(self, r: dict, oid: str) -> list[str]:
        out, todo, seen = [], [oid], set()
        while todo:
            o = todo.pop(0)
            if o in seen:
                continue
            seen.add(o)
            out.append(o)
            todo += r["commits"][o]["parents"]
        return out

    def _merge_base(self, r: dict, a: str, b: str) -> str:
        anc = set(self._ancestors(r, a))
        return next(o for o in self._ancestors(r, b) if o in anc)

    def _manifest_of(self, r: dict, oid: str) -> dict:
        return self.manifests[r["commits"][oid]["manifest_root"]]

    def _advance(self, r: dict, name: str, expected: str, oid: str) -> dict:
        b = self._branch(r, name)
        if b["commit_oid"] != expected:
            raise VersioningProblem(409, {"title": "stale head", "code": "stale_head", "detail": "the branch moved", "current_head": b["commit_oid"], "head_generation": b["generation"]})
        b["commit_oid"], b["generation"], b["updated_at"] = oid, b["generation"] + 1, _now()
        for rv in r["reviews"].values():
            if rv["status"] in ("MERGED", "CLOSED", "MERGING", "DRAFT"):
                continue
            src, tgt = rv["source_oid"], rv.get("checked_target_oid")
            if rv["source_branch"] == name:
                src = oid
            if rv["target_branch"] == name:
                tgt = oid
            if (src, tgt) != (rv["source_oid"], rv.get("checked_target_oid")):
                self._start_checks(r, rv, src, tgt)
        return b

    # ---- reviews -----------------------------------------------------------------------

    def _plan(self, r: dict, target: str, source: str) -> tuple[dict, list[dict], str]:
        base_oid = self._merge_base(r, target, source)
        base, ours, theirs = (self._manifest_of(r, o) for o in (base_oid, target, source))
        idx = lambda m: {a["annotation_id"]: a for a in m["annotations"]}  # noqa: E731
        B, O, T = idx(base), idx(ours), idx(theirs)
        merged, conflicts = {}, []
        for k in set(B) | set(O) | set(T):
            b, o, t = B.get(k), O.get(k), T.get(k)
            ref = lambda x: x and x["ref"]  # noqa: E731
            if ref(o) == ref(t):
                pick = o
            elif ref(o) == ref(b):
                pick = t
            elif ref(t) == ref(b):
                pick = o
            else:
                conflicts.append({"conflict_key": f"annotation:{k}", "kind": "both_modified" if o and t else "modify_delete", "annotation_id": k, "sample_id": (o or t or {})["sample_id"], "base_ref": ref(b), "ours_ref": ref(o), "theirs_ref": ref(t)})
                pick = o
            if pick:
                merged[k] = pick
        samples = {s["sample_id"]: s for s in ours["samples"]} | {s["sample_id"]: s for s in theirs["samples"]}
        classes = {c["class_id"]: c for c in ours["ontology"]["classes"]} | {c["class_id"]: c for c in theirs["ontology"]["classes"]}
        ontology = {**theirs["ontology"], "classes": list(classes.values())}
        return {"schema_version": "1", "ontology": ontology, "samples": list(samples.values()), "annotations": list(merged.values())}, conflicts, base_oid

    def _start_checks(self, r: dict, rv: dict, source: str, target: str) -> None:
        rv.update(source_oid=source, checked_target_oid=target, status="CHECKING", updated_at=_now(), version=rv["version"] + 1)
        rv["approvals"] = [a for a in rv["approvals"] if a["approved_source_oid"] == source]
        _, conflicts, base = self._plan(r, target, source)
        rv["base_oid"] = base
        old = {c["conflict_key"]: c.get("resolution") for c in rv.get("conflicts") or []} if rv.get("_pair") == (source, target) else {}
        rv["conflicts"] = [{**c, **({"resolution": old[c["conflict_key"]]} if old.get(c["conflict_key"]) else {})} for c in conflicts]
        rv["_pair"] = (source, target)
        rv["checks"] = [{"name": n, "mandatory": True, "outcome": "pending" if n == "deidentification" else "passed", "source_oid": source, "target_oid": target} for n in self.MANDATORY]
        self._evaluate(rv)

    def _evaluate(self, rv: dict) -> None:
        if rv["status"] != "CHECKING":
            return
        outs = {c["name"]: c["outcome"] for c in rv["checks"]}
        if any(outs.get(n) in (None, "pending") for n in self.MANDATORY):
            return
        if any(outs[n] != "passed" for n in self.MANDATORY):
            rv["status"] = "BLOCKED"
        elif any(not c.get("resolution") for c in rv["conflicts"]):
            rv["status"] = "CONFLICTED"
        else:
            rv["status"] = "READY"

    def _view(self, rv: dict) -> dict:
        return json.loads(json.dumps({k: v for k, v in rv.items() if not k.startswith("_")}))

    # ---- API -----------------------------------------------------------------------------

    def ready(self) -> bool:
        return True

    def create_repo(self, token, body, idempotency_key):
        with self.lock:
            c = self._auth("create_repo", token, "versioning:admin")
            key = ("repo", c["project_id"], idempotency_key)
            if key in self.idem:
                return self.idem[key]
            rid = str(uuid.uuid4())
            r = {"id": rid, "tenant_id": c["tenant_id"], "project_id": c["project_id"], "name": body["name"], "default_branch": "main", "policy_id": body.get("policy_id", "default"), "object_format": "sha1", "required_approvals": max(1, int(body.get("required_approvals", 1))), "created_at": _now(), "commits": {}, "branches": {}, "reviews": {}, "releases": {}}
            self.repos[rid] = r
            root = self._write_manifest({"schema_version": "1", "ontology": {"revision_id": "empty", "classes": []}, "samples": [], "annotations": []})
            oid = self._commit_obj(r, root, [], c["actor"], "Initialize dataset repository", "init")
            r["branches"]["main"] = {"name": "main", "commit_oid": oid, "generation": 1, "protected": True, "updated_at": _now()}
            out = {**{k: r[k] for k in ("id", "tenant_id", "project_id", "name", "default_branch", "policy_id", "object_format", "created_at")}, "head": oid, "head_generation": 1}
            self.idem[key] = out
            return out

    def get_repo(self, token, repo_id):
        with self.lock:
            r = self._repo(self._auth("get_repo", token, "versioning:read"), repo_id)
            b = r["branches"]["main"]
            return {**{k: r[k] for k in ("id", "tenant_id", "project_id", "name", "default_branch", "policy_id", "object_format", "created_at", "required_approvals")}, "head": b["commit_oid"], "head_generation": b["generation"]}

    def create_branch(self, token, repo_id, body, idempotency_key):
        with self.lock:
            c = self._auth("create_branch", token, "versioning:write")
            r = self._repo(c, repo_id)
            if c["actor"]["kind"] == "agent" and not body["name"].startswith("work/agent-"):
                raise problem(403, "forbidden", "agents may only create work/agent-* branches")
            if body["name"] in r["branches"]:
                raise problem(409, "conflict", "branch already exists")
            oid = self._resolve(r, body["from"])
            b = {"name": body["name"], "commit_oid": oid, "generation": 1, "protected": bool(body.get("protected")), "updated_at": _now()}
            r["branches"][body["name"]] = b
            return dict(b)

    def list_branches(self, token, repo_id, cursor=None, limit=100):
        with self.lock:
            r = self._repo(self._auth("list_branches", token, "versioning:read"), repo_id)
            return {"items": [dict(b) for b in sorted(r["branches"].values(), key=lambda b: b["name"])]}

    def put_artifact(self, token, sha256, data, media_type):
        with self.lock:
            self._auth("put_artifact", token, "versioning:write")
            if _sha(data) != sha256:
                raise problem(422, "validation_failed", "hash mismatch")
            existed = sha256 in self.blobs
            self.blobs[sha256] = (data, media_type)
            return {"sha256": sha256, "size_bytes": len(data), "media_type": media_type, "status": "available" if existed else "staged"}

    def put_annotation_revision(self, token, body):
        with self.lock:
            self._auth("put_annotation_revision", token, "versioning:write")
            for k in ("annotation_id", "sample_id", "kind", "class_id", "geometry"):
                if k not in body:
                    raise problem(422, "validation_failed", f"{k} is required")
            b = _canon(body)
            self.blobs[_sha(b)] = (b, "application/vnd.annotation-revision+json")
            return {"ref": "sha256:" + _sha(b)}

    def put_manifest(self, token, repo_id, manifest):
        with self.lock:
            self._repo(self._auth("put_manifest", token, "versioning:write"), repo_id)
            sids = {s["sample_id"] for s in manifest["samples"]}
            probs = [f"annotations[{a['annotation_id']}].sample_id references unknown sample" for a in manifest["annotations"] if a["sample_id"] not in sids]
            probs += [f"artifact not registered for tenant: {o['sha256']}" for s in manifest["samples"] for o in s["objects"] if o["sha256"] not in self.blobs]
            if probs:
                raise VersioningProblem(422, {"title": "validation failed", "code": "validation_failed", "detail": probs[0], "problems": probs})
            root = self._write_manifest(manifest)
            return {"manifest_root": root, "format": "json-v1", "sample_count": len(manifest["samples"]), "annotation_count": len(manifest["annotations"])}

    def create_commit(self, token, repo_id, body):
        with self.lock:
            c = self._auth("create_commit", token, "versioning:write")
            r = self._repo(c, repo_id)
            key = ("commit", repo_id, body["branch"], body["idempotency_key"])
            if key in self.idem:
                return self.idem[key]
            if c["actor"]["kind"] == "agent" and not body["branch"].startswith("work/agent-"):
                raise problem(403, "forbidden", "agents may only commit to work/agent-* branches")
            b = self._branch(r, body["branch"])
            if b["protected"]:
                raise problem(403, "protected_branch", f"{body['branch']} is protected; changes reach it only through a merged review")
            if body["manifest_root"] not in self.manifests:
                raise problem(422, "validation_failed", "manifest root is not registered for this repository")
            if b["commit_oid"] != body["expected_head"]:
                raise VersioningProblem(409, {"title": "stale head", "code": "stale_head", "detail": "the branch moved", "current_head": b["commit_oid"], "head_generation": b["generation"]})
            studio = self._studio_tree((body["studio"] or {}).get("files") or {}) if body.get("studio") is not None else self._studio(r, body["expected_head"])
            oid = self._commit_obj(r, body["manifest_root"], [body["expected_head"]], c["actor"], body.get("message", ""), "commit", studio)
            nb = self._advance(r, body["branch"], body["expected_head"], oid)
            out = {"commit_oid": oid, "branch": body["branch"], "head_generation": nb["generation"], "manifest_root": body["manifest_root"], **({"studio_tree": studio} if studio else {}), "request_id": c.get("request_id", "")}
            self.idem[key] = out
            return out

    def list_commits(self, token, repo_id, ref, cursor=None, limit=100):
        with self.lock:
            r = self._repo(self._auth("list_commits", token, "versioning:read"), repo_id)
            return {"items": [dict(r["commits"][o]) for o in self._ancestors(r, self._resolve(r, ref))][:limit]}

    def get_commit(self, token, repo_id, oid):
        with self.lock:
            r = self._repo(self._auth("get_commit", token, "versioning:read"), repo_id)
            if oid not in r["commits"]:
                raise problem(404, "not_found", "commit not found")
            return dict(r["commits"][oid])

    def revert(self, token, repo_id, body):
        with self.lock:
            c = self._auth("revert", token, "versioning:write")
            r = self._repo(c, repo_id)
            if self._branch(r, body["branch"])["protected"]:
                raise problem(403, "protected_branch", "protected")
            root = r["commits"][body["target_oid"]]["manifest_root"]
            studio = self._studio(r, body["target_oid"])  # restoring a version restores its Studio setup
            self._advance(r, body["branch"], body["expected_head"], oid := self._commit_obj(r, root, [body["expected_head"]], c["actor"], body.get("message", ""), "revert", studio))
            return {"commit_oid": oid, "branch": body["branch"], "head_generation": r["branches"][body["branch"]]["generation"], "manifest_root": root, **({"studio_tree": studio} if studio else {}), "request_id": ""}

    def get_diff(self, token, repo_id, base, head, cursor=None, limit=100):
        with self.lock:
            r = self._repo(self._auth("get_diff", token, "versioning:read"), repo_id)
            bm, hm = self._manifest_of(r, base), self._manifest_of(r, head)
            changes = []
            bs, hs = {s["sample_id"] for s in bm["samples"]}, {s["sample_id"] for s in hm["samples"]}
            changes += [{"type": "sample.added", "sample_id": s} for s in sorted(hs - bs)]
            changes += [{"type": "sample.removed", "sample_id": s} for s in sorted(bs - hs)]
            B, H = ({a["annotation_id"]: a for a in m["annotations"]} for m in (bm, hm))
            for k in sorted(set(B) | set(H)):
                b, h = B.get(k), H.get(k)
                if b and not h:
                    changes.append({"type": "annotation.removed", "annotation_id": k, "sample_id": b["sample_id"], "class_id": b["class_id"], "kind": b["kind"], "base_ref": b["ref"]})
                elif h and not b:
                    changes.append({"type": "annotation.added", "annotation_id": k, "sample_id": h["sample_id"], "class_id": h["class_id"], "kind": h["kind"], "head_ref": h["ref"]})
                elif b and h and b["ref"] != h["ref"]:
                    changes.append({"type": "annotation.changed", "annotation_id": k, "sample_id": h["sample_id"], "class_id": h["class_id"], "kind": h["kind"], "fields": ["geometry"], "base_ref": b["ref"], "head_ref": h["ref"]})
            summary: dict[str, int] = {}
            for ch in changes:
                summary[ch["type"]] = summary.get(ch["type"], 0) + 1
            return {"base": base, "head": head, "base_root": r["commits"][base]["manifest_root"], "head_root": r["commits"][head]["manifest_root"], "summary": summary, "aggregates": {"base": {"samples": len(bs), "annotations": len(B)}, "head": {"samples": len(hs), "annotations": len(H)}}, "changes": changes}

    def create_review(self, token, repo_id, body, idempotency_key):
        with self.lock:
            c = self._auth("create_review", token, "versioning:review")
            r = self._repo(c, repo_id)
            src, tgt = self._branch(r, body["source_branch"]), self._branch(r, body["target_branch"])
            rid = str(uuid.uuid4())
            rv = {"id": rid, "repo_id": repo_id, "title": body["title"], "description": body.get("description", ""), "author_id": c["actor"]["id"], "author_on_behalf_of": c["actor"].get("on_behalf_of"), "source_branch": body["source_branch"], "source_oid": src["commit_oid"], "target_branch": body["target_branch"], "status": "OPEN", "required_approvals": r["required_approvals"], "version": 1, "created_at": _now(), "updated_at": _now(), "approvals": [], "checks": [], "conflicts": []}
            r["reviews"][rid] = rv
            self._start_checks(r, rv, src["commit_oid"], tgt["commit_oid"])
            return self._view(rv)

    def list_reviews(self, token, repo_id, status=None, cursor=None, limit=100):
        with self.lock:
            r = self._repo(self._auth("list_reviews", token, "versioning:read"), repo_id)
            return {"items": [self._view(v) for v in r["reviews"].values() if not status or v["status"] == status]}

    def get_review(self, token, repo_id, review_id):
        with self.lock:
            r = self._repo(self._auth("get_review", token, "versioning:read"), repo_id)
            if review_id not in r["reviews"]:
                raise problem(404, "not_found", "review not found")
            return self._view(r["reviews"][review_id])

    def approve_review(self, token, repo_id, review_id, body):
        with self.lock:
            c = self._auth("approve_review", token, "versioning:approve")
            r = self._repo(c, repo_id)
            rv = r["reviews"][review_id]
            a = c["actor"]
            if a["kind"] == "agent":
                raise problem(403, "self_approval", "agent actors cannot approve or merge reviews")
            if a["id"] in (rv["author_id"], rv.get("author_on_behalf_of")):
                raise problem(403, "self_approval", "authors cannot approve their own review")
            if body["source_oid"] != rv["source_oid"]:
                raise VersioningProblem(409, {"title": "stale head", "code": "stale_head", "detail": "the source changed since you reviewed it", "current_head": rv["source_oid"]})
            target = rv.get("checked_target_oid") or self._branch(r, rv["target_branch"])["commit_oid"]
            # Stable per (reviewer, source, target), like the service: the pipeline's PublishWorkflow id.
            aid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"approval:{review_id}:{a['id']}:{body['source_oid']}:{target}"))
            if not any(x["id"] == aid for x in rv["approvals"]):
                entry = {"id": aid, "reviewer_id": a["id"], "approved_source_oid": body["source_oid"], "approved_target_oid": target, "created_at": _now()}
                if body.get("candidate_digest"):
                    entry["candidate_digest"] = body["candidate_digest"]
                rv["approvals"].append(entry)
            return self._view(rv)

    def resolve_conflicts(self, token, repo_id, review_id, body):
        with self.lock:
            c = self._auth("resolve_conflicts", token, "versioning:review")
            r = self._repo(c, repo_id)
            rv = r["reviews"][review_id]
            if (body["source_oid"], body["target_oid"]) != (rv["source_oid"], rv.get("checked_target_oid")):
                raise VersioningProblem(409, {"title": "stale head", "code": "stale_head", "detail": "resolutions are for superseded oids", "current_head": rv["source_oid"]})
            keys = {cf["conflict_key"]: cf for cf in rv["conflicts"]}
            for x in body["resolutions"]:
                if x["conflict_key"] not in keys:
                    raise problem(422, "validation_failed", f"unknown conflict key {x['conflict_key']}")
                keys[x["conflict_key"]]["resolution"] = x
            if rv["status"] == "CONFLICTED" and all(cf.get("resolution") for cf in rv["conflicts"]):
                rv["status"] = "CHECKING"
                self._evaluate(rv)
            return self._view(rv)

    def report_check(self, token, repo_id, review_id, name, body):
        with self.lock:
            c = self._auth("report_check", token, "versioning:checks")
            r = self._repo(c, repo_id)
            rv = r["reviews"][review_id]
            if name != "deidentification":
                raise problem(400, "bad_request", f"{name} is computed by the service, not reported")
            if (body["source_oid"], body["target_oid"]) != (rv["source_oid"], rv.get("checked_target_oid")):
                raise VersioningProblem(409, {"title": "stale head", "code": "stale_head", "detail": "result is for superseded oids", "current_head": rv["source_oid"]})
            for ch in rv["checks"]:
                if ch["name"] == name:
                    ch.update(outcome=body["outcome"], details=body.get("details") or {})
            self._evaluate(rv)
            return self._view(rv)

    def merge_review(self, token, repo_id, review_id, body):
        with self.lock:
            c = self._auth("merge_review", token, "versioning:merge")
            r = self._repo(c, repo_id)
            if c["actor"]["kind"] == "agent":
                raise problem(403, "forbidden", "agent actors cannot approve or merge reviews")
            rv = r["reviews"][review_id]
            if rv["status"] == "MERGED":
                return self._view(rv)
            if rv["status"] != "READY":
                raise problem(409, "not_ready", f"review is {rv['status']}, not READY")
            n = sum(1 for a in rv["approvals"] if a["approved_source_oid"] == rv["source_oid"])
            if n < rv["required_approvals"]:
                raise problem(409, "not_ready", f"{n} of {rv['required_approvals']} required approvals on the current source")
            tgt = self._branch(r, rv["target_branch"])
            if tgt["commit_oid"] != rv["checked_target_oid"]:
                self._start_checks(r, rv, rv["source_oid"], tgt["commit_oid"])
                raise VersioningProblem(409, {"title": "stale head", "code": "stale_head", "detail": "the target moved", "current_head": tgt["commit_oid"]})
            merged, conflicts, _ = self._plan(r, rv["checked_target_oid"], rv["source_oid"])
            res = {cf["conflict_key"]: cf.get("resolution") or {} for cf in rv["conflicts"]}
            by = {a["annotation_id"]: a for a in merged["annotations"]}
            T = {a["annotation_id"]: a for a in self._manifest_of(r, rv["source_oid"])["annotations"]}
            for cf in conflicts:
                x, aid = res.get(cf["conflict_key"]) or {}, cf["annotation_id"]
                if x.get("choice") == "theirs":
                    if aid in T:
                        by[aid] = T[aid]
                    else:
                        by.pop(aid, None)
                elif x.get("choice") == "custom":
                    by[aid] = x["custom"]
            merged["annotations"] = list(by.values())
            root = self._write_manifest(merged)
            base, tgt_s, src_s = (self._studio(r, o) for o in (self._merge_base(r, rv["checked_target_oid"], rv["source_oid"]), rv["checked_target_oid"], rv["source_oid"]))
            oid = self._commit_obj(r, root, [rv["checked_target_oid"], rv["source_oid"]], c["actor"], body.get("message") or f"Merge {rv['source_branch']}", "merge", tgt_s if src_s == base else src_s)
            rv["status"], rv["merge_oid"] = "MERGING", oid
            self._advance(r, rv["target_branch"], rv["checked_target_oid"], oid)
            rv["status"] = "MERGED"
            return self._view(rv)

    def create_release(self, token, repo_id, body, idempotency_key):
        with self.lock:
            c = self._auth("create_release", token, "versioning:release")
            r = self._repo(c, repo_id)
            if body["tag"] in r["releases"]:
                if r["releases"][body["tag"]]["commit_oid"] == body["commit_oid"]:
                    return dict(r["releases"][body["tag"]])
                raise problem(409, "conflict", "tag exists")
            rel = {"tag": body["tag"], "commit_oid": body["commit_oid"], "manifest_root": r["commits"][body["commit_oid"]]["manifest_root"], "created_by": c["actor"]["id"], "created_at": _now(), "retention_policy": body.get("retention_policy", "standard"), "attestations": []}
            if self._studio(r, body["commit_oid"]):
                rel["studio_tree"] = self._studio(r, body["commit_oid"])
            r["releases"][body["tag"]] = rel
            return dict(rel)

    def list_releases(self, token, repo_id):
        with self.lock:
            r = self._repo(self._auth("list_releases", token, "versioning:read"), repo_id)
            return [dict(x) for x in r["releases"].values()]

    def create_checkout(self, token, repo_id, body):
        with self.lock:
            r = self._repo(self._auth("create_checkout", token, "versioning:checkout"), repo_id)
            oid = self._resolve(r, body["ref"])
            m = self._manifest_of(r, oid)
            want = set((body.get("filter") or {}).get("sample_ids") or [])
            samples = [s for s in m["samples"] if not want or s["sample_id"] in want]
            keep = {s["sample_id"] for s in samples}
            anns = [a for a in m["annotations"] if a["sample_id"] in keep]
            hashes = [o["sha256"] for s in samples for o in s["objects"]] + [a["ref"].split(":", 1)[1] for a in anns]
            objs = [{"sha256": h, "size_bytes": len(self.blobs[h][0]) if h in self.blobs else 0, "status": "available" if h in self.blobs else "missing", **({"url": f"memory://{h}"} if body.get("include_urls", True) and h in self.blobs else {})} for h in hashes]
            return {"commit_oid": oid, "manifest_root": r["commits"][oid]["manifest_root"], "ontology": m["ontology"], "samples": samples, "annotations": anns, "objects": objs, "expires_at": _now(), "buckets_read": 1}

    def fetch(self, url: str) -> bytes:
        return self.blobs[url.removeprefix("memory://")][0]
