"""todo17 D11: the worker's imaging checks on synthetic DICOM and NIfTI (no real sample bytes).
Findings carry codes, counts, ids and field names only, never header values."""

from __future__ import annotations

import gzip
import io
import json

import httpx
import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from studio_worker import imaging
from studio_worker.main import Worker

CT = "1.2.840.10008.5.1.4.1.1.2"
SEG = "1.2.840.10008.5.1.4.1.1.66.4"
PATIENT = "Doe^Jane"


def dicom(series: str, n: int | None, z: float | None, *, sop: str = CT, frame: str = "1.2.3.4", orient=(1, 0, 0, 0, 1, 0), spacing=(0.5, 0.5), refs: list[str] | None = None) -> Dataset:
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = sop
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.SOPClassUID, ds.SOPInstanceUID = sop, ds.file_meta.MediaStorageSOPInstanceUID
    ds.PatientName = PATIENT
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = "1.2.3", series, frame
    if n is not None:
        ds.InstanceNumber = n
    if z is not None:
        ds.ImagePositionPatient = [0.0, 0.0, z]
        ds.ImageOrientationPatient = list(orient)
        ds.PixelSpacing = list(spacing)
    if refs is not None:
        item = Dataset()
        item.SeriesInstanceUID = refs[0] if refs else ""
        ds.ReferencedSeriesSequence = [item] if refs else []
    return ds


def to_bytes(ds: Dataset) -> bytes:
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def series_of(*datasets: Dataset) -> dict[str, imaging.Series]:
    out: dict[str, imaging.Series] = {}
    for i, ds in enumerate(datasets):
        imaging.add_dicom(out, f"nod-{i}", ds)
    return out


def rules(results: list[dict]) -> list[str]:
    return sorted(v["rule"] for r in results for v in r["violations"])


# ---- DICOM -----------------------------------------------------------------------------------


def test_complete_even_series_is_clean():
    s = series_of(*(dicom("9.1", i + 1, i * 2.0) for i in range(5)))
    out = imaging.check_dicom(s)
    assert rules(out) == [] and out[0]["resourceKind"] == "series" and out[0]["resourceId"] == imaging.uid_hash("9.1")
    assert out[0]["nodeIds"] == [f"nod-{i}" for i in range(5)]


def test_missing_slice_is_reported_by_instance_number_and_position():
    s = series_of(*(dicom("9.1", i + 1, i * 2.0) for i in range(6) if i != 3))
    out = imaging.check_dicom(s)
    assert rules(out) == ["dicom.inconsistent-spacing", "dicom.series-incomplete"]
    inc = next(v for v in out[0]["violations"] if v["rule"] == "dicom.series-incomplete")
    assert inc["path"] == "/InstanceNumber" and inc["message"].startswith("1 of 6 instances missing")
    # Without InstanceNumber the position gap still shows.
    s = series_of(*(dicom("9.2", None, i * 2.0) for i in range(6) if i != 3))
    assert "dicom.series-incomplete" in rules(imaging.check_dicom(s))


def test_uneven_spacing_and_mixed_orientation():
    s = series_of(*(dicom("9.1", i + 1, z) for i, z in enumerate([0.0, 2.0, 4.0, 5.2, 7.2])))
    assert rules(imaging.check_dicom(s)) == ["dicom.inconsistent-spacing"]
    s = series_of(dicom("9.1", 1, 0.0), dicom("9.1", 2, 2.0, orient=(0, 1, 0, 0, 0, -1)), dicom("9.1", 3, 4.0, spacing=(0.7, 0.7)))
    assert rules(imaging.check_dicom(s)) == ["dicom.inconsistent-orientation", "dicom.inconsistent-spacing"]


def test_seg_frame_of_reference_must_match_its_source():
    src = [dicom("9.1", i + 1, i * 2.0) for i in range(3)]
    good = series_of(*src, dicom("9.9", 1, None, sop=SEG, refs=["9.1"]))
    assert rules(imaging.check_dicom(good)) == []
    bad = series_of(*src, dicom("9.9", 1, None, sop=SEG, frame="7.7.7", refs=["9.1"]))
    out = imaging.check_dicom(bad)
    assert rules(out) == ["dicom.seg-frame-mismatch"]
    assert next(r for r in out if r["violations"])["resourceId"] == imaging.uid_hash("9.9")
    orphan = series_of(dicom("9.9", 1, None, sop=SEG, refs=[]))
    assert rules(imaging.check_dicom(orphan)) == ["dicom.seg-frame-mismatch"]


def test_dciodvfy_is_optional(tmp_path):
    fake = tmp_path / "dciodvfy"
    fake.write_text("#!/bin/sh\necho 'Error - bad value Doe^Jane' 1>&2\necho 'Warning - x'\n")
    fake.chmod(0o755)
    assert imaging.dciodvfy_errors(str(tmp_path / "x.dcm"), exe=str(fake)) == 1


# ---- NIfTI -----------------------------------------------------------------------------------


def nifti(data: np.ndarray, affine=None, *, sform=None, zooms=None) -> nib.Nifti1Image:
    img = nib.Nifti1Image(data, np.eye(4) if affine is None else affine)
    img.header.set_qform(np.eye(4) if affine is None else affine, code=1)
    img.header.set_sform(np.eye(4) if sform is None else sform, code=1)
    if zooms is not None:
        img.header["pixdim"][1:4] = zooms
    return img


def test_nifti_checks():
    clean = nifti(np.zeros((4, 4, 4), np.float32))
    assert imaging.check_nifti(clean) == []
    shifted = np.eye(4)
    shifted[0, 3] = 10.0
    data = np.zeros((4, 4, 4), np.float32)
    data[0, 0, :3] = np.nan
    vs = imaging.check_nifti(nifti(data, sform=shifted))
    assert sorted(v["rule"] for v in vs) == ["nifti.nan", "nifti.orientation-mismatch"]
    assert next(v for v in vs if v["rule"] == "nifti.nan")["message"] == "3 of 64 voxels are NaN"
    vs = imaging.check_nifti(nifti(np.zeros((4, 4, 4), np.int16), zooms=(1.0, 0.0, -1.0)))
    assert [(v["rule"], v["message"]) for v in vs] == [("nifti.voxel-size", "2 of 3 spatial voxel sizes are zero, negative or not finite")]
    assert imaging.check_grid(nifti(np.zeros((4, 4, 3), np.uint8)), clean)[0]["rule"] == "nifti.grid-mismatch"
    assert imaging.check_grid(nifti(np.zeros((4, 4, 4), np.uint8)), clean) == []


def test_masks_pair_with_their_image_in_the_same_folder():
    nodes = [{"id": "a", "name": "case1.nii.gz", "parentId": "f"}, {"id": "b", "name": "case1_seg.nii.gz", "parentId": "f"}, {"id": "c", "name": "case2_mask.nii", "parentId": "f"}, {"id": "d", "name": "case1_seg.nii.gz", "parentId": "g"}]
    assert imaging.pair_masks(nodes) == {"b": "a"}


# ---- The job, end to end against a fake kernel ------------------------------------------------


def nifti_bytes(img: nib.Nifti1Image) -> bytes:
    return gzip.compress(img.to_bytes())


def test_job_reads_through_the_kernel_and_posts_codes_only(tmp_path):
    files = {f"d{i}": to_bytes(dicom("9.1", i + 1, i * 2.0)) for i in range(5) if i != 2}
    files["img"] = nifti_bytes(nifti(np.zeros((4, 4, 4), np.float32)))
    files["seg"] = nifti_bytes(nifti(np.zeros((4, 4, 2), np.uint8)))
    files["txt"] = b"hello"
    posted: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path.startswith("/api/v1/worker/inspect/nodes/"):
            nid = path.split("/")[-2]
            return httpx.Response(200, content=files[nid]) if nid in files else httpx.Response(404)
        if path == "/api/v1/service/projects/prj-1/findings":
            posted.append(json.loads(req.content))
            return httpx.Response(200, json={"opened": 1})
        return httpx.Response(404)

    http = httpx.Client(base_url="http://k", transport=httpx.MockTransport(handler))
    nodes = [{"id": k, "name": f"{k}.dcm", "parentId": "f"} for k in files if k.startswith("d")]
    nodes += [{"id": "img", "name": "case.nii.gz", "parentId": "f"}, {"id": "seg", "name": "case_seg.nii.gz", "parentId": "f"}, {"id": "txt", "name": "README", "parentId": "f"}, {"id": "gone", "name": "x.dcm", "parentId": "f"}]
    out = imaging.ImagingCheck(http, tmp_path, dciodvfy="").run({"projectId": "prj-1", "trigger": "import", "nodes": nodes})
    assert out["series"] == 1 and out["nifti"] == 2
    assert out["findings"] == {"dicom.series-incomplete": 1, "dicom.inconsistent-spacing": 1, "nifti.grid-mismatch": 1}
    body = posted[0]
    assert body["source"] == "scan" and "nifti.nan" in body["checked"]
    raw = json.dumps(body)
    assert PATIENT not in raw and "9.1" not in raw.replace(imaging.uid_hash("9.1"), "")  # no header values, no UIDs
    assert list(tmp_path.iterdir()) == []  # scratch cleaned


def test_worker_runs_imaging_check_as_a_kernel_job(tmp_path, monkeypatch):
    calls: list[tuple[str, dict]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else {}
        calls.append((req.url.path, body))
        return httpx.Response(200, json={"state": "running"})

    w = Worker("http://k", "t", tmp_path, "w1")
    w.http = httpx.Client(base_url="http://k", transport=httpx.MockTransport(handler))
    w.imaging = imaging.ImagingCheck(w.http, tmp_path / "imaging", dciodvfy="")
    w.run_service_job({"jobId": "job-1", "tool": "imaging.check", "attempts": 1, "input": {"projectId": "prj-1", "nodes": []}})
    done = [b for p, b in calls if p == "/api/v1/worker/jobs/job-1/complete"]
    assert done and done[0]["result"]["files"] == 0
