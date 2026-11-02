"""Resolve-level environment checks on the server (todo17 D2).

A Python port of the deterministic checks in `apps/web/src/extension-host/resolve.ts` that need
only static data: the generated catalogue (`schemas/catalog.json`) and the bundled presets
(`registry/presets/*.json`). It merges `extends` like the resolver, then reports, with the
resolver's codes and paths:

- `extends-cycle`, `wrong-type` (an id of another contribution type),
- `missing-data-kind`, `missing-viewport`, `renderer-data-mismatch`,
- `duplicate-tool`, `label-target`, `exporter-unused`.

Ids the catalogue doesn't know (installed plugins, typos) are skipped here: the reference check
in `environment_policy` reports unknown ids. `when` evaluation, hotkey conflicts, module
versions and config schemas stay in the browser (they need the loaded modules).

Severity is the server's: `missing-data-kind` and `missing-viewport` are warnings (a saved
document may be an overlay whose preset lives in an installed plugin); the rest are errors.
Both implementations run `packages/environment-core/fixtures/resolve-cases.json`.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

WARN_CODES = {"missing-data-kind", "missing-viewport"}
CONCAT_KEYS = {"overrides", "keybindings"}
SINGULAR = {
    "dataKinds": "data kind", "renderers": "renderer", "tools": "tool", "panels": "panel", "exporters": "exporter",
    "reviewRules": "review rule", "commands": "command", "presets": "preset", "labelControls": "label control",
    "geometries": "geometry", "inspectors": "inspector",
}


@lru_cache(maxsize=4)
def _load(root: str) -> tuple[dict, dict]:
    base = Path(root)
    catalog = json.loads((base / "schemas" / "catalog.json").read_text())
    by_id = {c["id"]: c for c in catalog.get("contributions") or []}
    presets: dict[str, dict] = {}
    for f in sorted((base / "registry" / "presets").glob("*.json")):
        if f.name == "intents.json":
            continue
        doc = json.loads(f.read_text())
        if isinstance(doc, dict) and isinstance(doc.get("spec"), dict):
            presets[doc.get("id") or f.stem] = doc["spec"]
    return by_id, presets


# ---- Merging (resolve.ts mergeSpecs) ------------------------------------------------------------


def _merge_objects(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        out[k] = _merge_objects(out[k], v) if isinstance(out.get(k), dict) and isinstance(v, dict) else v
    return out


def _merge_label_groups(a: list, b: list) -> list:
    by_name = {g.get("name"): g for g in b if isinstance(g, dict)}
    out = [by_name.get(g.get("name"), g) if isinstance(g, dict) else g for g in a]
    names = {g.get("name") for g in a if isinstance(g, dict)}
    out += [g for g in b if not (isinstance(g, dict) and g.get("name") in names)]
    return out


def merge_specs(a: dict, b: dict) -> dict:
    out = dict(a)
    for k, v in b.items():
        if v is None or k == "extends":
            continue
        prev = out.get(k)
        if k in CONCAT_KEYS and isinstance(prev, list) and isinstance(v, list):
            out[k] = [*prev, *v]
        elif k == "labels" and isinstance(prev, list) and isinstance(v, list):
            out[k] = _merge_label_groups(prev, v)
        elif isinstance(prev, dict) and isinstance(v, dict) and k != "layout":
            out[k] = _merge_objects(prev, v)
        else:
            out[k] = v
    return out


def _preset(presets: dict, by_id: dict, pid: str) -> dict | None:
    name = pid.removeprefix("preset:")
    if name in presets:
        return presets[name]
    c = by_id.get(pid) or by_id.get(name)
    return presets.get(c["id"].split(".")[-1]) if c and c.get("type") == "presets" else None


# ---- Checks -----------------------------------------------------------------------------------------


def resolve_issues(spec: dict, root: str | Path) -> list[dict]:
    """Every resolve-level issue `{path, code, message, severity}` for a shape-valid spec."""
    by_id, presets = _load(str(root))
    issues: list[dict] = []

    def err(path: str, code: str, message: str, suggestion: str | None = None) -> None:
        e = {"path": path, "code": code, "message": message, "severity": "warning" if code in WARN_CODES else "error"}
        if suggestion:
            e["suggestion"] = suggestion
        issues.append(e)

    def expand(s: dict, path: str, seen: list[str]) -> dict:
        ext = s.get("extends")
        parents = [] if ext is None else ext if isinstance(ext, list) else [ext]
        base: dict = {}
        for i, pid in enumerate(parents):
            if not isinstance(pid, str):
                continue
            p = f"{path}/extends" + (f"/{i}" if isinstance(ext, list) else "")
            if pid in seen:
                err(p, "extends-cycle", f'Preset "{pid}" extends itself ({" → ".join([*seen, pid])})')
                continue
            preset = _preset(presets, by_id, pid)
            if preset is not None:  # unknown presets: the reference check
                base = merge_specs(base, expand(preset, p, [*seen, pid]))
        return merge_specs(base, s)

    merged = expand(spec, "", [])
    if issues:
        return issues

    disabled = {o["id"] for o in merged.get("overrides") or [] if isinstance(o, dict) and o.get("disabled") is True}

    def ref(type_: str, id_, path: str) -> dict | None:
        c = by_id.get(id_) if isinstance(id_, str) else None
        if c is None:
            return None  # unknown: the reference check
        if c.get("type") != type_:
            err(path, "wrong-type", f'"{id_}" is a {SINGULAR.get(c["type"], c["type"])}, not a {SINGULAR.get(type_, type_)}')
            return None
        return c

    # Data kind and viewports.
    data_kind = None
    kind = (merged.get("data") or {}).get("kind") if isinstance(merged.get("data"), dict) else None
    if not kind:
        err("/data/kind", "missing-data-kind", "The environment needs data.kind (a data kind contribution id)")
    else:
        data_kind = ref("dataKinds", kind, "/data/kind")
    viewports = [v for v in merged.get("viewports") or [] if isinstance(v, dict)]
    if not viewports:
        err("/viewports", "missing-viewport", "The environment needs at least one viewport with a renderer")
    for i, v in enumerate(viewports):
        r = ref("renderers", v.get("renderer"), f"/viewports/{i}/renderer")
        if r and data_kind and data_kind["id"] not in (r.get("consumes") or []):
            fit = [c["id"] for c in by_id.values() if c.get("type") == "renderers" and data_kind["id"] in (c.get("consumes") or [])]
            err(f"/viewports/{i}/renderer", "renderer-data-mismatch", f'Renderer "{r["id"]}" can\'t display data kind "{data_kind["id"]}"', fit[0] if fit else None)

    # Tools: names unique.
    tool_ids = merged.get("tools") or []
    tools = []
    for i, id_ in enumerate(tool_ids):
        t = ref("tools", id_, f"/tools/{i}")
        if t and t["id"] not in disabled:
            tools.append(t)
    names: dict[str, str] = {}
    for t in tools:
        name = t["id"].split(".")[-1]
        if name in names:
            err(f"/tools/{tool_ids.index(t['id'])}", "duplicate-tool", f'Tools "{names[name]}" and "{t["id"]}" share the name "{name}"; the store can only hold one')
        names[name] = t["id"]

    # Panels, review rules, keybinding commands: type only.
    panels = merged.get("panels") if isinstance(merged.get("panels"), dict) else {}
    for slot in ("left", "right", "bottom", "viewport-bar"):
        for i, id_ in enumerate(panels.get(slot) or []):
            ref("panels", id_, f"/panels/{slot}/{i}")
    for i, id_ in enumerate(merged.get("reviewRules") or []):
        ref("reviewRules", id_, f"/reviewRules/{i}")
    for i, k in enumerate(merged.get("keybindings") or []):
        if isinstance(k, dict):
            ref("commands", k.get("command"), f"/keybindings/{i}/command")

    # Labels: control known (else skipped), toName names a viewport.
    vp_names = [v.get("name") for v in viewports]
    controls: list[dict | None] = []
    for i, g in enumerate(merged.get("labels") or []):
        if not isinstance(g, dict):
            continue
        ctl = g.get("control")
        controls.append(next((c for c in by_id.values() if c.get("type") == "labelControls" and ctl in (c["id"], c["id"].split(".")[-1])), None))
        if g.get("toName") and g["toName"] not in vp_names:
            err(f"/labels/{i}/toName", "label-target", f'Label group "{g.get("name")}" targets viewport "{g["toName"]}", which doesn\'t exist', vp_names[0] if vp_names else None)

    # Exporters must accept a geometry in use.
    exporter_ids = merged.get("exporters") or []
    exporters = [x for i, id_ in enumerate(exporter_ids) if (x := ref("exporters", id_, f"/exporters/{i}")) and x["id"] not in disabled]
    in_use = {t["creates"] for t in tools if t.get("creates")} | {g for c in controls if c for g in c.get("geometries") or []}
    if any(c is not None and not c.get("geometries") for c in controls):
        in_use.add("class")  # item-level controls (Choices) create item classes
    for x in exporters:
        accepts = x.get("accepts")
        if accepts != "*" and isinstance(accepts, list) and in_use and not set(accepts) & in_use:
            err(f"/exporters/{exporter_ids.index(x['id'])}", "exporter-unused", f'Exporter "{x["id"]}" accepts {", ".join(accepts)}, but this environment only creates {", ".join(sorted(in_use))}')
    return issues
