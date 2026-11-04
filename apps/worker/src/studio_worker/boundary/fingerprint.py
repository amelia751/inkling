"""Fingerprint: a real sample's structure with its values dropped (todo10 §6.1 step 1).

What it keeps: format and magic bytes, endianness, sizes and offsets of sections, header field
*names* with dtypes and counts, array dtypes and shapes, table column names and dtypes. What it
drops: every value. DICOM follows the PS3.15 Annex E basic profile: attribute values go, tag
numbers, keywords and VRs stay, and only the pixel-module attributes that describe structure
(rows, columns, bits, samples per pixel, photometric interpretation, transfer syntax, modality)
are kept as numbers or codes. Private tags keep their tag number only.

Names still go through the kernel's free-text check before anyone sees them; this module never
has to decide whether a name is safe, only never to emit a value.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import struct
from typing import Any

SCHEMA = "boundary.fingerprint/v1"
KNOWN_MAGIC: list[tuple[bytes, int, str]] = [
    (b"DICM", 128, "dicom"),
    (b"\x89HDF\r\n\x1a\n", 0, "hdf5"),
    (b"\x93NUMPY", 0, "npy"),
    (b"PAR1", 0, "parquet"),
    (b"\x89PNG\r\n\x1a\n", 0, "png"),
    (b"\xff\xd8\xff", 0, "jpeg"),
    (b"II*\x00", 0, "tiff"),
    (b"MM\x00*", 0, "tiff"),
    (b"\x1f\x8b", 0, "gzip"),
    (b"PK\x03\x04", 0, "zip"),
]
NIFTI_MAGIC = (b"n+1\x00", b"ni1\x00", b"n+2\x00", b"ni2\x00")
FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:/-]{0,63}$")
NP_DTYPES = {"b1": "bool", "i1": "int8", "u1": "uint8", "i2": "int16", "u2": "uint16", "i4": "int32", "u4": "uint32", "i8": "int64", "u8": "uint64", "f2": "float16", "f4": "float32", "f8": "float64", "c8": "complex64", "c16": "complex128"}
# DICOM attributes whose values describe structure, not a person (kept as numbers / codes).
DICOM_STRUCTURE = ("Rows", "Columns", "NumberOfFrames", "BitsAllocated", "BitsStored", "SamplesPerPixel", "PixelRepresentation", "PhotometricInterpretation", "Modality")


def _empty(sample_id: str, data: bytes, kind: str, profile: str = "generic-structure-v1") -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "sampleId": sample_id,
        "sampleDigest": f"sha256:{hashlib.sha256(data).hexdigest()}",
        "bytes": len(data),
        "format": {"kind": kind, "magic": None, "magicOffset": 0},
        "endianness": "unknown",
        "sections": [],
        "fields": [],
        "arrays": [],
        "table": None,
        "dicom": None,
        "scrub": {"profile": profile, "valuesDropped": 0, "namesRedacted": 0, "textCheck": "pending"},
    }


def detect(data: bytes) -> tuple[str, bytes | None, int]:
    for magic, off, kind in KNOWN_MAGIC:
        if data[off : off + len(magic)] == magic:
            return kind, magic, off
    if len(data) >= 348 and data[344:348] in NIFTI_MAGIC:
        return "nifti", data[344:348], 344
    head = data[:8192]
    if head and b"\x00" not in head:
        try:
            text = head.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        if text is not None:
            stripped = text.lstrip()
            if stripped.startswith(("{", "[")):
                return "json", None, 0
            first = text.splitlines()[0] if text.splitlines() else ""
            if "\t" in first:
                return "tsv", None, 0
            if "," in first or ";" in first:
                return "csv", None, 0
            return "text", None, 0
    # Unknown binary: the first 4 bytes are the agent's only hint; more needs a probe.
    return "binary", data[:4] if len(data) >= 4 else None, 0


def _name(n: str) -> str:
    return n if FIELD_NAME.match(n) else f"<redacted:{min(len(n), 99999)}>"


def fingerprint(sample_id: str, data: bytes) -> dict[str, Any]:
    kind, magic, off = detect(data)
    fp = _empty(sample_id, data, kind, "dicom-ps3.15-annex-e-basic" if kind == "dicom" else "generic-structure-v1")
    fp["format"] = {"kind": kind, "magic": magic.hex() if magic else None, "magicOffset": off}
    try:
        {"dicom": _dicom, "nifti": _nifti, "npy": _npy, "csv": _table, "tsv": _table, "png": _image, "jpeg": _image, "tiff": _image, "json": _json}.get(kind, _binary)(fp, data)
    except Exception:  # noqa: BLE001 — a file we can't parse keeps its format and size only
        fp["sections"] = [{"name": "data", "offset": 0, "length": len(data), "kind": "unknown"}]
    return fp


# ---- DICOM (Annex E basic profile) ---------------------------------------------------------

DTYPE_OF_VR = {"US": "uint16", "SS": "int16", "UL": "uint32", "SL": "int32", "FL": "float32", "FD": "float64", "OB": "bytes", "OW": "bytes", "OF": "bytes", "OD": "bytes", "UN": "bytes", "SQ": "object", "AT": "uint32", "IS": "string", "DS": "string"}


def _dicom(fp: dict, data: bytes) -> None:
    import pydicom

    ds = pydicom.dcmread(io.BytesIO(data), force=True)
    fields, dropped, removed = [], 0, 0
    for el in ds.iterall():
        tag = f"({el.tag.group:04X},{el.tag.element:04X})"
        private = el.tag.is_private
        keyword = "" if private else (el.keyword or "")
        vm = el.VM if el.VR != "SQ" else len(el.value or [])
        fields.append({"name": keyword if keyword and FIELD_NAME.match(keyword) else "Private" if private else "Unknown", "dtype": DTYPE_OF_VR.get(el.VR, "string"), "tag": tag, "vr": el.VR if re.fullmatch(r"[A-Z]{2}", el.VR or "") else "UN", "count": int(vm or 0)})
        if el.VR != "SQ" and el.value not in (None, "", b""):
            dropped += 1
            if keyword not in DICOM_STRUCTURE:
                removed += 1
        if len(fields) >= 512:
            break
    for el in ds.file_meta.iterall() if getattr(ds, "file_meta", None) else []:
        if len(fields) >= 512:
            break
        fields.append({"name": el.keyword if el.keyword and FIELD_NAME.match(el.keyword) else "Unknown", "dtype": DTYPE_OF_VR.get(el.VR, "string"), "tag": f"({el.tag.group:04X},{el.tag.element:04X})", "vr": el.VR if re.fullmatch(r"[A-Z]{2}", el.VR or "") else "UN", "count": int(el.VM or 0)})
    g = ds.get

    def num(k: str) -> int | None:
        try:
            v = g(k)
            return int(v) if v is not None and v != "" else None
        except (TypeError, ValueError):
            return None

    def code(k: str, rx: str) -> str | None:
        v = str(g(k) or "")
        return v if re.fullmatch(rx, v) else None

    ts = str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", "") or "")
    little = ts != "1.2.840.10008.1.2.2"
    fp["endianness"] = "little" if little else "big"
    fp["fields"] = fields
    fp["dicom"] = {
        "transferSyntax": ts if re.fullmatch(r"1\.2\.840\.10008\.[0-9.]{1,40}", ts) else None,
        "modality": code("Modality", r"[A-Z]{2,4}"),
        "rows": num("Rows"),
        "columns": num("Columns"),
        "frames": num("NumberOfFrames") or (1 if "PixelData" in ds else None),
        "bitsAllocated": num("BitsAllocated"),
        "bitsStored": num("BitsStored"),
        "samplesPerPixel": num("SamplesPerPixel"),
        "pixelRepresentation": num("PixelRepresentation"),
        "photometric": code("PhotometricInterpretation", r"[A-Z0-9_]{2,16}"),
        "removedTags": removed,
    }
    fp["sections"] = [{"name": "preamble", "offset": 0, "length": 128, "kind": "padding"}, {"name": "header", "offset": 128, "length": 0, "kind": "header"}]
    if "PixelData" in ds:
        rows, cols, bits = num("Rows") or 0, num("Columns") or 0, num("BitsAllocated") or 8
        spp, frames, signed = num("SamplesPerPixel") or 1, num("NumberOfFrames") or 1, num("PixelRepresentation") == 1
        dtype = {8: "int8" if signed else "uint8", 16: "int16" if signed else "uint16", 32: "int32" if signed else "uint32"}.get(bits, "unknown")
        shape = [s for s in ([frames] if frames > 1 else []) + [rows, cols] + ([spp] if spp > 1 else [])]
        fp["arrays"] = [{"name": "PixelData", "dtype": dtype, "shape": shape, "endianness": fp["endianness"]}]
        pd = ds["PixelData"]
        length = len(pd.value) if pd.value is not None else 0
        start = max(0, len(data) - length)
        fp["sections"][1]["length"] = start - 128
        fp["sections"].append({"name": "PixelData", "offset": start, "length": length, "kind": "data"})
    else:
        fp["sections"][1]["length"] = max(0, len(data) - 128)
    fp["scrub"]["valuesDropped"] = dropped


# ---- Other formats -------------------------------------------------------------------------


def _nifti(fp: dict, data: bytes) -> None:
    little = struct.unpack("<i", data[:4])[0] in (348, 540)
    e = "<" if little else ">"
    dims = struct.unpack(f"{e}8h", data[40:56])
    datatype = struct.unpack(f"{e}h", data[70:72])[0]
    vox_offset = int(struct.unpack(f"{e}f", data[108:112])[0])
    dt = {2: "uint8", 4: "int16", 8: "int32", 16: "float32", 64: "float64", 256: "int8", 512: "uint16", 768: "uint32", 1024: "int64", 1280: "uint64"}.get(datatype, "unknown")
    ndim = max(0, min(int(dims[0]), 7))
    fp["endianness"] = "little" if little else "big"
    fp["fields"] = [{"name": n, "dtype": d} for n, d in (("sizeof_hdr", "int32"), ("dim", "int16"), ("datatype", "int16"), ("bitpix", "int16"), ("pixdim", "float32"), ("vox_offset", "float32"), ("descrip", "string"), ("aux_file", "string"))]
    fp["arrays"] = [{"name": "data", "dtype": dt, "shape": [int(d) for d in dims[1 : 1 + ndim]], "endianness": fp["endianness"], "offset": vox_offset, "order": "F"}]
    fp["sections"] = [{"name": "header", "offset": 0, "length": 348, "kind": "header"}, {"name": "data", "offset": vox_offset, "length": max(0, len(data) - vox_offset), "kind": "data"}]
    fp["scrub"]["valuesDropped"] = 2  # descrip, aux_file


def _npy(fp: dict, data: bytes) -> None:
    import ast

    major = data[6]
    hlen = struct.unpack("<H", data[8:10])[0] if major == 1 else struct.unpack("<I", data[8:12])[0]
    start = 10 if major == 1 else 12
    hdr = ast.literal_eval(data[start : start + hlen].decode("latin1"))
    descr = str(hdr.get("descr", ""))
    fp["endianness"] = {"<": "little", ">": "big", "|": "none"}.get(descr[:1], "unknown")
    fp["arrays"] = [{"name": "array", "dtype": NP_DTYPES.get(descr[1:], "unknown"), "shape": [int(x) for x in hdr.get("shape", ())][:8], "endianness": fp["endianness"], "offset": start + hlen, "order": "F" if hdr.get("fortran_order") else "C"}]
    fp["sections"] = [{"name": "header", "offset": 0, "length": start + hlen, "kind": "header"}, {"name": "data", "offset": start + hlen, "length": len(data) - start - hlen, "kind": "data"}]


def _infer(values: list[str]) -> str:
    vals = [v for v in values if v.strip()]
    if not vals:
        return "unknown"
    if all(re.fullmatch(r"[+-]?\d+", v.strip()) for v in vals):
        return "int64"
    if all(re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", v.strip()) for v in vals):
        return "float64"
    if all(v.strip().lower() in ("true", "false") for v in vals):
        return "bool"
    if all(re.fullmatch(r"\d{4}-\d{2}-\d{2}([ T].*)?", v.strip()) for v in vals):
        return "datetime"
    return "string"


def _table(fp: dict, data: bytes) -> None:
    text = data.decode("utf-8", errors="replace")
    delim = "\t" if fp["format"]["kind"] == "tsv" else ";" if text.split("\n", 1)[0].count(";") > text.split("\n", 1)[0].count(",") else ","
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    rows = [r for r in rows if r]
    first = rows[0] if rows else []
    body = rows[1:]
    # A header row is names, not data: every cell non-numeric and the next rows differ in type.
    header = bool(first) and all(not re.fullmatch(r"[+-]?[\d.eE+-]+", c.strip()) for c in first if c.strip())
    if not header:
        body = rows
        names = [f"col_{i}" for i in range(len(first))]
    else:
        names = [_name(c.strip()) for c in first]
    sample = body[:500]
    cols = [{"name": n, "dtype": _infer([r[i] for r in sample if i < len(r)])} for i, n in enumerate(names[:512])]
    fp["table"] = {"columns": cols, "rows": len(body), "delimiter": delim, "header": header}
    # The D5a profile (todo23): distributions, k-thresholded, never a raw value below k.
    from .profile import profile_rows

    fp["table"]["profile"] = profile_rows([c["name"] for c in cols], body[:200_000])
    fp["endianness"] = "none"
    fp["sections"] = [{"name": "header", "offset": 0, "length": len(delim.join(first).encode()) if header else 0, "kind": "header"}, {"name": "data", "offset": 0, "length": len(data), "kind": "data"}]
    fp["scrub"]["valuesDropped"] = sum(len(r) for r in body)


def _image(fp: dict, data: bytes) -> None:
    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        w, h, mode, n = im.width, im.height, im.mode, getattr(im, "n_frames", 1)
    dtype = {"1": "bool", "L": "uint8", "P": "uint8", "RGB": "uint8", "RGBA": "uint8", "I;16": "uint16", "I;16B": "uint16", "I": "int32", "F": "float32"}.get(mode, "unknown")
    channels = {"RGB": 3, "RGBA": 4}.get(mode, 1)
    shape = ([n] if n > 1 else []) + [h, w] + ([channels] if channels > 1 else [])
    fp["arrays"] = [{"name": "pixels", "dtype": dtype, "shape": shape, "endianness": "big" if fp["format"]["kind"] == "png" else "none"}]
    fp["fields"] = [{"name": "mode", "dtype": "string"}, {"name": "width", "dtype": "uint32"}, {"name": "height", "dtype": "uint32"}]
    fp["endianness"] = "big" if fp["format"]["kind"] == "png" else "unknown"
    fp["sections"] = [{"name": "data", "offset": 0, "length": len(data), "kind": "data"}]
    fp["scrub"]["valuesDropped"] = 1  # any text chunks / EXIF are never read


def _json(fp: dict, data: bytes) -> None:
    doc = json.loads(data)
    fields: list[dict] = []

    def walk(v: Any, path: str, depth: int) -> None:
        if len(fields) >= 512 or depth > 4:
            return
        if isinstance(v, dict):
            for k, x in list(v.items())[:200]:
                p = f"{path}.{k}" if path else str(k)
                fields.append({"name": _name(p), "dtype": _jtype(x), **({"count": len(x)} if isinstance(x, list) else {})})
                walk(x, p, depth + 1)
        elif isinstance(v, list) and v:
            walk(v[0], f"{path}[]" if path else "items", depth + 1)

    walk(doc, "", 0)
    fp["fields"], fp["endianness"] = fields, "none"
    fp["sections"] = [{"name": "data", "offset": 0, "length": len(data), "kind": "data"}]


def _jtype(v: Any) -> str:
    return "bool" if isinstance(v, bool) else "int64" if isinstance(v, int) else "float64" if isinstance(v, float) else "string" if isinstance(v, str) else "object"


def _binary(fp: dict, data: bytes) -> None:
    # Structure the agent can't get from a parser: printable runs (offsets and lengths only) and
    # the long uniform tail where an array usually is. Values stay here.
    sections, i, n = [], 0, len(data)
    runs = [(m.start(), m.end() - m.start()) for m in re.finditer(rb"[\x20-\x7e]{4,}", data[:65536])][:32]
    head_end = runs[-1][0] + runs[-1][1] if runs else min(n, 16)
    sections.append({"name": "header", "offset": 0, "length": head_end, "kind": "header"})
    for off, ln in runs:
        sections.append({"name": f"text_{i}", "offset": off, "length": ln, "kind": "metadata"})
        i += 1
    if n > head_end:
        sections.append({"name": "data", "offset": head_end, "length": n - head_end, "kind": "unknown"})
    fp["sections"] = sections[:64]
    fp["scrub"]["valuesDropped"] = len(runs)
