"""Synthetic DICOM fixtures for the Cornerstone viewer tests (never written into seed-data/).

    uv run --with pydicom --with numpy --with pillow python e2e/dicom_fixtures.py OUT_DIR

Writes
  OUT_DIR/cr/cr1.dcm           2D DX radiograph (from a seed JPEG), PixelSpacing 0.15 mm
  OUT_DIR/ct/IM0001..IM0040.dcm CT phantom, 128×128×40, 1.5×1.5 mm, 2.5 mm slices, HU via rescale
  OUT_DIR/manifest.json        the phantom's geometry and HU regions, for test assertions
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pydicom
from PIL import Image
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

ROOT = Path(__file__).resolve().parents[3]
UID_PREFIX = "1.2.826.0.1.3680043.10.1394."  # pydicom-style prefix for test data


def uid(seed: str) -> str:
    return generate_uid(prefix=UID_PREFIX, entropy_srcs=[seed])


def base(sop_class: str, sop_uid: str, modality: str) -> FileDataset:
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = uid("inkling-impl")
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    ds.Modality = modality
    ds.PatientName = "Phantom^Inkling"
    ds.PatientID = "INK-0001"
    ds.PatientBirthDate = ""
    ds.PatientSex = "O"
    ds.StudyDate = ds.SeriesDate = ds.ContentDate = "20261029"
    ds.StudyTime = ds.SeriesTime = ds.ContentTime = "120000"
    ds.AccessionNumber = "INK1"
    ds.ReferringPhysicianName = ""
    ds.StudyID = "1"
    ds.Manufacturer = "Inkling test fixtures"
    return ds


def make_cr(out: Path) -> dict:
    src = ROOT / "seed-data/2d-xray/normal/IM-0001-0001.jpeg"
    img = np.asarray(Image.open(src).convert("L"), dtype=np.uint8)
    rows, cols = img.shape
    ds = base("1.2.840.10008.5.1.4.1.1.1.1", uid("cr-sop"), "DX")
    ds.StudyInstanceUID = uid("cr-study")
    ds.SeriesInstanceUID = uid("cr-series")
    ds.FrameOfReferenceUID = uid("cr-for")
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.PresentationIntentType = "FOR PRESENTATION"
    ds.ImageType = ["ORIGINAL", "PRIMARY"]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows, ds.Columns = rows, cols
    ds.BitsAllocated = 8
    ds.BitsStored = 8
    ds.HighBit = 7
    ds.PixelRepresentation = 0
    ds.PixelSpacing = [0.15, 0.15]
    ds.ImagerPixelSpacing = [0.15, 0.15]
    ds.WindowCenter = 128
    ds.WindowWidth = 256
    ds.PixelData = img.tobytes()
    (out / "cr").mkdir(parents=True, exist_ok=True)
    ds.save_as(out / "cr/cr1.dcm", enforce_file_format=True)
    return {"rows": rows, "columns": cols, "pixelSpacing": 0.15, "studyUID": ds.StudyInstanceUID, "seriesUID": ds.SeriesInstanceUID}


def make_ct(out: Path) -> dict:
    nx = ny = 128
    nz = 40
    px, dz = 1.5, 2.5
    x = (np.arange(nx) - nx / 2 + 0.5) * px
    y = (np.arange(ny) - ny / 2 + 0.5) * px
    z = (np.arange(nz) - nz / 2 + 0.5) * dz
    Z, Y, X = np.meshgrid(z, y, x, indexing="ij")
    hu = np.full((nz, ny, nx), -1000, dtype=np.int16)
    body = X**2 + Y**2 <= 80**2
    hu[body] = 0  # water
    bone = (X - 30) ** 2 + Y**2 + Z**2 <= 15**2
    hu[bone] = 700
    lesion = (X + 30) ** 2 + (Y - 10) ** 2 + Z**2 <= 12**2
    hu[lesion] = 60
    stored = (hu.astype(np.int32) + 1024).astype(np.uint16)
    study, series, for_uid = uid("ct-study"), uid("ct-series"), uid("ct-for")
    (out / "ct").mkdir(parents=True, exist_ok=True)
    origin = [float(-nx / 2 * px + px / 2), float(-ny / 2 * px + px / 2)]
    for k in range(nz):
        ds = base("1.2.840.10008.5.1.4.1.1.2", uid(f"ct-sop-{k}"), "CT")
        ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series, for_uid
        ds.SeriesNumber = 2
        ds.SeriesDescription = "Inkling CT phantom"
        ds.InstanceNumber = k + 1
        ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
        ds.ImagePositionPatient = [origin[0], origin[1], float(z[k])]
        ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
        ds.SliceThickness = dz
        ds.SpacingBetweenSlices = dz
        ds.SliceLocation = float(z[k])
        ds.PixelSpacing = [px, px]
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.Rows, ds.Columns = ny, nx
        ds.BitsAllocated = 16
        ds.BitsStored = 16
        ds.HighBit = 15
        ds.PixelRepresentation = 0
        ds.RescaleIntercept = -1024
        ds.RescaleSlope = 1
        ds.RescaleType = "HU"
        ds.WindowCenter = 40
        ds.WindowWidth = 400
        ds.KVP = 120
        ds.PixelData = stored[k].tobytes()
        ds.save_as(out / f"ct/IM{k + 1:04d}.dcm", enforce_file_format=True)
    return {
        "dims": [nx, ny, nz],
        "spacing": [px, px, dz],
        "studyUID": study,
        "seriesUID": series,
        "frameOfReferenceUID": for_uid,
        "hu": {"air": -1000, "water": 0, "bone": 700, "lesion": 60},
        # Centres in world (LPS) mm.
        "bone": {"center": [30, 0, 0], "radius": 15},
        "lesion": {"center": [-30, 10, 0], "radius": 12},
    }


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "e2e/.artifacts/dicom").resolve()
    out.mkdir(parents=True, exist_ok=True)
    info = {"cr": make_cr(out), "ct": make_ct(out)}
    (out / "manifest.json").write_text(json.dumps(info, indent=2))
    print(f"wrote fixtures to {out} (pydicom {pydicom.__version__})")


if __name__ == "__main__":
    main()
