"""Inspection (todo6 Phase 5.1): an import through the live kernel is inspected by the worker
loop. Kinds come from content, DICOM files become a candidate series with its gaps flagged,
identifying headers and path names hold files, tables are profiled, and the relationship,
label mapping and dataset proposals wait for a person. Confirming the dataset creates the
task with the CSV's classes and its labels as `imported` annotations."""

from __future__ import annotations

import csv
import hashlib
import io

import httpx
import pytest

from studio_worker.inspect import InspectSubscriber, detect, privacy, tables
from studio_worker.main import Worker

from .conftest import png


def dicom(instance: int, *, patient: str = "", series: str = "1.2.3.4.5", rows: int = 8) -> bytes:
    import numpy as np
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.4"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "MR"
    ds.StudyInstanceUID = "1.2.3.4"
    ds.SeriesInstanceUID = series
    ds.SeriesDescription = "T1 axial"
    ds.InstanceNumber = instance
    ds.PatientName = patient
    ds.Rows = ds.Columns = rows
    ds.PixelSpacing = [0.5, 0.5]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.ImagePositionPatient = [0, 0, float(instance)]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = (np.arange(rows * rows, dtype=np.uint16) * instance).tobytes()
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def labels_csv(rows: list[tuple[str, str]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["filename", "diagnosis"])
    w.writerows(rows)
    return buf.getvalue().encode()


def xlsx() -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["subject", "age"])
    ws.append(["s1", 40])
    ws.append(["s2", 51])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def upload(url: str, project: str, files: dict[str, bytes]) -> dict:
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = httpx.post(f"{url}/api/v1/projects/{project}/imports", json=body).json()
    for f in s["files"]:
        if f["uploadUrl"]:
            data = next(d for rel, d in files.items() if rel.endswith(f["relPath"]))
            assert httpx.put(f"{url}{f['uploadUrl']}", content=data).json()["state"] == "uploaded"
    done = httpx.post(f"{url}/api/v1/imports/{s['id']}/complete").json()
    assert done["state"] == "inspecting", done
    return done


def nodes_by_name(url: str, project: str) -> dict[str, dict]:
    out = {}
    for item in httpx.get(f"{url}/api/v1/projects/{project}/search", params={"q": ""}).json()["items"]:
        out[item["name"]] = item
    return out


@pytest.fixture
def mixed(stack):
    url = stack["url"]
    p = httpx.post(f"{url}/api/v1/projects", json={"title": "Mixed"}).json()
    files = {f"hospital/images/img_00{i}.png": png(10 + i, 12) for i in range(1, 6)}
    files["hospital/labels.csv"] = labels_csv([(f"img_00{i}.png", "pneumonia" if i % 2 else "normal") for i in range(1, 6)] + [("img_099.png", "normal")])
    files["hospital/protocol.pdf"] = b"%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n"
    files["hospital/blob.bin"] = bytes(range(256)) * 4
    files["hospital/measurements.xlsx"] = xlsx()
    for i in (1, 2, 4, 5):  # instance 3 is missing
        files[f"hospital/MRI/series1/IM{i:04d}.dcm"] = dicom(i, patient="DOE^JANE" if i == 1 else "")
    files["hospital/Smith_Jane/notes.txt"] = b"follow-up notes\n"
    imp = upload(url, p["id"], files)
    return url, p["id"], imp


def test_worker_inspects_an_import_and_proposes_without_applying(stack, tmp_path, mixed):
    url, project, imp = mixed
    w = Worker(url, stack["token"], tmp_path, "w-inspect")
    w.tick()
    after = httpx.get(f"{url}/api/v1/imports/{imp['id']}").json()
    assert after["state"] == "needs_review"
    # Acknowledged: a second pass does nothing.
    assert w.inspect.tick() == 0

    n = nodes_by_name(url, project)
    # Kinds come from content; nothing is "Checking…" any more.
    kinds = {k: n[k]["detectedKind"] for k in ("img_001.png", "labels.csv", "protocol.pdf", "blob.bin", "measurements.xlsx", "IM0001.dcm", "notes.txt")}
    assert kinds == {"img_001.png": "image", "labels.csv": "table", "protocol.pdf": "document", "blob.bin": "unknown", "measurements.xlsx": "table", "IM0001.dcm": "dicom", "notes.txt": "document"}
    assert n["blob.bin"]["status"] == "unsupported"
    img = httpx.get(f"{url}/api/v1/source-nodes/{n['img_001.png']['id']}").json()
    assert img["facts"]["width"] == 11 and img["facts"]["height"] == 12 and img["facts"]["thumbnail"].startswith("sources/")
    assert httpx.get(f"{url}{httpx.get(f'{url}/api/v1/source-nodes/{img['id']}/preview').json()['thumbnailUrl']}").content.startswith(b"\x89PNG")
    # DICOM: identifying header → held, with the field named but never its value.
    held = httpx.get(f"{url}/api/v1/source-nodes/{n['IM0001.dcm']['id']}").json()
    assert held["status"] == "privacy" and held["flags"]["privacy"]["fields"] == ["PatientName"]
    assert "DOE" not in str(held) and "JANE" not in str(held)
    assert held["facts"]["dicom"]["modality"] == "MR" and "series_uid_hash" in held["facts"]
    # A gap in the series is a quality flag, not a silent fix.
    gap = httpx.get(f"{url}/api/v1/source-nodes/{n['IM0002.dcm']['id']}").json()
    assert gap["status"] == "attention" and "instance 3 missing" in gap["flags"]["quality"][0]
    # A person-like folder name holds the files under it.
    assert n["notes.txt"]["status"] == "privacy"
    # Tables are profiled; XLSX gets a derived CSV.
    lab = httpx.get(f"{url}/api/v1/source-nodes/{n['labels.csv']['id']}").json()["facts"]["table"]
    assert lab["rowCount"] == 6 and lab["header"] and [c["name"] for c in lab["columns"]] == ["filename", "diagnosis"]
    assert "filename" in lab["candidateKeys"] and "filename" in lab["nameColumns"]
    xl = httpx.get(f"{url}/api/v1/source-nodes/{n['measurements.xlsx']['id']}").json()["facts"]
    assert xl["table"]["csvPath"].endswith(".csv") and xl["table"]["rowCount"] == 2 and xl["workbook"]["sheet"]

    props = {p["kind"]: p for p in httpx.get(f"{url}/api/v1/projects/{project}/proposals").json()["proposals"]}
    assert set(props) == {"group", "relationship", "mapping", "dataset"}
    assert all(p["status"] == "proposed" and p["createdBy"] == "worker:inspect" for p in props.values())
    g = props["group"]
    assert g["payload"]["summary"].startswith("4 DICOM files form 1 MRI series (MR, 8×8, 4 slices)") and g["evidence"]["missingInstances"] == [3]
    rel = props["relationship"]
    assert (rel["payload"]["column"], rel["payload"]["target"]) == ("filename", "files")
    assert (rel["evidence"]["matched"], rel["evidence"]["unmatched"], rel["evidence"]["ambiguous"]) == (5, 1, 0)
    assert rel["evidence"]["unmatchedRows"] == [{"row": 5, "value": "img_099.png"}]
    assert rel["strength"] == "possible"  # 5 of 6: words, never percentages
    mp = props["mapping"]
    assert mp["payload"]["column"] == "diagnosis" and {c["id"] for c in mp["payload"]["classes"]} == {"normal", "pneumonia"}
    ds = props["dataset"]
    assert ds["payload"]["preset"] == "preset:image-2d" and ds["payload"]["itemCount"] == 5
    # Proposed, not applied: no dataset, no task, no annotations yet.
    assert [d for d in httpx.get(f"{url}/api/v1/projects/{project}/datasets").json()["datasets"]] == []

    # The summary and quality list come from the same rows.
    s = httpx.get(f"{url}/api/v1/projects/{project}/explore").json()
    assert s["files"]["total"] == 14 and not s["clean"]
    types = {q["type"] for q in s["quality"]}
    assert {"privacy", "unsupported", "series", "mismatch"} <= types

    # A person fixes the unmatched row (skip it): the server recomputes.
    r = httpx.post(f"{url}/api/v1/proposals/{rel['id']}/recompute", json={"resolutions": {"5": "skip"}}).json()
    assert (r["evidence"]["matched"], r["evidence"]["unmatched"], r["evidence"]["skipped"]) == (5, 0, 1) and r["strength"] == "strong"

    # The action preview, then confirming the dataset: dataset + task + environment + imported labels.
    pv = httpx.get(f"{url}/api/v1/proposals/{ds['id']}/preview").json()
    assert pv["files"] == 5 and pv["importedLabels"] == 5 and sorted(pv["labelClasses"]) == ["normal", "pneumonia"] and len(pv["alsoConfirms"]) == 2
    tok = httpx.post(f"{url}/api/v1/sessions", json={"scopes": ["proposals.write"], "agent": "run-1"}, headers={"X-Workspace-Id": project}).json()["token"]
    agent = {"Authorization": f"Bearer {tok}"}
    assert httpx.post(f"{url}/api/v1/proposals/{ds['id']}/confirm", json={}, headers=agent).status_code == 403
    out = httpx.post(f"{url}/api/v1/proposals/{ds['id']}/confirm", json={}).json()
    task = out["task"]["id"]
    assert out["importedLabels"] == 5 and out["task"]["kind"] == "classification"
    env = httpx.get(f"{url}/api/environments/{task}").json()["effective"]
    assert env["extends"] == "preset:image-2d" and sorted(c["id"] for c in env["labels"][0]["classes"]) == ["normal", "pneumonia"]
    doc = httpx.get(f"{url}/api/v1/tasks/{task}/document").json()
    assert len(doc["assets"]) == 5
    anns = httpx.get(f"{url}/api/annotations/{task}", headers={"X-Workspace-Id": task}).json()["annotations"]
    assert len(anns) == 5 and {a["provenance"] for a in anns} == {"imported"} and {a["itemId"] for a in anns} == {a["path"] for a in doc["assets"]}
    assert anns[0]["attributes"]["source_file"] == "labels.csv" and anns[0]["attributes"]["review_status"] == "pending"
    decided = {p["kind"]: p["status"] for p in httpx.get(f"{url}/api/v1/projects/{project}/proposals").json()["proposals"]}
    assert decided == {"group": "proposed", "relationship": "confirmed", "mapping": "confirmed", "dataset": "confirmed"}
    assert httpx.get(f"{url}/api/v1/imports/{imp['id']}").json()["state"] == "imported"
    actions = [e["action"] for e in httpx.get(f"{url}/api/v1/projects/{project}/activity").json()["entries"]]
    for a in ("import.completed", "import.inspected", "proposal.confirmed", "dataset.created", "task.created"):
        assert a in actions, a

    # Clearing the privacy hold is a person's call, with a reason, and audited.
    nid = n["IM0001.dcm"]["id"]
    assert httpx.post(f"{url}/api/v1/source-nodes/{nid}/privacy/clear", json={"reason": "x"}, headers=agent).status_code == 403
    assert httpx.post(f"{url}/api/v1/source-nodes/{nid}/privacy/clear", json={"reason": "Synthetic phantom name"}).json()["status"] == "attention"
    assert "privacy.cleared" in [e["action"] for e in httpx.get(f"{url}/api/v1/projects/{project}/activity").json()["entries"]]


def test_a_second_report_for_a_finished_import_is_refused(stack, tmp_path, mixed):
    url, _, imp = mixed
    http = httpx.Client(base_url=url, headers={"X-Worker-Token": stack["token"]})
    sub = InspectSubscriber(http, tmp_path)
    assert sub.tick() >= 1
    assert http.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"nodes": []}).status_code == 409
    assert httpx.get(f"{url}/api/v1/worker/inspect/imports/{imp['id']}").status_code == 401  # worker token only


def test_detect_reads_content_not_extensions():
    assert detect.detect("scan.dat", png(4, 4))[0] == "image"
    assert detect.detect("photo.png", b"%PDF-1.7 ...")[0] == "document"
    assert detect.detect("x.csv", b"a,b\n1,2\n3,4\n")[0] == "table"
    assert detect.detect("readme", b"just some words\nand more\n")[0] == "document"
    assert detect.detect("m.nii.gz", b"\x00\x01\x02garbage")[0] == "unknown"
    assert detect.detect("clip.bin", b"\x00\x00\x00\x18ftypmp42" + bytes(40))[0] == "video"
    assert detect.detect("coco.json", b'{"images": [], "annotations": [], "categories": []}')[0] == "annotations"


def test_privacy_path_rules():
    assert privacy.path_findings("Doe_John/scan.png") == ["a name looks like a person's name"]
    assert privacy.path_findings("Chest_Xray/Left_Lung.png") == []
    assert privacy.path_findings("2024-03-07/a.png") == ["a name holds a date"]
    assert privacy.path_findings("mrn/12345678.dcm") == ["a name holds a record-number-shaped number"]
    assert privacy.path_findings("patient_001/IM-0001-0001.dcm") == []


def test_table_profile_types_and_keys():
    text = "id;group;score\nP001;a;1.5\nP002;b;2\nP003;a;\n"
    prof, findings = tables.profile(text, "t.csv", ["P001/x.png"])
    assert prof["delimiter"] == "semicolon" and prof["header"] and prof["rowCount"] == 3
    cols = {c["name"]: c for c in prof["columns"]}
    assert cols["score"]["type"] == "number" and cols["score"]["filled"] == 2 and cols["id"]["type"] == "id"
    assert prof["candidateKeys"] == ["id"] and prof["nameColumns"] == ["id"] and findings == []
    _, held = tables.profile("name,email\nA,a@b.org\n", "t.csv", [])
    assert any("e-mail" in f or "email" in f for f in held)
