"""Sidecars and pairs at import (todo18 D5).

* WFDB: `<rec>.hea` + `<rec>.dat` / `<rec>.mat`;
* Analyze: `<x>.hdr` + `<x>.img`;
* ACDC: `Info.cfg` (ED, ES, Height, Weight, Group, NbFrame) → meta of the patient folder's items;
* BraTS / ACDC labels: `*_seg.nii.gz` → sequence `seg`, `*_gt.nii.gz` → role `reference`.

Lone halves get the flag `needs-pair` ("needs its pair") instead of being left as unknown files.
Pure functions over names (and the small Info.cfg text): no bytes beyond that.
"""

from __future__ import annotations

import posixpath
import re

PAIRS = {".hea": (".dat", ".mat"), ".hdr": (".img",)}
PARTNERS = {".dat": (".hea",), ".mat": (".hea",), ".img": (".hdr",)}
NEEDS_PAIR = "needs-pair"


def _split(name: str) -> tuple[str, str]:
    stem, ext = posixpath.splitext(name)
    return stem, ext.lower()


def pair_files(names: list[str]) -> tuple[list[dict], dict[str, dict]]:
    """(pairs, flags): pairs as {"primary", "parts", "format"}; flags by name for lone halves."""
    by_stem: dict[str, dict[str, str]] = {}
    for n in names:
        stem, ext = _split(n)
        if ext in PAIRS or ext in PARTNERS:
            by_stem.setdefault(stem, {})[ext] = n
    pairs: list[dict] = []
    flags: dict[str, dict] = {}
    for stem, exts in by_stem.items():
        for head, partners in PAIRS.items():
            if head in exts:
                parts = [exts[p] for p in partners if p in exts]
                if parts:
                    pairs.append({"primary": exts[head], "parts": parts, "format": "wfdb" if head == ".hea" else "analyze"})
                else:
                    want = " or ".join(f"{posixpath.basename(stem)}{p}" for p in partners)
                    flags[exts[head]] = {"code": NEEDS_PAIR, "message": f"Needs its pair: {want}"}
        for part, heads in PARTNERS.items():
            if part in exts and not any(h in exts for h in heads):
                flags[exts[part]] = {"code": NEEDS_PAIR, "message": f"Needs its pair: {posixpath.basename(stem)}{heads[0]}"}
    return pairs, flags


_CFG = re.compile(r"^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$")


def parse_acdc_info(text: str) -> dict:
    """ACDC Info.cfg → {"ed": 1, "es": 12, "height": 184.0, "weight": 95.0, "group": "DCM", "frames": 30}."""
    out: dict = {}
    for line in text.splitlines():
        m = _CFG.match(line)
        if not m:
            continue
        k, v = m.group(1).lower(), m.group(2)
        try:
            if k in ("ed", "es"):
                out[k] = int(float(v))
            elif k == "nbframe":
                out["frames"] = int(float(v))
            elif k in ("height", "weight"):
                out[k] = float(v)
            elif k == "group":
                out["group"] = v
        except ValueError:
            continue
    return out


def segmentation_role(name: str) -> dict | None:
    """BraTS `_seg` → sequence seg; `_gt` (ACDC, others) → role reference."""
    base = posixpath.basename(name).lower()
    stem = re.sub(r"\.(nii\.gz|nii|mha|nrrd)$", "", base)
    if stem.endswith("_seg"):
        return {"role": "reference", "sequence": "seg"}
    if stem.endswith("_gt"):
        return {"role": "reference"}
    return None


def item_meta(info: dict) -> dict:
    """Info.cfg values as item meta: ED/ES become 0-based frames (as the seeds' meta)."""
    out = {k: v for k, v in info.items() if k in ("group", "frames", "height", "weight")}
    for k in ("ed", "es"):
        if isinstance(info.get(k), int):
            out[k] = info[k] - 1
    return out
