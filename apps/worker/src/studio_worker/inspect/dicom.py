"""DICOM headers and series (todo6 Phase 5.1, docs/ux.md §7: file count ≠ volume).

Files are grouped by (StudyInstanceUID, SeriesInstanceUID) into *candidate* series. Each
series is checked, never silently fixed: InstanceNumber gaps and duplicates, and whether every
slice has the same orientation. UIDs are stored as hashes only (`study_uid_hash`,
`series_uid_hash`, the opaque keys `deid.py` already knows), and identifying attributes are
never copied into facts.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass, field

from . import privacy

MODALITY_NOUN = {"MR": "MRI", "CT": "CT", "PT": "PET", "US": "Ultrasound", "CR": "X-ray", "DX": "X-ray", "MG": "Mammography", "XA": "Angiography", "NM": "Nuclear medicine", "OT": "Other", "SEG": "Segmentation", "SR": "Structured report"}


def uid_hash(uid: str) -> str:
    return hashlib.sha256(uid.encode()).hexdigest()[:16]


@dataclass
class Instance:
    node_id: str
    name: str
    study: str
    series: str
    instance: int | None
    orientation: tuple[float, ...] | None
    position: tuple[float, ...] | None
    facts: dict = field(default_factory=dict)


def read_header(data: bytes):
    """A pydicom dataset without pixel data, or None when it isn't readable DICOM."""
    import pydicom
    from pydicom.errors import InvalidDicomError

    try:
        return pydicom.dcmread(io.BytesIO(data), stop_before_pixels=True)
    except (InvalidDicomError, EOFError, OSError, ValueError, AttributeError, KeyError, TypeError):
        return None


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _vec(v) -> tuple[float, ...] | None:
    try:
        out = tuple(round(float(x), 4) for x in v)
        return out or None
    except (TypeError, ValueError):
        return None


def header_facts(ds, node_id: str, name: str) -> tuple[dict, dict | None, Instance]:
    """(facts, privacy flag or None, instance for grouping). Facts are the ux.md §4.3 key facts:
    modality, series description, size, spacing, frames; never names, ids or dates."""
    g = ds.get
    rows, cols = g("Rows"), g("Columns")
    spacing = _vec(g("PixelSpacing")) if g("PixelSpacing") is not None else None
    frames = int(_num(g("NumberOfFrames")) or 1)
    modality = str(g("Modality") or "") or None
    dicom = {
        "modality": modality,
        "modalityLabel": MODALITY_NOUN.get(modality or "", modality),
        "seriesDescription": str(g("SeriesDescription") or "") or None,
        "rows": int(rows) if rows is not None else None,
        "columns": int(cols) if cols is not None else None,
        "pixelSpacing": list(spacing) if spacing else None,
        "sliceThickness": _num(g("SliceThickness")),
        "frames": frames,
        "instanceNumber": int(n) if (n := _num(g("InstanceNumber"))) is not None else None,
        "transferSyntax": str(getattr(getattr(ds, "file_meta", None), "TransferSyntaxUID", "") or "") or None,
        "bitsAllocated": int(g("BitsAllocated")) if g("BitsAllocated") is not None else None,
    }
    dicom = {k: v for k, v in dicom.items() if v is not None}
    study, series = str(g("StudyInstanceUID") or ""), str(g("SeriesInstanceUID") or "")
    facts: dict = {"dicom": dicom}
    if rows is not None and cols is not None:
        facts["width"], facts["height"] = int(cols), int(rows)
    if spacing:
        facts["spacing"] = list(spacing)
    if frames > 1:
        facts["frames"] = frames
    if study:
        facts["study_uid_hash"] = uid_hash(study)
    if series:
        facts["series_uid_hash"] = uid_hash(series)
    found = privacy.dicom_findings(ds)
    flag = privacy.flag([f"the header has {', '.join(found[:3])}"], "header", found) if found else None
    inst = Instance(node_id, name, study, series, dicom.get("instanceNumber"), _vec(g("ImageOrientationPatient")) if g("ImageOrientationPatient") is not None else None, _vec(g("ImagePositionPatient")) if g("ImagePositionPatient") is not None else None, facts)
    return facts, flag, inst


def _ranges(nums: list[int]) -> str:
    out, start, prev = [], None, None
    for n in nums:
        if start is None:
            start = prev = n
        elif prev is not None and n == prev + 1:
            prev = n
        else:
            out.append(f"{start}–{prev}" if start != prev else str(start))
            start = prev = n
    if start is not None:
        out.append(f"{start}–{prev}" if start != prev else str(start))
    return ", ".join(out)


def group_series(instances: list[Instance]) -> list[dict]:
    """Candidate series with their checks. One per (study, series) UID pair."""
    by: dict[tuple[str, str], list[Instance]] = {}
    for i in instances:
        if i.series:
            by.setdefault((i.study, i.series), []).append(i)
    out = []
    for (study, series), members in by.items():
        members.sort(key=lambda i: (i.instance is None, i.instance or 0, i.name))
        numbers = [i.instance for i in members if i.instance is not None]
        quality: list[str] = []
        missing: list[int] = []
        dupes = sorted({n for n in numbers if numbers.count(n) > 1})
        if numbers:
            have = set(numbers)
            missing = [n for n in range(min(numbers), max(numbers) + 1) if n not in have]
            if missing:
                quality.append(f"Series has gaps: {'instance' if len(missing) == 1 else 'instances'} {_ranges(missing[:50])} missing")
            if dupes:
                quality.append(f"Series repeats instance numbers {_ranges(dupes[:50])}")
        orients = {i.orientation for i in members if i.orientation}
        if len(orients) > 1:
            quality.append("Slices don't share one orientation: this may be more than one volume")
        first = members[0].facts.get("dicom", {})
        modality = first.get("modality")
        noun = MODALITY_NOUN.get(modality or "", modality or "DICOM")
        size = f"{first['columns']}×{first['rows']}" if first.get("rows") and first.get("columns") else None
        slices = len(members) if len(members) > 1 else int(first.get("frames") or 1)
        bits = [b for b in (modality, size, f"{slices} {'slice' if slices == 1 else 'slices'}") if b]
        summary = f"{len(members)} DICOM {'file forms' if len(members) == 1 else 'files form'} 1 {noun} series ({', '.join(bits)})"
        out.append({
            "studyUidHash": uid_hash(study) if study else None,
            "seriesUidHash": uid_hash(series),
            "nodeIds": [i.node_id for i in members],
            "modality": modality,
            "modalityLabel": noun,
            "seriesDescription": first.get("seriesDescription"),
            "rows": first.get("rows"),
            "columns": first.get("columns"),
            "spacing": first.get("pixelSpacing"),
            "sliceCount": slices,
            "missingInstances": missing[:200],
            "duplicateInstances": dupes[:200],
            "orientationConsistent": len(orients) <= 1,
            "quality": quality,
            "summary": summary,
        })
    out.sort(key=lambda g: (g["studyUidHash"] or "", g["seriesDescription"] or "", g["seriesUidHash"]))
    return out


def thumbnail(data: bytes, size: int = 256) -> bytes | None:
    """A PNG of the (first frame of the) image with a default window, best effort: compressed
    transfer syntaxes without a decoder installed simply get no thumbnail."""
    try:
        import numpy as np
        import pydicom
        from pydicom.multival import MultiValue
        from PIL import Image

        ds = pydicom.dcmread(io.BytesIO(data))
        arr = ds.pixel_array
        if arr.ndim == 3 and arr.shape[-1] not in (3, 4):
            arr = arr[0]
        arr = arr.astype("float32")
        slope, intercept = float(ds.get("RescaleSlope", 1) or 1), float(ds.get("RescaleIntercept", 0) or 0)
        arr = arr * slope + intercept
        center, width = ds.get("WindowCenter"), ds.get("WindowWidth")
        if center is not None and width is not None:
            c = float(center[0] if isinstance(center, MultiValue) else center)
            w = float(width[0] if isinstance(width, MultiValue) else width)
            lo, hi = c - w / 2, c + w / 2
        else:
            lo, hi = float(np.percentile(arr, 1)), float(np.percentile(arr, 99))
        arr = np.clip((arr - lo) / max(hi - lo, 1e-6), 0, 1) * 255
        if str(ds.get("PhotometricInterpretation", "")) == "MONOCHROME1":
            arr = 255 - arr
        img = Image.fromarray(arr.astype("uint8"))
        img.thumbnail((size, size))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001 — a thumbnail is optional
        return None
