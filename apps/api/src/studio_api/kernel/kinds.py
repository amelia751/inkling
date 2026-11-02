"""File kinds (todo6 §3 "File kinds"). The worker detects kinds from content; the kernel only
uses extensions for seed files, whose manifest already vouches for them, and for the
`supported` check of a task document.

Kinds: image, dicom, dicom-series, volume, video, waveform, slide, table, document, mask,
annotations, archive, unknown.
"""

from __future__ import annotations

from .tree import extension

BY_EXTENSION = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".dcm": "dicom",
    ".nii": "volume",
    ".nii.gz": "volume",
    ".nrrd": "volume",
    ".mha": "volume",
    ".mp4": "video",
    ".webm": "video",
    ".avi": "video",
    ".hea": "waveform",
    ".dat": "waveform",
    ".edf": "waveform",
    ".svs": "slide",
    ".dzi": "slide",
    ".csv": "table",
    ".tsv": "table",
    ".xlsx": "table",
    ".pdf": "document",
    ".docx": "document",
    ".txt": "document",
    ".md": "document",
    ".zip": "archive",
    ".tar": "archive",
    ".tar.gz": "archive",
    ".gz": "archive",
}

# What a Studio can open as an item today (the rest stays in Sources).
VIEWABLE = {"image", "dicom", "dicom-series", "volume", "video", "waveform", "slide", "mask"}

# Never uploaded: operating-system clutter.
JUNK_NAMES = {".ds_store", "thumbs.db", "desktop.ini"}
JUNK_DIRS = {"__macosx", ".git"}


def kind_from_extension(name: str) -> str:
    low = name.lower()
    if ("mask" in low or "seg" in low) and BY_EXTENSION.get(extension(name)) == "volume":
        return "mask"
    return BY_EXTENSION.get(extension(name), "unknown")


def is_junk(rel_path: str) -> bool:
    parts = [p.lower() for p in rel_path.split("/") if p]
    return bool(parts) and (parts[-1] in JUNK_NAMES or parts[-1].startswith("._") or any(p in JUNK_DIRS for p in parts[:-1]))


WFDB_SIGNAL_EXTS = (".mat", ".dat")


def wfdb_parts(nodes: list[tuple[str, object, str]]) -> dict[str, str]:
    """{signal node id: header node id} for (id, folder, name) triples: a `<record>.mat` or
    `<record>.dat` next to a `<record>.hea` in the same folder is that record's signal file (the
    file name a PhysioNet header names). Names are only compared, never stored or logged."""
    heads = {(folder, name[:-4]): nid for nid, folder, name in nodes if name.lower().endswith(".hea")}
    out: dict[str, str] = {}
    for nid, folder, name in nodes:
        stem, ext = name[:-4], name[-4:].lower()
        if ext in WFDB_SIGNAL_EXTS and (h := heads.get((folder, stem))):
            out[nid] = h
    return out


# MR sequence and reference-segmentation suffixes of a `<subject>_<sequence>` file stem (BraTS
# `BraTS2021_00621_flair.nii.gz`, ACDC `patient101_frame01_gt.nii.gz`): the one vocabulary the
# drop grouping and the task document's `subject` / `sequence` read.
MR_SEQUENCE_TOKENS = frozenset({"t1", "t1ce", "t1c", "t2", "flair", "pd", "dwi", "adc", "seg", "gt"})
SEG_TOKENS = frozenset({"seg", "gt"})
VOLUME_EXTS = (".nii.gz", ".nii")


def volume_stem(name: str) -> str | None:
    """`name` without `.nii` / `.nii.gz`, or None for any other file."""
    low = name.lower()
    for ext in VOLUME_EXTS:
        if low.endswith(ext):
            return name[: -len(ext)]
    return None


def subject_sequence(name: str) -> tuple[str, str | None] | None:
    """(subject, sequence) of a NIfTI file name: `<subject>_<sequence>` when the suffix is a known
    sequence token, else (stem, None). None for a file that isn't NIfTI."""
    stem = volume_stem(name)
    if stem is None:
        return None
    head, sep, tail = stem.rpartition("_")
    if sep and head and tail.lower() in MR_SEQUENCE_TOKENS:
        return head, tail.lower()
    return stem, None


def is_time_series(facts: dict | None) -> bool:
    """A volume with a time dimension (a 4D cine: NIfTI shape[3] > 1, `facts.frames`)."""
    try:
        return int((facts or {}).get("frames") or 0) > 1
    except (TypeError, ValueError):
        return False


def mask_volumes(nodes: list[tuple[str, object, str, str | None]]) -> dict[str, str]:
    """{mask node id: volume node id} for (id, folder, name, kind) quadruples: a reference
    segmentation `<subject>_seg` / `<subject>_gt` (kind `mask`) beside a volume of the same
    subject (same folder; the volume's stem is `<subject>` or `<subject>_…`) belongs with that
    volume. Names are only compared, never stored or logged."""
    vols = [(folder, stem, nid) for nid, folder, name, kind in nodes if kind == "volume" and (stem := volume_stem(name)) is not None]
    out: dict[str, str] = {}
    for nid, folder, name, kind in nodes:
        ss = subject_sequence(name) if kind == "mask" else None
        if not ss or ss[1] not in SEG_TOKENS:
            continue
        subject = ss[0]
        match = next((v for f, stem, v in vols if f == folder and (stem == subject or stem.startswith(subject + "_"))), None)
        if match is not None:
            out[nid] = match
    return out
