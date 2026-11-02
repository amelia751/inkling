"""Annotation rules: annotation.invalid (shape), annotation.out-of-bounds, annotation.too-small,
annotation.attribute-missing. Label rules (label.unknown, label.synonym, geometry.not-allowed)
are the `labels` family; run both on an annotation write.

Input: `{"annotations": [...], "items": {itemId: {"width": w, "height": h}}}`. `items` is optional:
out-of-bounds runs only for items whose dimensions are known. Rules: `rules.annotations`
(`insideImage`, default true as in rules.ts; `minSize`, a number or `{geometry: number}`;
`requiredAttributes`, a list or `{label: [keys]}`) and each label's `attributes` JSON Schema
(`required`).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from . import Violation, violation
from .labels import label_index

_Num = (int, float)


def _pts(g: Mapping[str, Any]) -> list[tuple[float, float]]:
    """The 2D image-pixel points that bound a geometry ([] when it isn't a 2D image shape)."""
    t = g.get("type")

    def pairs(seq: Any) -> list[tuple[float, float]]:
        return [(float(p[0]), float(p[1])) for p in seq or () if isinstance(p, (list, tuple)) and len(p) >= 2 and isinstance(p[0], _Num) and isinstance(p[1], _Num)]

    try:
        if t == "box":
            x, y, w, h = (float(g[k]) for k in ("x", "y", "w", "h"))
            return [(x, y), (x + w, y + h)]
        if t == "ellipse":
            cx, cy, rx, ry = (float(g[k]) for k in ("cx", "cy", "rx", "ry"))
            return [(cx - abs(rx), cy - abs(ry)), (cx + abs(rx), cy + abs(ry))]
        if t in ("polygon", "polyline", "spline"):
            return pairs(g.get("points"))
        if t == "multipolygon":
            return [p for poly in g.get("polygons") or () for ring in poly or () for p in pairs(ring)]
        if t == "keypoint":
            return [(float(g["x"]), float(g["y"]))]
        if t == "measurement" and g.get("space") == "image":
            return pairs(g.get("points"))
    except (KeyError, TypeError, ValueError):
        return []
    return []


def _extent(g: Mapping[str, Any]) -> float | None:
    """Largest extent across (pixels; samples or seconds for spans). None: size doesn't apply."""
    t = g.get("type")
    if t == "span" and isinstance(g.get("start"), _Num) and isinstance(g.get("end"), _Num):
        return abs(float(g["end"]) - float(g["start"]))
    if t in ("keypoint", "instant", "class", "point3d"):
        return None
    pts = _pts(g)
    if len(pts) < 2:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return max(max(xs) - min(xs), max(ys) - min(ys))


def _min_size(spec: Any, geo: str | None) -> float | None:
    if isinstance(spec, _Num) and not isinstance(spec, bool):
        return float(spec)
    if isinstance(spec, Mapping):
        v = spec.get(geo or "", spec.get("*"))
        return float(v) if isinstance(v, _Num) and not isinstance(v, bool) else None
    return None


def _required(rules: Mapping[str, Any], label: Mapping[str, Any] | None, label_name: str | None) -> list[str]:
    req = (rules.get("annotations") or {}).get("requiredAttributes") or []
    keys: list[str] = []
    if isinstance(req, list):
        keys += [k for k in req if isinstance(k, str)]
    elif isinstance(req, Mapping):
        for k in ("*", label_name, (label or {}).get("id")):
            if isinstance(k, str) and isinstance(req.get(k), list):
                keys += [x for x in req[k] if isinstance(x, str)]
    schema = (label or {}).get("attributes")
    if isinstance(schema, Mapping) and isinstance(schema.get("required"), list):
        keys += [x for x in schema["required"] if isinstance(x, str)]
    return list(dict.fromkeys(keys))


def shape_error(a: Any) -> str | None:
    from ..annotations import _canonical, validate_annotation

    try:
        validate_annotation(_canonical(a) if isinstance(a, dict) else a)
    except ValueError as e:
        return str(e)
    return None


def check(data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    section = rules.get("annotations") or {}
    inside = section.get("insideImage", True) is not False
    min_size = section.get("minSize")
    items = data.get("items") if isinstance(data.get("items"), Mapping) else {}
    canon, syn = label_index(rules)
    out: list[Violation] = []
    for i, a in enumerate(data.get("annotations") or ()):
        err = shape_error(a)
        if err:
            out.append(violation("annotation.invalid", f"/annotations/{i}", err))
            continue
        g = a["geometry"]
        geo = g.get("type")
        size = items.get(a["itemId"]) if isinstance(items, Mapping) else None
        if inside and isinstance(size, Mapping):
            w, h = size.get("width"), size.get("height")
            pts = _pts(g)
            if isinstance(w, _Num) and isinstance(h, _Num) and pts and any(x < 0 or y < 0 or x > w or y > h for x, y in pts):
                out.append(violation("annotation.out-of-bounds", f"/annotations/{i}/geometry", f"The {geo} lies outside the {w:g}×{h:g} image.", allowed=[w, h]))
        ms = _min_size(min_size, geo)
        ext = _extent(g) if ms else None
        if ms and ext is not None and ext < ms:
            out.append(violation("annotation.too-small", f"/annotations/{i}/geometry", f"The {geo} is {ext:g} across; the minimum is {ms:g}.", value=round(ext, 3), allowed=[ms]))
        key = a["label"].strip().casefold()
        lab = canon.get(key) or canon.get((syn.get(key) or "").casefold())
        attrs = a.get("attributes") or {}
        for k in _required(rules, lab, (lab or {}).get("name") or a["label"]):
            if attrs.get(k) in (None, ""):
                out.append(violation("annotation.attribute-missing", f"/annotations/{i}/attributes/{k}", f"Attribute '{k}' is required.", allowed=[k]))
    return out
