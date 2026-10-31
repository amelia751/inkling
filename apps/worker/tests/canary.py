"""Synthetic "real" samples with a canary planted in the header and in the pixels (todo10 Phase 7
exit test). Nothing here is real data; the canary only has to be unique and greppable."""

from __future__ import annotations

import io
import struct
from pathlib import Path

CANARY = "CANARY-Zq8Lp3Vx-PHI"
INKB_NAME_OFFSET = 17  # where the 32-byte name field starts in an INKB header
INKB_W, INKB_H = 24, 16


def inkb_sample() -> bytes:
    """An unknown binary format: b"INKB", u16 version, u16 header length, u32 width, u32 height,
    u8 dtype (1 = float32 LE), a 32-byte NUL-padded name (the canary), then float32 pixels with
    the canary's bytes spliced into them."""
    header_len = 4 + 2 + 2 + 4 + 4 + 1 + 32
    name = CANARY.encode().ljust(32, b"\x00")
    head = b"INKB" + struct.pack("<HHIIB", 1, header_len, INKB_W, INKB_H, 1) + name
    pixels = bytearray(struct.pack(f"<{INKB_W * INKB_H}f", *[float((x * 7) % 13) for x in range(INKB_W * INKB_H)]))
    pixels[40 : 40 + len(CANARY)] = CANARY.encode()
    return head + bytes(pixels)


def dicom_sample() -> bytes:
    import numpy as np
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(None, {}, file_meta=meta, preamble=b"\x00" * 128)
    ds.PatientName = CANARY
    ds.PatientID = CANARY
    ds.InstitutionName = CANARY
    ds.StudyDescription = CANARY
    ds.Modality = "CT"
    ds.SOPClassUID, ds.SOPInstanceUID = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID
    ds.Rows, ds.Columns, ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 8, 8, 7
    ds.SamplesPerPixel, ds.PixelRepresentation, ds.PhotometricInterpretation = 1, 0, "MONOCHROME2"
    px = bytearray(np.arange(256, dtype=np.uint8).tobytes())
    px[100 : 100 + len(CANARY)] = CANARY.encode()  # the canary in the pixels
    ds.PixelData = bytes(px)
    ds.add_new(0x00091010, "LO", CANARY)  # and in a private tag
    out = io.BytesIO()
    ds.save_as(out, enforce_file_format=True)
    assert pydicom.dcmread(io.BytesIO(out.getvalue())).PatientName == CANARY
    return out.getvalue()


def write_canary_samples(d: Path) -> list[str]:
    d.mkdir(parents=True, exist_ok=True)
    (d / "scan.inkb").write_bytes(inkb_sample())
    (d / "scan.dcm").write_bytes(dicom_sample())
    return ["scan.inkb", "scan.dcm"]


# The agent's converter for INKB, as it would write it from fixtures, probes and verify reports.
INKB_CONVERTER = '''
import struct
import numpy as np


def convert(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"INKB":
        raise ValueError("not an INKB file")
    version, header_len, w, h, dtype = struct.unpack("<HHIIB", data[4:17])
    pixels = np.frombuffer(data, dtype="<f4", count=w * h, offset=header_len).reshape(h, w)
    return {"image": pixels}
'''

# A converter that tries to leak: an exception message quoting the header, then the network.
LEAKY_CONVERTER = '''
def convert(path):
    with open(path, "rb") as f:
        head = f.read(64)
    raise ValueError("header was: " + head.decode("latin1"))
'''

NETWORK_CONVERTER = '''
import socket


def convert(path):
    data = open(path, "rb").read(64)
    s = socket.socket()
    s.connect(("127.0.0.1", 9))
    s.send(data)
    return {"ok": 1}
'''
