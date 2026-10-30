"""Contracts shared with the web app and plugins.

`_generated/` holds pydantic models generated from the JSON Schemas that
`pnpm emit:schemas` writes to schemas/ (from packages/plugin-contracts, zod).
Regenerate with `uv run python scripts/gen_contracts.py` (apps/api); CI runs it with
`--check` and fails on a diff. This module adds what JSON Schema can't express: the
cross-field manifest rules, and normalisation of capability results into canonical
annotations.
"""

from __future__ import annotations

import struct
import uuid
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, ValidationError

from ...naming import plugin_schema_version
from ._generated import image_segment_request, image_segment_result, plugin_v1


@dataclass(frozen=True)
class Capability:
    request: type[BaseModel]
    result: type[BaseModel]


CAPABILITIES: dict[str, Capability] = {
    "image.segment": Capability(image_segment_request.SegmentRequest, image_segment_result.SegmentResult),
}


def validate_plugin_manifest(manifest: dict) -> list[str]:
    """JSON-Schema-level validation plus the cross-field rules from plugin-manifest.ts."""
    errs: list[str] = []
    try:
        plugin_v1.PluginManifest.model_validate(manifest)
    except ValidationError as e:
        errs += [f"{'.'.join(map(str, x['loc'])) or '(root)'}: {x['msg']}" for x in e.errors()]
    if manifest.get("schemaVersion") != plugin_schema_version():
        errs.append(f"schemaVersion must be {plugin_schema_version()}")
    perms = set((manifest.get("permissions") or {}).get("required") or []) | set((manifest.get("permissions") or {}).get("optional") or [])
    caps = {c.get("id") for c in manifest.get("capabilities") or []}
    for p in manifest.get("providers") or []:
        for h in p.get("egress") or []:
            if f"network.egress:{h}" not in perms:
                errs.append(f"provider {p['id']}: egress to {h} needs permission network.egress:{h}")
        for s in p.get("secrets") or []:
            if f"secrets.use:{s}" not in perms:
                errs.append(f"provider {p['id']}: secret {s} needs permission secrets.use:{s}")
        for c in p.get("implements") or []:
            if c not in caps:
                errs.append(f"provider {p['id']} implements undeclared capability {c}")
    kinds: set[str] = set()
    for i, rule in enumerate(((manifest.get("annotations") or {}).get("diff")) or []):
        g = rule.get("geometry") or {} if isinstance(rule, dict) else {}
        if g.get("metric") == "iou" and not (isinstance(g.get("threshold"), (int, float)) and 0 < g["threshold"] <= 1):
            errs.append(f"annotations.diff.{i}.geometry.threshold: iou threshold must be in (0, 1]")
        if isinstance(rule, dict) and rule.get("kind") in kinds:
            errs.append(f"annotations.diff.{i}.kind: more than one diff rule for {rule['kind']}")
        if isinstance(rule, dict):
            kinds.add(rule.get("kind"))
    if (manifest.get("runtime") or {}).get("kind") == "python-worker" and (manifest.get("ui") or {}).get("module"):
        errs.append("python-worker plugins can't ship a trusted TS module; use ui.contributions")
    return errs


# ---- Masks ---------------------------------------------------------------------------------


def coco_to_rowmajor(size: list[int], counts: list[int]) -> tuple[list[int], list[int], int]:
    """Column-major COCO RLE ([h, w]) → the Studio's mask geometry: dims [w, h], row-major runs."""
    h, w = size
    if sum(counts) != h * w:
        raise ValueError(f"RLE counts sum to {sum(counts)}, expected {h * w} (height × width)")
    bits = bytearray(h * w)
    i, v = 0, 0
    for run in counts:
        if v:
            for k in range(i, i + run):
                bits[(k % h) * w + k // h] = 1
        i += run
        v ^= 1
    return [w, h], rle_rowmajor(bits), sum(bits)


def rle_rowmajor(bits: bytes | bytearray) -> list[int]:
    out, v, run = [], 0, 0
    for b in bits:
        b = 1 if b else 0
        if b != v:
            out.append(run)
            run, v = 0, b
        run += 1
    out.append(run)
    return out


def decode_png_gray(data: bytes) -> tuple[int, int, bytes]:
    """8-bit grayscale / RGB / RGBA PNG → (w, h, one byte per pixel, nonzero = foreground)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("artifact mask is not a PNG")
    pos, idat = 8, b""
    w = h = ctype = 0
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos : pos + 4])
        t = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + n]
        if t == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace or ctype not in (0, 2, 4, 6):
                raise ValueError("artifact masks must be 8-bit, non-interlaced PNGs")
        elif t == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * bpp
    out = bytearray(w * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1 : p + 1 + stride])
        p += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        for x in range(w):
            out[y * w + x] = 1 if any(line[x * bpp : x * bpp + (bpp if ctype in (0, 2) else bpp - 1)]) else 0
        prev = line
    return w, h, bytes(out)


def normalize_result(capability: str, result: dict, job, *, author: str, db=None) -> list[dict]:
    """Provider-independent result → canonical annotations with provenance (docs/plugins.md §11)."""
    if capability != "image.segment":
        return []
    import json

    from ...models import Artifact

    req = job.input
    out = []
    now = datetime.now(UTC).isoformat()
    prompt = {k: req[k] for k in ("prompts",) if req.get(k)}
    for inst in result["instances"]:
        m = inst["mask"]
        if m["encoding"] == "rle":
            dims, counts, n = coco_to_rowmajor(m["size"], m["counts"])
        else:
            art = db.get(Artifact, m["artifact_id"]) if db is not None else None
            if art is None or art.workspace_id != job.workspace_id:
                raise ValueError(f"mask artifact {m['artifact_id']} isn't in this workspace")
            w, h, bits = decode_png_gray(Path(art.path).read_bytes())
            if [h, w] != list(m["size"]):
                raise ValueError("mask artifact size doesn't match its declared size")
            dims, counts, n = [w, h], rle_rowmajor(bits), sum(bits)
        if n == 0:
            continue
        attrs: dict = {
            "provider": result["provider"],
            "model": result["model"],
            "review_status": "pending",
            "job_id": job.job_id,
            "instance_id": inst["instance_id"],
        }
        if prompt:
            attrs["prompt"] = json.dumps(prompt, separators=(",", ":"))[:2000]
        if inst.get("confidence") is not None:
            attrs["confidence"] = inst["confidence"]
        out.append(
            {
                "id": uuid.uuid5(uuid.NAMESPACE_URL, f"{job.job_id}/{inst['instance_id']}").hex,
                "itemId": req.get("item_id") or req["asset_id"],
                "label": req.get("label") or inst.get("label") or "segment",
                "geometry": {"type": "mask", "dims": dims, "counts": counts, "voxels": n},
                "provenance": "ai-suggested",
                "author": author,
                "createdAt": now,
                "attributes": attrs,
            }
        )
    return out
