"""Synthetic fixtures: files with a fingerprint's structure and made-up content (todo10 §6.1 step 2).

Input is the fingerprint alone (the job never gets the sample: the kernel refuses this job's
sample route). Output: a few files of the same format, shape and dtype, filled with noise or a
simple phantom, with placeholder header values. These and the fingerprint are all the build
sandbox and the model ever see.
"""

from __future__ import annotations

import csv
import io
import json
import struct
from typing import Any

GENERATOR = "synthetic-v1"
VARIANTS = ("noise", "phantom", "edge-max", "zeros", "edge-min")
EXT = {"dicom": ("dcm", "application/dicom"), "nifti": ("nii", "application/x-nifti"), "npy": ("npy", "application/octet-stream"), "csv": ("csv", "text/csv"), "tsv": ("tsv", "text/tab-separated-values"),
       "png": ("png", "image/png"), "jpeg": ("jpg", "image/jpeg"), "tiff": ("tif", "image/tiff"), "json": ("json", "application/json"), "text": ("txt", "text/plain")}
NP = {"bool": "?", "int8": "i1", "uint8": "u1", "int16": "i2", "uint16": "u2", "int32": "i4", "uint32": "u4", "int64": "i8", "uint64": "u8", "float16": "f2", "float32": "f4", "float64": "f8", "complex64": "c8", "complex128": "c16"}


def _array(dtype: str, shape: list[int], variant: str, rng, endian: str = "little", bits_stored: int | None = None):
    import numpy as np

    shape = [max(1, min(int(s), 4096)) for s in shape] or [1]
    if int(np.prod(shape)) > 64 * 1024 * 1024:  # keep fixtures small; the structure is what matters
        shape = [min(s, 256) for s in shape]
    dt = np.dtype(NP.get(dtype, "u1")).newbyteorder("<" if endian != "big" else ">")
    if dt.kind in "iu":
        info = np.iinfo(dt)
        hi = min(int(info.max), (1 << bits_stored) - 1 if bits_stored else int(info.max))
        lo = max(int(info.min), 0 if dt.kind == "u" else -hi)
    elif dt.kind == "b":
        lo, hi = 0, 1
    else:
        lo, hi = -1.0, 1.0
    if variant == "zeros":
        a = np.zeros(shape, dt)
    elif variant == "edge-max":
        a = np.full(shape, hi, dt)
    elif variant == "edge-min":
        a = np.full(shape, lo, dt)
    elif variant == "phantom":  # a bright disc on a dark background, per slice
        yy, xx = np.ogrid[: shape[-2] if len(shape) > 1 else 1, : shape[-1]]
        cy, cx = (shape[-2] if len(shape) > 1 else 1) / 2, shape[-1] / 2
        disc = ((yy - cy) ** 2 + (xx - cx) ** 2) <= (min(cy, cx) * 0.6) ** 2
        a = np.broadcast_to(np.where(disc, hi * 0.8 if dt.kind == "f" else int(hi * 0.8), lo), shape).astype(dt)
    elif dt.kind == "f":
        a = rng.standard_normal(shape).astype(dt)
    elif dt.kind == "c":
        a = (rng.standard_normal(shape) + 1j * rng.standard_normal(shape)).astype(dt)
    else:
        a = rng.integers(lo, hi, size=shape, endpoint=True, dtype=np.int64).astype(dt)
    return np.ascontiguousarray(a)


def _dicom(fp: dict, variant: str, rng) -> bytes:
    from pydicom.datadict import dictionary_VR, tag_for_keyword
    from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    d = fp.get("dicom") or {}
    meta: Any = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset("fixture.dcm", {}, file_meta=meta, preamble=b"\x00" * 128)
    # Placeholder values for every non-private attribute the sample had (Annex E: dummy values).
    for f in fp.get("fields") or []:
        kw, vr = f.get("name"), f.get("vr")
        if not kw or kw in ("Private", "Unknown", "PixelData") or not isinstance(kw, str) or kw.startswith("<") or kw in Dataset.__dict__:
            continue
        try:
            tag = tag_for_keyword(kw)
            if tag is None or (tag >> 16) == 0x0002:
                continue
            vr = dictionary_VR(tag)
        except (KeyError, ValueError):
            continue
        dummy: Any = {"PN": "SYNTHETIC^FIXTURE", "DA": "20000101", "TM": "000000", "DT": "20000101000000", "UI": generate_uid(), "IS": "1", "DS": "1.0", "AS": "000Y", "US": 1, "SS": 1, "UL": 1, "SL": 1, "FL": 1.0, "FD": 1.0, "CS": "SYNTH"}.get(vr, "SYNTHETIC")
        if vr in ("SQ", "OB", "OW", "OF", "OD", "UN", "AT"):
            continue
        try:
            setattr(ds, kw, dummy)
        except (TypeError, ValueError, OverflowError):
            continue
    rows, cols = int(d.get("rows") or 64), int(d.get("columns") or 64)
    bits, stored = int(d.get("bitsAllocated") or 16), int(d.get("bitsStored") or d.get("bitsAllocated") or 16)
    spp, frames, signed = int(d.get("samplesPerPixel") or 1), int(d.get("frames") or 1), int(d.get("pixelRepresentation") or 0) == 1
    ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
    ds.Modality = d.get("modality") or "OT"
    ds.Rows, ds.Columns, ds.BitsAllocated, ds.BitsStored, ds.HighBit = rows, cols, bits, stored, stored - 1
    ds.SamplesPerPixel, ds.PixelRepresentation = spp, int(signed)
    ds.PhotometricInterpretation = d.get("photometric") or ("RGB" if spp == 3 else "MONOCHROME2")
    if spp > 1:
        ds.PlanarConfiguration = 0
    if frames > 1:
        ds.NumberOfFrames = frames
    dtype = {8: "int8" if signed else "uint8", 16: "int16" if signed else "uint16", 32: "int32" if signed else "uint32"}.get(bits, "uint16")
    shape = ([frames] if frames > 1 else []) + [rows, cols] + ([spp] if spp > 1 else [])
    ds.PixelData = _array(dtype, shape, variant, rng, bits_stored=stored).tobytes()
    out = io.BytesIO()
    ds.save_as(out, enforce_file_format=True)
    return out.getvalue()


def _nifti(fp: dict, variant: str, rng) -> bytes:
    import nibabel as nib
    import numpy as np

    arr = (fp.get("arrays") or [{}])[0]
    a = _array(arr.get("dtype", "float32"), arr.get("shape") or [16, 16, 8], variant, rng)
    img = nib.Nifti1Image(np.asarray(a), np.eye(4))
    return img.to_bytes()


def _npy(fp: dict, variant: str, rng) -> bytes:
    import numpy as np

    arr = (fp.get("arrays") or [{}])[0]
    a = _array(arr.get("dtype", "float32"), arr.get("shape") or [8], variant, rng, arr.get("endianness", "little"))
    out = io.BytesIO()
    np.save(out, np.asfortranarray(a) if arr.get("order") == "F" else a)
    return out.getvalue()


def _table(fp: dict, variant: str, rng) -> bytes:
    t = fp.get("table") or {"columns": [{"name": "col_0", "dtype": "string"}], "rows": 5, "header": True, "delimiter": ","}
    out = io.StringIO()
    w = csv.writer(out, delimiter=t.get("delimiter") or ",", lineterminator="\n")
    cols = t["columns"]
    if t.get("header", True):
        w.writerow([c["name"] if not str(c["name"]).startswith("<") else f"col_{i}" for i, c in enumerate(cols)])
    for r in range(max(1, min(int(t.get("rows") or 5), 200))):
        row = []
        for c in cols:
            dt = c.get("dtype")
            row.append(str(0 if variant == "zeros" else rng.integers(0, 1000)) if dt and dt.startswith(("int", "uint")) else f"{0.0 if variant == 'zeros' else rng.standard_normal():.4f}" if dt and dt.startswith("float") else "true" if dt == "bool" else "2000-01-01" if dt == "datetime" else f"synthetic_{r}")
        w.writerow(row)
    return out.getvalue().encode()


def _image(fp: dict, variant: str, rng) -> bytes:
    from PIL import Image

    arr = (fp.get("arrays") or [{}])[0]
    shape = arr.get("shape") or [32, 32]
    hw = shape[-3:-1] if len(shape) >= 3 and shape[-1] in (3, 4) else shape[-2:]
    ch = shape[-1] if len(shape) >= 3 and shape[-1] in (3, 4) else 1
    a = _array("uint8" if arr.get("dtype") != "uint16" else "uint16", [*hw, ch] if ch > 1 else list(hw), variant, rng)
    im = Image.fromarray(a)
    out = io.BytesIO()
    im.save(out, format={"png": "PNG", "jpeg": "JPEG", "tiff": "TIFF"}[fp["format"]["kind"]])
    return out.getvalue()


def _json(fp: dict, variant: str, rng) -> bytes:
    doc: dict = {}
    for f in fp.get("fields") or []:
        name = str(f.get("name"))
        if "." in name or "[" in name or name.startswith("<"):
            continue
        doc[name] = {"bool": True, "int64": 1, "float64": 1.0, "string": "synthetic", "object": {}}.get(f.get("dtype"), None)
    return json.dumps(doc).encode()


def _binary(fp: dict, variant: str, rng) -> bytes:
    """Unknown layout: same size, same magic and section boundaries; noise or zeros elsewhere.
    Text runs become runs of `x` of the same length (offsets kept, contents not)."""
    n = max(1, min(int(fp.get("bytes") or 64), 32 * 1024 * 1024))
    buf = bytearray(n if variant == "zeros" else rng.integers(0, 256, size=n, dtype="uint8").tobytes())
    for s in fp.get("sections") or []:
        if s.get("kind") == "metadata":
            o, ln = int(s["offset"]), int(s["length"])
            buf[o : o + ln] = b"x" * len(buf[o : o + ln])
    magic = fp["format"].get("magic")
    if magic:
        m = bytes.fromhex(magic)
        off = int(fp["format"].get("magicOffset") or 0)
        buf[off : off + len(m)] = m
    return bytes(buf)


MAKERS = {"dicom": _dicom, "nifti": _nifti, "npy": _npy, "csv": _table, "tsv": _table, "png": _image, "jpeg": _image, "tiff": _image, "json": _json}


def synthesize(fp: dict, count: int, seed: int) -> list[dict]:
    """[{name, data, mediaType, variant}] for the fingerprint's format."""
    import numpy as np

    kind = fp["format"]["kind"]
    ext, mt = EXT.get(kind, ("bin", "application/octet-stream"))
    out = []
    for i in range(max(1, min(count, 8))):
        variant = VARIANTS[i % len(VARIANTS)]
        rng = np.random.default_rng(seed + i)
        try:
            data = MAKERS.get(kind, _binary)(fp, variant, rng)
        except Exception:  # noqa: BLE001 — a format we can't rebuild still gets a same-size binary
            data, ext, mt = _binary(fp, variant, rng), "bin", "application/octet-stream"
        out.append({"name": f"fixture-{i:02d}-{variant}.{ext}", "data": data, "mediaType": mt, "variant": variant})
    return out


def seed_for(fixture_set_id: str) -> int:
    return struct.unpack(">I", bytes.fromhex(fixture_set_id[:8].ljust(8, "0")) if all(c in "0123456789abcdef" for c in fixture_set_id[:8]) else b"\x00\x00\x00\x07")[0]



def synthesize_table(fp: dict, count: int, seed: int, generator: str | None = None, secret: int | None = None) -> tuple[str, list[dict], dict]:
    """Tables (todo23 W4): fixtures from the profile, each with planted truth chosen here.

    Returns (generator id, [{name, data, mediaType, variant}], truth). The truth maps each
    fixture name to its plants and never goes in the fixtures response. The generator's rng
    mixes the reported `seed` with a secret one kept only in the truth, so the builder can't
    re-run the generator to learn where the plants are."""
    import secrets

    import numpy as np

    secret = secrets.randbits(63) if secret is None else secret

    from . import generators

    if len(generators.REGISTRY) <= 1:
        generators.discover()
    t = fp.get("table") or {}
    prof = t.get("profile")
    g = generators.choose(prof, "table", generator)
    kind = fp["format"]["kind"] if fp["format"]["kind"] in ("csv", "tsv") else "csv"
    ext, mt = EXT[kind]
    delim = "\t" if kind == "tsv" else (t.get("delimiter") or ",")
    rows = max(20, min(int((prof or {}).get("rows") or t.get("rows") or 200), 2000))
    out, truth = [], {"generator": g.id, "seed": seed, "secret": secret, "fixtures": {}}
    for i in range(max(1, min(count, 8))):
        rng = np.random.default_rng([seed, secret, i])
        names, body, plants = g.generate(prof, rng, rows)
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=delim, lineterminator="\n")
        w.writerow(names)
        w.writerows(body)
        name = f"fixture-{i:02d}-planted.{ext}"
        out.append({"name": name, "data": buf.getvalue().encode(), "mediaType": mt, "variant": "planted"})
        truth["fixtures"][name] = plants
    return g.id, out, truth
