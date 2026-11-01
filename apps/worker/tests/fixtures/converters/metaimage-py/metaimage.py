"""MetaImage (.mha) → NIfTI-1 (.nii.gz). Inline data only (ElementDataFile = LOCAL)."""

import zlib
from pathlib import Path

import nibabel as nib
import numpy as np

TYPES = {"MET_UCHAR": np.uint8, "MET_CHAR": np.int8, "MET_USHORT": np.uint16, "MET_SHORT": np.int16, "MET_UINT": np.uint32, "MET_INT": np.int32, "MET_FLOAT": np.float32, "MET_DOUBLE": np.float64}


def parse_header(raw: bytes) -> tuple[dict, int]:
    fields, pos = {}, 0
    while True:
        end = raw.index(b"\n", pos)
        key, _, value = raw[pos:end].decode("ascii").partition("=")
        fields[key.strip()] = value.strip()
        pos = end + 1
        if key.strip() == "ElementDataFile":
            return fields, pos


def convert(src: Path, out: Path, options: dict) -> dict:
    raw = src.read_bytes()
    h, offset = parse_header(raw)
    if h.get("ElementDataFile") != "LOCAL":
        raise ValueError("only inline data")
    dims = [int(x) for x in h["DimSize"].split()]
    spacing = [float(x) for x in h.get("ElementSpacing", " ".join(["1"] * len(dims))).split()]
    dtype = np.dtype(TYPES[h["ElementType"]]).newbyteorder(">" if h.get("BinaryDataByteOrderMSB", "False") == "True" else "<")
    data = raw[offset:]
    if h.get("CompressedData", "False") == "True":
        data = zlib.decompress(data)
    arr = np.frombuffer(data, dtype=dtype, count=int(np.prod(dims))).reshape(dims[::-1]).transpose().astype(dtype.newbyteorder("="))
    affine = np.diag([*spacing[:3], *([1.0] * (3 - len(spacing[:3]))), 1.0])
    nib.save(nib.Nifti1Image(arr, affine), str(out / "volume.nii.gz"))
    return {"shape": "assets", "assets": [{"path": "volume.nii.gz", "mediaType": "application/x-nifti"}]}
