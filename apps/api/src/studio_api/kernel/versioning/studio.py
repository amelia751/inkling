"""Studio annotations ↔ versioning annotation revisions (schemas/versioning/annotation-revision).

A revision carries what the semantic diff and merge need: kind, class, geometry in the
service's vocabulary, and an `attributes.studio_hash` of the whole Studio annotation, so any
edit (attributes, provenance, locked…) is a change the service sees and can conflict on.
The full Studio annotation is kept by the kernel per revision ref
(`VersionedAnnotationPayload`), so a branch loads back into the Studio losslessly.

Items become samples. A sample id must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`, so item
paths map `/` → `:` and anything else outside the alphabet → `-`. A sample created for a
Studio item references a small pointer artifact (the workspace asset path), not the bytes:
uploading the media itself goes through `POST /api/v1/datasets/{id}/artifacts`.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

SCHEMA_VERSION = "1"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
POINTER_MEDIA_TYPE = "application/json"
POINTER_ROLE = "asset-ref"


def canonical_json(v: Any) -> bytes:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def safe_id(s: str, prefix: str = "x") -> str:
    """A string → an id the service accepts (stable, so the same input always maps the same)."""
    out = re.sub(r"[^A-Za-z0-9._:-]", "-", s.replace("/", ":"))
    if not out or not out[0].isalnum():
        out = f"{prefix}{out}"
    if len(out) > 128:
        out = out[:111] + "-" + hashlib.sha256(s.encode()).hexdigest()[:16]
    return out


def sample_id(item_id: str) -> str:
    return safe_id(item_id, "s")


def class_id(label: str) -> str:
    return safe_id(label or "unlabeled", "c")


def pointer(workspace_id: str, item_id: str) -> bytes:
    return canonical_json({"kind": "workspace-asset", "workspace": workspace_id, "item": item_id})


def studio_hash(a: dict) -> str:
    return hashlib.sha256(canonical_json(a)).hexdigest()[:32]


def _pts(points: Any) -> list[list[float]]:
    out = []
    for p in points or []:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            out.append([float(p[0]), float(p[1])])
        elif isinstance(p, dict) and "x" in p and "y" in p:
            out.append([float(p["x"]), float(p["y"])])
    return out


def kind_and_geometry(g: dict) -> tuple[str, dict]:
    """The service's (kind, geometry) for a Studio geometry. Types without a service
    equivalent become a `measurement` anchored at a representative point."""
    t = (g or {}).get("type")
    if t == "box" and all(k in g for k in ("x", "y", "w", "h")):
        return "box2d", {"box": [float(g["x"]), float(g["y"]), float(g["w"]), float(g["h"])]}
    if t == "polygon" and len(_pts(g.get("points"))) >= 3:
        return "polygon2d", {"points": _pts(g["points"])}
    if t == "mask" and isinstance(g.get("dims"), list) and len(g["dims"]) == 2:
        return "mask2d", {"mask": {"size": [int(g["dims"][0]), int(g["dims"][1])], "counts": [int(c) for c in g.get("counts") or []]}}
    if t == "span" and isinstance(g.get("start"), (int, float)) and isinstance(g.get("end"), (int, float)):
        return "timespan", {"start": float(g["start"]), "end": float(g["end"])}
    pts: list[list[float]]
    if t == "keypoint":
        pts = [[float(g.get("x", 0)), float(g.get("y", 0))]]
    elif t == "ellipse":
        pts = [[float(g.get("cx", 0)), float(g.get("cy", 0))]]
    elif t == "instant":
        pts = [[float(g.get("t", g.get("frame", 0)) or 0), 0.0]]
    elif t == "point3d":
        ijk = g.get("ijk") or [0, 0, 0]
        pts = [[float(ijk[0]), float(ijk[1])]]
    else:
        pts = _pts(g.get("points")) or [[0.0, 0.0]]
    return "measurement", {"points": pts, "value": 0.0}


def revision_for(a: dict, *, ontology_rev: str, actor_id: str) -> dict:
    """The annotation-revision document for one Studio annotation."""
    kind, geometry = kind_and_geometry(a.get("geometry") or {})
    status = {"accepted": "accepted", "rejected": "rejected"}.get(str((a.get("attributes") or {}).get("review", "")), "draft")
    return {
        "schema_version": SCHEMA_VERSION,
        "annotation_id": safe_id(str(a["id"]), "a"),
        "sample_id": sample_id(str(a["itemId"])),
        "kind": kind,
        "class_id": class_id(str(a.get("label", ""))),
        "ontology_rev": ontology_rev,
        "geometry": geometry,
        "coordinate_frame": "pixel" if kind != "timespan" else "seconds",
        "status": status,
        "attributes": {"studio_hash": studio_hash(a), "studio_type": safe_token(str((a.get("geometry") or {}).get("type", "unknown")))},
        "provenance": {"actor_id": actor_id[:128], "tool": "studio"},
    }


def safe_token(s: str) -> str:
    """An enum-like token (`^[a-z0-9][a-z0-9_.+/-]{0,127}$`)."""
    out = re.sub(r"[^a-z0-9_.+/-]", "-", s.lower())[:128]
    return out if out and out[0].isalnum() else f"t{out}"[:128]


def manifest_entry(rev: dict, ref: str) -> dict:
    return {
        "annotation_id": rev["annotation_id"],
        "revision_id": "r-" + ref.split(":", 1)[-1][:32],
        "sample_id": rev["sample_id"],
        "kind": rev["kind"],
        "class_id": rev["class_id"],
        "ontology_rev": rev["ontology_rev"],
        "ref": ref,
    }


def annotation_from_revision(rev: dict, base: dict | None, class_names: dict[str, str]) -> dict:
    """Fallback for a revision the kernel has no payload for (e.g. a field-level merge
    result): the last known Studio annotation with this id, updated from the revision."""
    a = dict(base or {})
    a.setdefault("id", rev["annotation_id"])
    a.setdefault("itemId", rev["sample_id"].replace(":", "/"))
    a.setdefault("provenance", "human-created")
    a.setdefault("author", (rev.get("provenance") or {}).get("actor_id", "unknown"))
    a.setdefault("createdAt", "1970-01-01T00:00:00Z")
    a["label"] = class_names.get(rev["class_id"], rev["class_id"])
    g, k = rev.get("geometry") or {}, rev.get("kind")
    if k == "box2d" and len(g.get("box") or []) == 4:
        x, y, w, h = g["box"]
        a["geometry"] = {**(a.get("geometry") or {}), "type": "box", "x": x, "y": y, "w": w, "h": h}
    elif k == "polygon2d":
        a["geometry"] = {**(a.get("geometry") or {}), "type": "polygon", "points": g.get("points") or []}
    elif k == "mask2d" and g.get("mask"):
        a["geometry"] = {**(a.get("geometry") or {}), "type": "mask", "dims": list(g["mask"]["size"]), "counts": list(g["mask"]["counts"])}
    elif k == "timespan":
        a["geometry"] = {**(a.get("geometry") or {}), "type": "span", "start": g.get("start"), "end": g.get("end")}
    elif "geometry" not in a:
        p = (g.get("points") or [[0, 0]])[0]
        a["geometry"] = {"type": "keypoint", "x": p[0], "y": p[1]}
    return a
