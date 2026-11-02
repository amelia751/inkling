"""Content-based kind detection (todo6 §3 "File kinds"). Extensions are a tie-breaker only:
the bytes decide. Kinds: image, dicom, volume, video, waveform, slide, table, document,
mask, annotations, archive, unknown (a DICOM series is a *group* of `dicom` files, made by
`dicom.group_series`, never a kind of one file).
"""

from __future__ import annotations

import gzip
import io
import json
import posixpath
import struct
import zipfile

IMAGE_MAGIC = [
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"GIF87a", "GIF"),
    (b"GIF89a", "GIF"),
    (b"BM", "BMP"),
]
TIFF_MAGIC = (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")
DOUBLE_EXT = (".nii.gz", ".tar.gz", ".ome.tif", ".ome.tiff")
TEXT_EXT = {".txt", ".md", ".rst", ".log"}
TABLE_EXT = {".csv", ".tsv", ".tab"}


def extension(name: str) -> str:
    low = name.lower()
    for ext in DOUBLE_EXT:
        if low.endswith(ext):
            return ext
    return posixpath.splitext(low)[1]


def _text(head: bytes) -> str | None:
    """The head as text, if it is text (UTF-8, or a single-byte encoding with no NULs)."""
    if not head:
        return ""
    if b"\x00" in head[:8192]:
        return None
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return head.decode(enc)
        except UnicodeDecodeError:
            # A multi-byte character cut at the end of the head is still UTF-8.
            if enc == "utf-8-sig":
                try:
                    return head[:-4].decode(enc) if len(head) > 4 else None
                except UnicodeDecodeError:
                    continue
    return None


def _looks_tabular(text: str) -> bool:
    import csv

    lines = [line for line in text.splitlines()[:30] if line.strip()]
    if len(lines) < 2:
        return False
    try:
        dialect = csv.Sniffer().sniff("\n".join(lines[:20]), delimiters=",;\t|")
    except csv.Error:
        return False
    widths = {len(r) for r in csv.reader(io.StringIO("\n".join(lines[:20])), dialect)}
    return min(widths) >= 2 and len(widths) <= 2


def _nifti(head: bytes) -> bool:
    if len(head) < 348:
        return False
    for order in ("<", ">"):
        if struct.unpack(f"{order}i", head[:4])[0] in (348, 540):
            return head[344:348] in (b"n+1\x00", b"ni1\x00") or head[4:8] in (b"n+2\x00", b"ni2\x00")
    return False


def _zip_kind(name: str, data: bytes | None) -> str:
    """docx/xlsx are zips; tell them apart by their members when we have the bytes."""
    ext = extension(name)
    if data is not None:
        try:
            names = zipfile.ZipFile(io.BytesIO(data)).namelist()
        except zipfile.BadZipFile:
            names = []
        if any(n.startswith("word/") for n in names):
            return "document"
        if any(n.startswith("xl/") for n in names):
            return "table"
        if names:
            return "archive"
    return {".docx": "document", ".xlsx": "table"}.get(ext, "archive")


def detect(name: str, head: bytes, full: bytes | None = None) -> tuple[str, dict]:
    """(kind, format facts) from the first bytes (≥ 64 KB when the file is that big), and the
    whole file for formats whose answer is at the end (zip). Never raises."""
    ext = extension(name)
    low = name.lower()
    fmt: dict = {}
    if len(head) >= 132 and head[128:132] == b"DICM":
        return "dicom", {"format": "DICOM"}
    for magic, label in IMAGE_MAGIC:
        if head.startswith(magic):
            return "image", {"format": label}
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image", {"format": "WebP"}
    if head[:4] in TIFF_MAGIC:
        if ext in (".svs", ".ome.tif", ".ome.tiff", ".ndpi", ".scn") or b"Aperio" in head[:65536]:
            return "slide", {"format": "SVS" if ext == ".svs" or b"Aperio" in head else "OME-TIFF"}
        return "image", {"format": "TIFF"}
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return "video", {"format": "AVI"}
    if head[4:8] == b"ftyp":
        brand = head[8:12].decode("latin-1", "replace").strip()
        return "video", {"format": "QuickTime" if brand == "qt" else "MP4"}
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video", {"format": "WebM" if b"webm" in head[:64] else "Matroska"}
    if head.startswith(b"%PDF-"):
        return "document", {"format": "PDF"}
    if _nifti(head):
        return _mask_hint(low, "volume"), {"format": "NIfTI"}
    if head.startswith(b"\x1f\x8b"):
        try:
            inner = gzip.GzipFile(fileobj=io.BytesIO(head)).read(400)
        except (OSError, EOFError):
            inner = b""
        if _nifti(inner) or (ext == ".nii.gz" and len(inner) < 348):
            return _mask_hint(low, "volume"), {"format": "NIfTI", "compressed": True}
        return "archive", {"format": "TAR.GZ" if ext == ".tar.gz" or inner[257:262] == b"ustar" else "GZIP"}
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06"):
        kind = _zip_kind(name, full)
        return kind, {"format": {"document": "DOCX", "table": "XLSX"}.get(kind, "ZIP")}
    if len(head) > 262 and head[257:262] == b"ustar":
        return "archive", {"format": "TAR"}
    if head.startswith(b"NRRD000"):
        return _mask_hint(low, "volume"), {"format": "NRRD"}
    # EDF: an ASCII header whose first 8 bytes are the version "0" padded with spaces.
    if head[:8] == b"0       " and len(head) >= 256 and head[184:192].strip().isdigit():
        return "waveform", {"format": "EDF"}
    text = _text(head)
    if text is None:
        return "unknown", fmt
    stripped = text.lstrip()
    if stripped.startswith("ObjectType") and "ElementDataFile" in text:
        return _mask_hint(low, "volume"), {"format": "MetaImage"}
    if ext == ".hea" or _wfdb_header(text):
        return "waveform", {"format": "WFDB header"}
    if stripped.startswith(("{", "[")):
        kind = _json_kind(text, full)
        if kind:
            return kind
        return ("document", {"format": "JSON"})
    if stripped.startswith("<"):
        if "<Image" in text and "deepzoom" in text.lower():
            return "slide", {"format": "DZI"}
        if "<annotation" in text and "<object" in text:
            return "annotations", {"format": "Pascal VOC"}
        return "document", {"format": "XML"}
    if ext in TABLE_EXT or (ext not in TEXT_EXT and _looks_tabular(text)):
        if _looks_tabular(text) or ext in TABLE_EXT:
            return "table", {"format": "TSV" if ext == ".tsv" or "\t" in text.split("\n", 1)[0] else "CSV"}
    return "document", {"format": "Markdown" if ext == ".md" else "Text"}


def _mask_hint(low_name: str, kind: str) -> str:
    """A `mask`/`seg`/`label` name is a hint only; `media.volume_facts` confirms it from voxels."""
    stem = posixpath.basename(low_name)
    return "mask" if any(h in stem for h in ("mask", "seg", "label")) else kind


def _wfdb_header(text: str) -> bool:
    """`<record> <signals> <freq> <samples>` then one line per signal naming a `.dat` or `.mat`
    file (PTB-XL and PhysioNet 2020 store signals as `.mat`, todo19 §2 A)."""
    lines = [line for line in text.splitlines() if line.strip() and not line.startswith("#")]
    if len(lines) < 2:
        return False
    first = lines[0].split()
    return len(first) >= 2 and first[1].isdigit() and any(line.split()[0].lower().endswith((".dat", ".mat")) for line in lines[1:3] if line.split())


def _json_kind(text: str, full: bytes | None) -> tuple[str, dict] | None:
    try:
        doc = json.loads(full.decode("utf-8-sig") if full is not None else text)
    except (ValueError, UnicodeDecodeError):
        # A head cut mid-document: shape from the keys we can see.
        if '"images"' in text and '"annotations"' in text:
            return "annotations", {"format": "COCO"}
        if '"FeatureCollection"' in text:
            return "annotations", {"format": "GeoJSON"}
        return None
    if isinstance(doc, dict):
        if isinstance(doc.get("images"), list) and isinstance(doc.get("annotations"), list):
            return "annotations", {"format": "COCO"}
        if doc.get("type") == "FeatureCollection":
            return "annotations", {"format": "GeoJSON"}
    return None
