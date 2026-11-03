"""Imaging checks (todo17 D11): the kernel job `imaging.check`, run where the bytes are.

The kernel enqueues it when an import completes and when files are exported, with the files to
check (`{projectId, trigger, nodes: [{id, name, parentId}]}`). The worker reads each file through
the kernel (worker token, `GET /api/v1/worker/inspect/nodes/:id/content`) into scratch, runs:

- DICOM (pydicom), per series: InstanceNumber gaps and slice-position gaps
  (`dicom.series-incomplete`), uneven slice spacing or pixel spacing (`dicom.inconsistent-spacing`),
  mixed orientations (`dicom.inconsistent-orientation`), and SEG / SR whose frame of reference or
  referenced series doesn't match the source series in the same check (`dicom.seg-frame-mismatch`).
  `dciodvfy`, when it is on PATH, adds `dicom.conformance` (error count only).
- NIfTI (nibabel), per file: qform / sform disagreement (`nifti.orientation-mismatch`), zero,
  negative or non-finite voxel sizes (`nifti.voxel-size`), NaN voxels (`nifti.nan`), and a
  mask / segmentation whose grid differs from its image (`nifti.grid-mismatch`; the image is the
  file in the same folder whose name is the mask's minus a `_seg`/`_mask`/`_label` suffix).

It reports codes, counts, node ids, series keys (the opaque `series_uid_hash`) and DICOM field
names only, never a header or pixel value (PHI), to `POST /api/v1/service/projects/:id/findings`;
the kernel applies the project's severities (`rules.imaging.checks`) and resolves findings a
later check no longer reports. Scratch files are deleted after each file.
"""

from __future__ import annotations

import gzip
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from .inspect.dicom import uid_hash

log = logging.getLogger("studio_worker.imaging")

TOOL = "imaging.check"
MAX_BYTES = 1 << 30  # bigger files are skipped (counted in the result, not checked)

# Default severities; the kernel re-resolves them against the project's rules. Mirrors
# packages/contracts/src/lint-rules.ts.
DEFAULTS = {
    "dicom.series-incomplete": "warn",
    "dicom.inconsistent-spacing": "warn",
    "dicom.inconsistent-orientation": "warn",
    "dicom.seg-frame-mismatch": "error",
    "dicom.conformance": "info",
    "nifti.orientation-mismatch": "warn",
    "nifti.voxel-size": "error",
    "nifti.nan": "warn",
    "nifti.grid-mismatch": "error",
}
FIX = {
    "dicom.series-incomplete": "Upload the missing instances, or remove the partial series.",
    "dicom.inconsistent-spacing": "Check the series for missing or duplicated slices, or resample it to even spacing.",
    "dicom.inconsistent-orientation": "Split the series: its slices belong to more than one volume.",
    "dicom.seg-frame-mismatch": "Regenerate the segmentation against the referenced series.",
    "dicom.conformance": "Fix the attributes dciodvfy reports, or re-export from the source system.",
    "nifti.orientation-mismatch": "Rewrite the header with one consistent affine (qform = sform).",
    "nifti.voxel-size": "Set positive voxel sizes (pixdim) in the header.",
    "nifti.nan": "Replace NaN voxels (e.g. with 0) before labelling or training.",
    "nifti.grid-mismatch": "Resample the mask onto the image grid (same shape and affine).",
}
CODES = tuple(DEFAULTS)
NIFTI_SUFFIX = (".nii", ".nii.gz")
MASK_SUFFIX = re.compile(r"[_-](seg|segmentation|mask|label|labels)$", re.I)
SEG_SOP = {"1.2.840.10008.5.1.4.1.1.66.4"}  # Segmentation Storage
SR_PREFIX = "1.2.840.10008.5.1.4.1.1.88."


def violation(rule: str, path: str, message: str) -> dict:
    return {"rule": rule, "severity": DEFAULTS[rule], "path": path, "message": message, "fix": FIX[rule]}


@dataclass
class Slice:
    node_id: str
    instance: int | None = None
    position: tuple[float, ...] | None = None
    orientation: tuple[float, ...] | None = None
    pixel_spacing: tuple[float, ...] | None = None
    frame_of_reference: str = ""


@dataclass
class Series:
    key: str  # series_uid_hash: opaque, never the UID
    uid: str
    frame_of_reference: str = ""
    sop_class: str = ""
    slices: list[Slice] = field(default_factory=list)
    referenced: list[str] = field(default_factory=list)  # UIDs of series a SEG/SR points at
    conformance_errors: int = 0


# ---- DICOM ---------------------------------------------------------------------------------


def _vec(v: Any) -> tuple[float, ...] | None:
    try:
        out = tuple(float(x) for x in v)
        return out or None
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _referenced_series(ds: Any) -> list[str]:
    """SeriesInstanceUIDs a SEG or SR references (ReferencedSeriesSequence, directly or under
    CurrentRequestedProcedureEvidenceSequence / the SR evidence sequences)."""
    out: list[str] = []

    def walk(items: Iterable[Any]) -> None:
        for it in items or []:
            uid = str(it.get("SeriesInstanceUID") or "")
            if uid:
                out.append(uid)

    walk(ds.get("ReferencedSeriesSequence") or [])
    for seq in ("CurrentRequestedProcedureEvidenceSequence", "PertinentOtherEvidenceSequence", "StudiesContainingOtherReferencedInstancesSequence"):
        for study in ds.get(seq) or []:
            walk(study.get("ReferencedSeriesSequence") or [])
    return list(dict.fromkeys(out))


def add_dicom(series: dict[str, Series], node_id: str, ds: Any) -> bool:
    """Add one dataset's header facts to its series; False when it has no series UID."""
    g = ds.get
    uid = str(g("SeriesInstanceUID") or "")
    if not uid:
        return False
    s = series.get(uid)
    if s is None:
        s = series[uid] = Series(uid_hash(uid), uid)
    s.sop_class = s.sop_class or str(g("SOPClassUID") or "")
    s.frame_of_reference = s.frame_of_reference or str(g("FrameOfReferenceUID") or "")
    s.referenced = list(dict.fromkeys([*s.referenced, *_referenced_series(ds)]))
    s.slices.append(Slice(node_id, _int(g("InstanceNumber")), _vec(g("ImagePositionPatient")), _vec(g("ImageOrientationPatient")), _vec(g("PixelSpacing")), str(g("FrameOfReferenceUID") or "")))
    return True


def _is_derived(s: Series) -> bool:
    return s.sop_class in SEG_SOP or s.sop_class.startswith(SR_PREFIX)


def _close(a: tuple[float, ...], b: tuple[float, ...], tol: float = 1e-3) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b, strict=True))


def _distinct(vals: Iterable[tuple[float, ...]], tol: float = 1e-3) -> list[tuple[float, ...]]:
    out: list[tuple[float, ...]] = []
    for v in vals:
        if not any(_close(v, o, tol) for o in out):
            out.append(v)
    return out


def _normal(o: tuple[float, ...]) -> tuple[float, float, float]:
    r, c = o[:3], o[3:6]
    return (r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0])


def check_series(s: Series) -> list[dict]:
    out: list[dict] = []
    if _is_derived(s):
        return out
    numbers = [x.instance for x in s.slices if x.instance is not None]
    if len(numbers) > 1:
        have = set(numbers)
        missing = sum(1 for n in range(min(numbers), max(numbers) + 1) if n not in have)
        if missing:
            out.append(violation("dicom.series-incomplete", "/InstanceNumber", f"{missing} of {max(numbers) - min(numbers) + 1} instances missing (InstanceNumber gaps) in a series of {len(s.slices)} files"))
    orients = _distinct([x.orientation for x in s.slices if x.orientation and len(x.orientation) == 6])
    if len(orients) > 1:
        out.append(violation("dicom.inconsistent-orientation", "/ImageOrientationPatient", f"Slices have {len(orients)} different orientations"))
    pix = _distinct([x.pixel_spacing for x in s.slices if x.pixel_spacing])
    if len(pix) > 1:
        out.append(violation("dicom.inconsistent-spacing", "/PixelSpacing", f"Slices have {len(pix)} different pixel spacings"))
    if len(orients) == 1 and len(s.slices) > 2:
        n = _normal(orients[0])
        dist = sorted(sum(p * q for p, q in zip(x.position, n, strict=False)) for x in s.slices if x.position and len(x.position) == 3)
        steps = [b - a for a, b in zip(dist, dist[1:], strict=False)]
        steps = [d for d in steps if d > 1e-4]  # duplicates are not gaps
        if len(steps) > 1:
            base = sorted(steps)[len(steps) // 2]
            gaps = sum(round(d / base) - 1 for d in steps if base > 0 and d > base * 1.5)
            uneven = sum(1 for d in steps if base > 0 and abs(d - base) > max(0.01 * base, 1e-3) and d <= base * 1.5)
            if gaps and not any(v["rule"] == "dicom.series-incomplete" for v in out):
                out.append(violation("dicom.series-incomplete", "/ImagePositionPatient", f"{gaps} slice{'s' if gaps != 1 else ''} missing (position gaps) in a series of {len(s.slices)} files"))
            if gaps or uneven:
                out.append(violation("dicom.inconsistent-spacing", "/ImagePositionPatient", f"{gaps + uneven} of {len(steps)} slice steps differ from the series' spacing"))
    if s.conformance_errors:
        out.append(violation("dicom.conformance", "/", f"dciodvfy reported {s.conformance_errors} error{'s' if s.conformance_errors != 1 else ''}"))
    return out


def check_references(s: Series, by_uid: dict[str, Series]) -> list[dict]:
    """A SEG / SR against the source series it references, when that series was checked too."""
    if not _is_derived(s):
        return []
    if s.sop_class in SEG_SOP and not s.referenced:
        return [violation("dicom.seg-frame-mismatch", "/ReferencedSeriesSequence", "The segmentation references no source series")]
    for src in (by_uid[u] for u in s.referenced if u in by_uid):
        if s.frame_of_reference and src.frame_of_reference and s.frame_of_reference != src.frame_of_reference:
            what = "segmentation" if s.sop_class in SEG_SOP else "report"
            return [violation("dicom.seg-frame-mismatch", "/FrameOfReferenceUID", f"The {what}'s frame of reference differs from its referenced series")]
    return []


def check_dicom(series: dict[str, Series]) -> list[dict]:
    """→ [{resourceKind: "series", resourceId: <series_uid_hash>, nodeIds, violations}] for every
    series (empty violations too, so the kernel resolves what a later check no longer finds)."""
    results = []
    for s in series.values():
        vs = check_series(s) + check_references(s, series)
        results.append({"resourceKind": "series", "resourceId": s.key, "nodeIds": [x.node_id for x in s.slices], "violations": vs})
    return results


def dciodvfy_errors(path: str, exe: str | None = None) -> int | None:
    """Error lines from dciodvfy (None when it isn't installed or failed to run). Counts only:
    its output quotes attribute values."""
    exe = exe or shutil.which("dciodvfy")
    if not exe:
        return None
    try:
        r = subprocess.run([exe, "-new", path], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return sum(1 for line in (r.stderr + r.stdout).splitlines() if line.startswith("Error"))


# ---- NIfTI ---------------------------------------------------------------------------------


def is_nifti_name(name: str) -> bool:
    return name.lower().endswith(NIFTI_SUFFIX)


def nifti_stem(name: str) -> str:
    low = name.lower()
    for suf in (".nii.gz", ".nii"):
        if low.endswith(suf):
            return name[: -len(suf)]
    return name


def check_nifti(img: Any) -> list[dict]:
    import numpy as np

    out: list[dict] = []
    hdr = img.header
    ndim = int(hdr["dim"][0])
    pix = [float(x) for x in hdr["pixdim"][1 : 1 + min(max(ndim, 1), 3)]]
    bad = sum(1 for x in pix if not np.isfinite(x) or x <= 0)
    if bad:
        out.append(violation("nifti.voxel-size", "/pixdim", f"{bad} of {len(pix)} spatial voxel sizes are zero, negative or not finite"))
    qcode, scode = int(hdr["qform_code"]), int(hdr["sform_code"])
    if qcode > 0 and scode > 0:
        try:
            q, s = hdr.get_qform(), hdr.get_sform()
        except Exception:  # noqa: BLE001 — nibabel refuses a qform with negative pixdim (reported above)
            q = s = None
        if q is not None and s is not None and not np.allclose(q, s, atol=1e-3):
            out.append(violation("nifti.orientation-mismatch", "/qform", "qform and sform describe different affines"))
    if np.issubdtype(hdr.get_data_dtype(), np.floating) or float(hdr["scl_slope"] or 0) not in (0.0, 1.0):
        data = np.asanyarray(img.dataobj)
        if np.issubdtype(data.dtype, np.floating):
            nans = int(np.isnan(data).sum())
            if nans:
                out.append(violation("nifti.nan", "/data", f"{nans} of {data.size} voxels are NaN"))
    return out


def check_grid(mask: Any, image: Any) -> list[dict]:
    import numpy as np

    if tuple(mask.shape[:3]) != tuple(image.shape[:3]):
        return [violation("nifti.grid-mismatch", "/dim", "The mask's shape differs from its image's")]
    if not np.allclose(mask.affine, image.affine, atol=1e-3):
        return [violation("nifti.grid-mismatch", "/affine", "The mask's affine differs from its image's")]
    return []


def pair_masks(nodes: list[dict]) -> dict[str, str]:
    """mask node id → image node id, for NIfTI files in the same folder named `<stem>` and
    `<stem>_seg|_mask|_label…`."""
    by: dict[tuple[Any, str], str] = {}
    for n in nodes:
        if is_nifti_name(str(n.get("name") or "")):
            by[(n.get("parentId"), nifti_stem(str(n["name"])).lower())] = n["id"]
    out = {}
    for n in nodes:
        name = str(n.get("name") or "")
        if not is_nifti_name(name):
            continue
        stem = nifti_stem(name)
        m = MASK_SUFFIX.search(stem)
        if m:
            image = by.get((n.get("parentId"), stem[: m.start()].lower()))
            if image and image != n["id"]:
                out[n["id"]] = image
    return out


# ---- The job -------------------------------------------------------------------------------


def _looks_dicom(path: str) -> bool:
    with open(path, "rb") as fh:
        head = fh.read(132)
    return head[128:132] == b"DICM"


def _looks_nifti(path: str, name: str) -> bool:
    if is_nifti_name(name):
        return True
    with open(path, "rb") as fh:
        head = fh.read(348)
    if head[:2] == b"\x1f\x8b":
        try:
            with gzip.open(path, "rb") as g:
                head = g.read(348)
        except OSError:
            return False
    return (len(head) >= 348 and head[344:347] in (b"n+1", b"ni1")) or head[4:8] == b"n+2\x00"


class ImagingCheck:
    def __init__(self, http: httpx.Client, scratch: Path | None = None, dciodvfy: str | None = None):
        self.http = http
        self.scratch = scratch or Path(tempfile.gettempdir())
        self.dciodvfy = dciodvfy if dciodvfy is not None else shutil.which("dciodvfy")

    def _fetch(self, nid: str, suffix: str = "") -> str | None:
        self.scratch.mkdir(parents=True, exist_ok=True)
        fd, path = tempfile.mkstemp(dir=self.scratch, prefix="imaging-", suffix=suffix)
        size = 0
        try:
            with os.fdopen(fd, "wb") as fh, self.http.stream("GET", f"/api/v1/worker/inspect/nodes/{nid}/content", timeout=600) as r:
                if r.status_code == 404:
                    os.unlink(path)
                    return None
                r.raise_for_status()
                for chunk in r.iter_bytes(1 << 20):
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError("too big")
                    fh.write(chunk)
        except (ValueError, httpx.HTTPError):
            if os.path.exists(path):
                os.unlink(path)
            raise
        return path

    def run(self, job_input: dict, on_progress: Callable[[float], None] | None = None) -> dict:
        import nibabel as nib
        import pydicom
        from pydicom.errors import InvalidDicomError

        pid = str(job_input.get("projectId") or "")
        nodes = [n for n in job_input.get("nodes") or [] if isinstance(n, dict) and n.get("id")]
        series: dict[str, Series] = {}
        nifti_results: list[dict] = []
        images: dict[str, Any] = {}  # node id → nibabel image (header + lazy data), for grid pairs
        masks = pair_masks(nodes)
        wanted = set(masks.values()) | set(masks)
        skipped = 0
        for i, n in enumerate(nodes):
            nid, name = str(n["id"]), str(n.get("name") or "")
            suffix = ".nii.gz" if name.lower().endswith(".nii.gz") else ".nii" if name.lower().endswith(".nii") else ""
            try:
                path = self._fetch(nid, suffix)
            except (ValueError, httpx.HTTPError):
                skipped += 1
                continue
            if path is None:
                continue
            try:
                if _looks_dicom(path):
                    try:
                        ds = pydicom.dcmread(path, stop_before_pixels=True)
                    except (InvalidDicomError, EOFError, OSError, ValueError, AttributeError, KeyError, TypeError):
                        skipped += 1
                        continue
                    if add_dicom(series, nid, ds) and self.dciodvfy:
                        errs = dciodvfy_errors(path, self.dciodvfy)
                        if errs:
                            series[str(ds.get("SeriesInstanceUID"))].conformance_errors += errs
                elif _looks_nifti(path, name):
                    try:
                        img: Any = nib.load(path)
                        vs = check_nifti(img)
                    except Exception:  # noqa: BLE001 — unreadable: not ours to judge here
                        skipped += 1
                        continue
                    if nid in wanted:
                        images[nid] = (img.shape, img.affine)
                    nifti_results.append({"resourceKind": "file", "resourceId": nid, "nodeIds": [nid], "violations": vs})
            finally:
                if os.path.exists(path):
                    os.unlink(path)
            if on_progress:
                on_progress((i + 1) / max(len(nodes), 1))
        for r in nifti_results:
            image = masks.get(r["resourceId"])
            if image and r["resourceId"] in images and image in images:
                (ms, ma), (is_, ia) = images[r["resourceId"]], images[image]
                r["violations"] += check_grid(_Grid(ms, ma), _Grid(is_, ia))
        results = check_dicom(series) + nifti_results
        counts: dict[str, int] = {}
        for r in results:
            for v in r["violations"]:
                counts[v["rule"]] = counts.get(v["rule"], 0) + 1
        if pid and results:
            resp = self.http.post(f"/api/v1/service/projects/{pid}/findings", json={"source": "scan", "checked": list(CODES), "results": results, "trigger": job_input.get("trigger")})
            resp.raise_for_status()
        return {"files": len(nodes), "series": len(series), "nifti": len(nifti_results), "skipped": skipped, "findings": counts, "dciodvfy": bool(self.dciodvfy)}


@dataclass
class _Grid:
    shape: tuple[int, ...]
    affine: Any

