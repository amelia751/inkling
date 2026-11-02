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


# ---- Profiles (todo19 D3/D4; contracts `normalizeEnvironment`) ------------------------------------


def normalize(spec: dict) -> dict:
    """`normalizeEnvironment`: the one-kind shorthand (data.kind + viewports) folded into
    data.kinds, and `accepts` defaulting to the keys of data.kinds. No stored rewrite."""
    data = spec.get("data") if isinstance(spec.get("data"), dict) else None
    if data is None:
        return spec
    kinds = dict(data.get("kinds") or {})
    kind = data.get("kind")
    if kind and kind not in kinds:
        vps = [v for v in spec.get("viewports") or [] if isinstance(v, dict)]
        entry: dict = {"renderer": vps[0].get("renderer", "") if vps else ""}
        if vps and vps[0].get("config"):
            entry["config"] = vps[0]["config"]
        if len(vps) > 1:
            entry["viewports"] = vps
        kinds[kind] = entry
    return {**spec, "data": {**data, "kinds": kinds}, "accepts": spec.get("accepts") or list(kinds)}


def as_profile(spec: dict, pid: str) -> dict:
    """One preset as a profile of its kind: its renderer, tools, panels, exporters and review
    rules in `data.kinds.<kind>` (with `profile: pid`), its labels `appliesTo: [kind]`."""
    kind = (spec.get("data") or {}).get("kind") if isinstance(spec.get("data"), dict) else None
    if not kind:
        return spec
    out = normalize(spec)
    entry = dict(out["data"]["kinds"][kind])
    for k in ("tools", "panels", "exporters", "reviewRules"):
        if spec.get(k) is not None and k not in entry:
            entry[k] = spec[k]
    entry["profile"] = pid
    out["data"] = {**out["data"], "kinds": {**out["data"]["kinds"], kind: entry}}
    out["labels"] = [{**g, "appliesTo": [kind]} if isinstance(g, dict) and "appliesTo" not in g else g for g in spec.get("labels") or []]
    out.pop("accepts", None)
    return out


def compose(parts: list[dict]) -> dict:
    """Several profiles deep-merged (D4): the first stays the shorthand (data.kind, viewports,
    panels, tools, exporters); every part adds its data.kinds entry (with its own tools and
    exporters); labels of the same name join their appliesTo; review rules are the union."""
    if not parts:
        return {}
    out = dict(parts[0])
    for part in parts[1:]:
        data = dict(out.get("data") or {})
        data["kinds"] = {**(data.get("kinds") or {}), **((part.get("data") or {}).get("kinds") or {})}
        out["data"] = data
        labels = [dict(g) if isinstance(g, dict) else g for g in out.get("labels") or []]
        for g in part.get("labels") or []:
            same = next((x for x in labels if isinstance(x, dict) and isinstance(g, dict) and x.get("name") == g.get("name")), None)
            if same is None:
                labels.append(g)
            elif same.get("appliesTo") is not None and g.get("appliesTo") is not None:
                classes = {c.get("id") for c in same.get("classes") or [] if isinstance(c, dict)}
                same["classes"] = [*(same.get("classes") or []), *[c for c in g.get("classes") or [] if isinstance(c, dict) and c.get("id") not in classes]]
                same["appliesTo"] = list(dict.fromkeys([*same["appliesTo"], *g["appliesTo"]]))
        out["labels"] = labels
        # Tools and exporters stay per profile (two kinds' tools may share a name, and an
        # exporter is checked against its own kind's tools); review rules join.
        for k in ("reviewRules",):
            if part.get(k) is not None:
                out[k] = list(dict.fromkeys([*(out.get(k) or []), *part[k]]))
        for k, v in part.items():
            if k not in out:
                out[k] = v
    return out


def _expand_parents(parents: list, expanded) -> dict:
    """The merged base of `extends`: one preset merges as before; several compose as profiles."""
    got = [(pid, x) for pid in parents if isinstance(pid, str) and (x := expanded(pid)) is not None]
    if len(got) <= 1:
        return got[0][1] if got else {}
    return compose([as_profile(x, pid) for pid, x in got])


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
        def one(pid: str) -> dict | None:
            i = parents.index(pid)
            p = f"{path}/extends" + (f"/{i}" if isinstance(ext, list) else "")
            if pid in seen:
                err(p, "extends-cycle", f'Preset "{pid}" extends itself ({" → ".join([*seen, pid])})')
                return None
            preset = _preset(presets, by_id, pid)
            return expand(preset, p, [*seen, pid]) if preset is not None else None  # unknown: the reference check

        return merge_specs(_expand_parents(parents, one), s)

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
    profiles = (merged.get("data") or {}).get("kinds") if isinstance(merged.get("data"), dict) else None
    profiles = profiles if isinstance(profiles, dict) else {}
    if not kind and profiles:
        pass  # todo19 D3: data.kinds maps every kind; checked below
    elif not kind:
        err("/data/kind", "missing-data-kind", "The environment needs data.kind (a data kind contribution id)")
    else:
        data_kind = ref("dataKinds", kind, "/data/kind")
    viewports = [v for v in merged.get("viewports") or [] if isinstance(v, dict)]
    if not viewports and not profiles:
        err("/viewports", "missing-viewport", "The environment needs at least one viewport with a renderer")
    for i, v in enumerate(viewports):
        r = ref("renderers", v.get("renderer"), f"/viewports/{i}/renderer")
        if r and data_kind and data_kind["id"] not in (r.get("consumes") or []):
            fit = [c["id"] for c in by_id.values() if c.get("type") == "renderers" and data_kind["id"] in (c.get("consumes") or [])]
            err(f"/viewports/{i}/renderer", "renderer-data-mismatch", f'Renderer "{r["id"]}" can\'t display data kind "{data_kind["id"]}"', fit[0] if fit else None)

    # todo19 D3: each data.kinds entry: a renderer that consumes its kind, tools that exist.
    for k, prof in profiles.items():
        if not isinstance(prof, dict):
            continue
        dk = ref("dataKinds", k, f"/data/kinds/{k}")
        vps = [v for v in prof.get("viewports") or [] if isinstance(v, dict)] or [{"renderer": prof.get("renderer")}]
        for i, v in enumerate(vps):
            at = f"/data/kinds/{k}/viewports/{i}/renderer" if prof.get("viewports") else f"/data/kinds/{k}/renderer"
            r = ref("renderers", v.get("renderer"), at)
            if r and dk and dk["id"] not in (r.get("consumes") or []):
                fit = [c["id"] for c in by_id.values() if c.get("type") == "renderers" and dk["id"] in (c.get("consumes") or [])]
                err(at, "renderer-data-mismatch", f'Renderer "{r["id"]}" can\'t display data kind "{dk["id"]}"', fit[0] if fit else None)
        for i, id_ in enumerate(prof.get("tools") or []):
            ref("tools", id_, f"/data/kinds/{k}/tools/{i}")
    # D7: labels apply only to kinds the Studio accepts.
    accepted = merged.get("accepts") if isinstance(merged.get("accepts"), list) else list(profiles) or ([kind] if kind else [])
    for i, g in enumerate(merged.get("labels") or []):
        if isinstance(g, dict) and isinstance(g.get("appliesTo"), list) and accepted:
            extra = [x for x in g["appliesTo"] if x not in accepted]
            if extra:
                err(f"/labels/{i}/appliesTo", "label-applies-to", f'Label group "{g.get("name")}" applies to {", ".join(extra)}, which this Studio doesn\'t accept ({", ".join(accepted)})',
                    f'add {", ".join(extra)} to accepts, or remove {"it" if len(extra) == 1 else "them"} from appliesTo')

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


def merged_spec(spec: dict, root: str | Path) -> dict:
    """`spec` with its `extends` presets merged in, as the resolver does (unknown presets and
    cycles are skipped; `resolve_issues` reports them). Used for preset-only labels (todo17)."""
    by_id, presets = _load(str(root))

    def expand(s: dict, seen: tuple[str, ...]) -> dict:
        ext = s.get("extends")
        parents = [] if ext is None else ext if isinstance(ext, list) else [ext]
        def one(pid: str) -> dict | None:
            preset = _preset(presets, by_id, pid) if pid not in seen else None
            return expand(preset, (*seen, pid)) if preset is not None else None

        return merge_specs(_expand_parents(parents, one), s)

    return expand(spec, ()) if isinstance(spec, dict) else {}
