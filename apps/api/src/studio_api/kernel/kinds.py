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
JUNK_DIRS = {"__macosx"}


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
