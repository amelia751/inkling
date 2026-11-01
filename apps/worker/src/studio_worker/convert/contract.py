"""The converter contract in Python: mirrors packages/contracts/src/converter.ts (zod), whose
emitted JSON Schemas are schemas/converter.v1.json, converter-output.v1.json and
conversion-summary.v1.json. tests/test_convert.py checks the enums against those files."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

CANONICAL_SHAPES = ("zarr", "arrow", "assets")
CONVERSION_ERRORS = ("unsupported-input", "invalid-output", "output-too-large", "timeout", "memory", "crash", "denied", "converter-invalid")
DTYPES = ("bool", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float16", "float32", "float64")

PLUGIN_ID = re.compile(r"^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$")
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
REL_PATH = re.compile(r"^(?!/)(?!.*\.\.)[\w./-]+$")
EXT = re.compile(r"^\.[a-z0-9]+(?:\.[a-z0-9]+)?$")
ENTRYPOINT = re.compile(r"^[a-z_][\w.]*:[a-z_]\w*$")
HEX = re.compile(r"^(?:[0-9a-f]{2}){1,32}$")
ARG = re.compile(r"^[\w.=:-]{1,64}$")


class ConverterInvalid(ValueError):
    """The package or its manifest breaks the contract (reported as `converter-invalid`)."""


def _strict(d: object, allowed: set[str], where: str) -> dict:
    if not isinstance(d, dict):
        raise ConverterInvalid(f"{where} must be a mapping")
    extra = set(d) - allowed
    if extra:
        raise ConverterInvalid(f"{where}: unknown fields {sorted(extra)}")
    return d


def _str(d: dict, k: str, pattern: re.Pattern | None = None, required: bool = True, max_len: int = 400) -> str | None:
    v = d.get(k)
    if v is None and not required:
        return None
    if not isinstance(v, str) or not v or len(v) > max_len or (pattern and not pattern.match(v)):
        raise ConverterInvalid(f"{k} is missing or malformed")
    return v


def validate_manifest(m: object) -> dict:
    """converter.yaml → a normalised dict with defaults, or ConverterInvalid."""
    m = _strict(m, {"schemaVersion", "id", "version", "title", "description", "accepts", "produces", "output", "runtime", "limits", "fixtures"}, "converter.yaml")
    out: dict = {"id": _str(m, "id", PLUGIN_ID), "version": _str(m, "version", SEMVER), "title": _str(m, "title", max_len=120), "description": _str(m, "description")}
    a = _strict(m.get("accepts"), {"ext", "mediaTypes", "magic", "headerContains"}, "accepts")
    ext = [e for e in a.get("ext") or [] if isinstance(e, str) and EXT.match(e)]
    if len(ext) != len(a.get("ext") or []):
        raise ConverterInvalid("accepts.ext: lower-case extensions with their dot")
    media = [str(t) for t in a.get("mediaTypes") or []]
    if not ext and not media:
        raise ConverterInvalid("accepts needs ext or mediaTypes")
    magic = []
    for g in a.get("magic") or []:
        g = _strict(g, {"offset", "hex"}, "accepts.magic")
        if not isinstance(g.get("offset"), int) or not 0 <= g["offset"] <= 65536 or not HEX.match(str(g.get("hex"))):
            raise ConverterInvalid("accepts.magic: {offset, hex}")
        magic.append({"offset": g["offset"], "hex": g["hex"]})
    header = [str(h) for h in a.get("headerContains") or []]
    if any(not 1 <= len(h) <= 64 for h in header):
        raise ConverterInvalid("accepts.headerContains: 1–64 characters each")
    out["accepts"] = {"ext": ext, "mediaTypes": media, "magic": magic, "headerContains": header}
    if m.get("produces") not in CANONICAL_SHAPES:
        raise ConverterInvalid(f"produces must be one of {CANONICAL_SHAPES}")
    out["produces"] = m["produces"]
    out["output"] = dict(_strict(m.get("output") or {}, {"mediaType", "ext", "dataKind", "preset"}, "output"))
    r = m.get("runtime") or {}
    if not isinstance(r, dict):
        raise ConverterInvalid("runtime must be a mapping")
    if r.get("kind") == "python":
        _strict(r, {"kind", "entrypoint"}, "runtime")
        out["runtime"] = {"kind": "python", "entrypoint": _str(r, "entrypoint", ENTRYPOINT)}
    elif r.get("kind") == "wasm":
        _strict(r, {"kind", "module", "abi", "args", "fuelMillions"}, "runtime")
        args = r.get("args") or []
        if not isinstance(args, list) or len(args) > 16 or any(not isinstance(x, str) or not ARG.match(x) for x in args):
            raise ConverterInvalid("runtime.args: up to 16 plain tokens")
        abi = r.get("abi", "wasi-p1")
        if abi not in ("wasi-p1", "wasi-p2"):
            raise ConverterInvalid("runtime.abi")
        fuel = r.get("fuelMillions")
        if fuel is not None and (not isinstance(fuel, int) or not 0 < fuel <= 1_000_000):
            raise ConverterInvalid("runtime.fuelMillions")
        out["runtime"] = {"kind": "wasm", "module": _str(r, "module", REL_PATH), "abi": abi, "args": args, "fuelMillions": fuel}
    else:
        raise ConverterInvalid("runtime.kind must be python or wasm")
    lim = _strict(m.get("limits") or {}, {"timeoutS", "memoryMb", "maxOutputMb"}, "limits")
    bounds = {"timeoutS": (120, 900), "memoryMb": (1024, 8192), "maxOutputMb": (512, 4096)}
    out["limits"] = {}
    for k, (default, hi) in bounds.items():
        v = lim.get(k, default)
        if not isinstance(v, int) or not 0 < v <= hi:
            raise ConverterInvalid(f"limits.{k}: 1–{hi}")
        out["limits"][k] = v
    out["fixtures"] = [f for f in m.get("fixtures") or [] if isinstance(f, str) and REL_PATH.match(f)]
    return out


def load_manifest(package: Path) -> dict:
    f = package / "converter.yaml"
    if not f.is_file():
        raise ConverterInvalid("the package has no converter.yaml")
    try:
        return validate_manifest(yaml.safe_load(f.read_text()))
    except yaml.YAMLError as e:
        raise ConverterInvalid("converter.yaml doesn't parse") from e


def accepts(m: dict, name: str, head: bytes) -> bool:
    a = m["accepts"]
    if not any(name.lower().endswith(e) for e in a["ext"]):
        return False
    if a["magic"] and not any(head[g["offset"] : g["offset"] + len(g["hex"]) // 2] == bytes.fromhex(g["hex"]) for g in a["magic"]):
        return False
    text = head[:4096].decode("latin-1")
    return all(h in text for h in a["headerContains"])


def validate_output(doc: object, produces: str) -> dict:
    """output.json → dict, or ValueError (reported as `invalid-output`)."""
    if not isinstance(doc, dict) or doc.get("shape") != produces:
        raise ValueError("shape")
    paths: list[str] = []
    if produces == "assets":
        _strict(doc, {"shape", "assets", "dataKind"}, "output")
        assets = doc.get("assets")
        if not isinstance(assets, list) or not assets:
            raise ValueError("assets")
        for a in assets:
            _strict(a, {"path", "mediaType", "role", "width", "height", "frames"}, "asset")
            if not isinstance(a.get("path"), str) or not REL_PATH.match(a["path"]) or not isinstance(a.get("mediaType"), str):
                raise ValueError("asset")
            paths.append(a["path"])
    elif produces == "zarr":
        _strict(doc, {"shape", "store", "arrays"}, "output")
        if not isinstance(doc.get("store"), str) or not REL_PATH.match(doc["store"]) or not isinstance(doc.get("arrays"), list) or not doc["arrays"]:
            raise ValueError("zarr")
        for arr in doc["arrays"]:
            _strict(arr, {"path", "shape", "dtype", "chunks", "dimensionNames", "spacing"}, "array")
            if arr.get("dtype") not in DTYPES or not isinstance(arr.get("shape"), list) or not all(isinstance(x, int) and x >= 1 for x in arr["shape"]):
                raise ValueError("array")
        paths.append(doc["store"])
    else:
        _strict(doc, {"shape", "file", "rows", "columns"}, "output")
        if not isinstance(doc.get("file"), str) or not REL_PATH.match(doc["file"]):
            raise ValueError("arrow")
        paths.append(doc["file"])
    return {"doc": doc, "paths": paths}
