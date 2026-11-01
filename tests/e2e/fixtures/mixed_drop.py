"""Synthetic mixed-drop fixtures for the todo13 journeys (§5: "add mixed-drop fixtures").

    uv run --package studio-worker python tests/e2e/fixtures/mixed_drop.py OUT_DIR

Nothing here is real data: pixels are gradients, DICOM headers are made up, names are invented.
Written fresh on every run (no binaries in the repo). Writes, under OUT_DIR:

  pngs/cxr_000.png … cxr_029.png   30 small grayscale PNGs (J1, J3, J6)
  ct/IM0001.dcm … IM0008.dcm       one CT series, 8 slices 32×32 (J4)
  mixed/protocol.pdf               a one-page PDF (J5: kept as reference)
  mixed/more-xrays.zip             a ZIP of 4 PNGs (J5: unpacked and added)
  mixed/voice-memo.mp3             an MP3 frame (J5: kept, "Find a plugin")
  mixed/labels.csv                 a CSV keyed by the PNGs' file names (J5: asked as labels table)
  duplicate/copy-of-cxr_000.png    the same bytes as pngs/cxr_000.png (J6: "Already in Files")
  identifier/Smith_John_1962-04-03.dcm  a DICOM with an identifier-like name (J7)
  manifest.json                    what each fixture is, for the test's assertions

`png()` is importable without pydicom (the journeys make thousands of PNGs in memory for J8).
"""

from __future__ import annotations

import io
import json
import struct
import sys
import zipfile
import zlib
from pathlib import Path

IDENTIFIER_NAME = "Smith_John_1962-04-03.dcm"


def png(seed: int, w: int = 24, h: int = 16) -> bytes:
    """A distinct grayscale PNG per seed (different bytes, so different SHA-256)."""
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3 + seed * 13) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    text = chunk(b"tEXt", b"seed\x00" + str(seed).encode())
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + text + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def pdf() -> bytes:
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>"]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


def mp3() -> bytes:
    """An ID3v2 header and a few MPEG-1 Layer III frames of silence."""
    id3 = b"ID3\x04\x00\x00\x00\x00\x00\x00"
    frame = b"\xff\xfb\x90\x64" + b"\x00" * 413
    return id3 + frame * 4


def zip_of_pngs(seeds: list[int]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for s in seeds:
            z.writestr(f"more-xrays/xr_{s:03d}.png", png(s))
    return buf.getvalue()


def labels_csv(names: list[str]) -> bytes:
    rows = ["file,label"] + [f"{n},{'normal' if i % 2 else 'pneumonia'}" for i, n in enumerate(names)]
    return ("\n".join(rows) + "\n").encode()


def dicom(path: Path, *, modality: str, series: str, index: int, rows: int = 32, cols: int = 32) -> None:
    import numpy as np
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    prefix = "1.2.826.0.1.3680043.10.1394."
    uid = lambda seed: generate_uid(prefix=prefix, entropy_srcs=[seed])  # noqa: E731
    sop_class = "1.2.840.10008.5.1.4.1.1.2" if modality == "CT" else "1.2.840.10008.5.1.4.1.1.1.1"
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = uid(f"{series}-{index}")
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = uid("journey-impl")
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = modality
    ds.PatientName = "Synthetic^Phantom"
    ds.PatientID = "SYNTH-0001"
    ds.StudyInstanceUID = uid(f"{series}-study")
    ds.SeriesInstanceUID = uid(series)
    ds.SeriesNumber = 1
    ds.InstanceNumber = index + 1
    ds.Rows, ds.Columns = rows, cols
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit, ds.PixelRepresentation = 16, 16, 15, 1
    ds.PixelSpacing = [1.0, 1.0]
    if modality == "CT":
        ds.SliceThickness = 2.5
        ds.ImagePositionPatient = [0.0, 0.0, 2.5 * index]
        ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        ds.RescaleIntercept, ds.RescaleSlope = -1024, 1
    y, x = np.mgrid[0:rows, 0:cols]
    ds.PixelData = (((x + y + index * 3) % 64) * 16).astype(np.int16).tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    pydicom.dcmwrite(str(path), ds, enforce_file_format=True)


def build(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    pngs = [f"cxr_{i:03d}.png" for i in range(30)]
    (out / "pngs").mkdir(exist_ok=True)
    for i, n in enumerate(pngs):
        (out / "pngs" / n).write_bytes(png(i))
    ct = [f"IM{i + 1:04d}.dcm" for i in range(8)]
    for i, n in enumerate(ct):
        dicom(out / "ct" / n, modality="CT", series="journey-ct", index=i)
    (out / "mixed").mkdir(exist_ok=True)
    (out / "mixed" / "protocol.pdf").write_bytes(pdf())
    (out / "mixed" / "more-xrays.zip").write_bytes(zip_of_pngs([100, 101, 102, 103]))
    (out / "mixed" / "voice-memo.mp3").write_bytes(mp3())
    (out / "mixed" / "labels.csv").write_bytes(labels_csv(pngs))
    (out / "duplicate").mkdir(exist_ok=True)
    (out / "duplicate" / "copy-of-cxr_000.png").write_bytes(png(0))
    dicom(out / "identifier" / IDENTIFIER_NAME, modality="DX", series="journey-dx", index=0, rows=24, cols=24)
    manifest = {
        "pngs": pngs,
        "ct": ct,
        "mixed": {"protocol.pdf": "document", "more-xrays.zip": "archive", "voice-memo.mp3": "unknown", "labels.csv": "table"},
        "zipEntries": 4,
        "duplicate": {"copy-of-cxr_000.png": "pngs/cxr_000.png"},
        "identifier": IDENTIFIER_NAME,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(json.dumps(build(Path(sys.argv[1]))))
