"""docs/datasets.md Phase 1: a dataset's profile (collections, fields, formats, relationships and
issues) read from inspection of the files it pins, with nothing that could identify a patient."""

from __future__ import annotations

import json

from .conftest import png
from .test_explore import _import, _report, _table


def _dataset(client, p: str) -> dict:
    src = client.get(f"/api/v1/projects/{p}/sources").json()["sources"][0]
    return client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Cohort", "nodeIds": [src["rootNodeId"]]}).json()


def test_profile_counts_logical_items_and_ranks_issues(client):
    p = client.post("/api/v1/projects", json={"title": "Mixed"}).json()["id"]
    csv_bytes, prof = _table(["file", "diagnosis"], [["a.png", "normal"], ["b.png", "lesion"], ["zz.png", "normal"]])
    files = {
        "study/a.png": png(4, 3),
        "study/b.png": png(5, 3),
        "study/Smith_John.png": png(6, 3),
        "study/s1/1.dcm": b"dicom-1",
        "study/s1/2.dcm": b"dicom-2",
        "study/labels.csv": csv_bytes,
        "study/notes.bin": b"\x00\x01",
    }
    imp = _import(client, p, files)
    series = {"series_uid_hash": "h-series-1", "dicom": {"modality": "CT"}, "width": 512, "height": 512, "spacing": [0.7, 0.7]}
    _report(
        client,
        imp,
        {"a.png": "image", "b.png": "image", "Smith_John.png": "image", "1.dcm": "dicom", "2.dcm": "dicom", "labels.csv": "table", "notes.bin": "unknown"},
        {"a.png": {"format": "PNG", "width": 4, "height": 3, "mode": "L"}, "b.png": {"format": "PNG", "width": 5, "height": 3, "mode": "L"}, "1.dcm": series, "2.dcm": series, "labels.csv": {"format": "CSV", "table": prof}},
        {"Smith_John.png": {"privacy": {"reason": "The name looks like a person's name"}}, "notes.bin": {"unsupported": "Unknown format"}},
    )
    ds = _dataset(client, p)
    r = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/profile")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["snapshot"] == {"kind": "draft", "label": "Working draft", "readOnly": False}
    assert body["files"] == 7 and body["checking"] == 0
    by = {c["id"]: c for c in body["collections"]}
    # Two DICOM files of one series are one logical item, counted as a series.
    assert by["kind:dicom-series"]["count"] == 1 and by["kind:dicom-series"]["files"] == 2
    assert by["kind:dicom-series"]["unit"] == {"one": "series", "other": "series"}
    assert [c["kind"] for c in body["collections"]][0] == "dicom-series"  # what people label comes first
    images = by["kind:image"]
    assert images["count"] == 3 and images["suggested"] is True and images["issues"] == 1
    assert images["formats"] == [{"label": "PNG", "count": 2}]
    size = next(f for f in images["facts"] if f["key"] == "size")
    assert {v["value"] for v in size["values"]} == {"4 × 3 px", "5 × 3 px"} and size["missing"] == 1
    # A table's columns are its fields; no examples or values.
    table = by["kind:table"]
    cols = {f["name"]: f for f in table["fields"] if f["id"].startswith("col:")}
    assert set(cols) == {"file", "diagnosis"} and cols["file"]["key"] is True and cols["file"]["required"] is True
    # The preview is a clean, viewable file.
    held = next(i for i in body["issues"] if i["category"] == "privacy")
    assert images["previewNodeId"] and images["previewNodeId"] not in held["nodeIds"]
    # Blocking first; severity and blocking are separate.
    assert body["issues"][0]["category"] == "privacy" and held["blocking"] is True and held["severity"] == "high"
    unread = next(i for i in body["issues"] if i["category"] == "unreadable")
    assert unread["blocking"] is False and unread["ruleId"] == "inspection.unreadable@1" and unread["action"]["target"] == {"section": "sources", "status": "unsupported"}
    # Nothing that could identify a patient: no names, no cell values.
    text = json.dumps(body)
    for leak in ("Smith", "a.png", "normal", "lesion", "labels.csv", "study/"):
        assert leak not in text, leak


def test_profile_relationships_come_from_proposals_on_its_tables(client):
    p = client.post("/api/v1/projects", json={"title": "Linked"}).json()["id"]
    csv_bytes, prof = _table(["patient_id", "diagnosis"], [["P001", "healthy"], ["P002", "lesion"], ["P009", "healthy"]])
    files = {f"mri/patient_00{i}/scan.png": png(3 + i, 3) for i in (1, 2)}
    files["mri/diagnoses.csv"] = csv_bytes
    imp = _import(client, p, files)
    _report(client, imp, {"scan.png": "image", "diagnoses.csv": "table"}, {"diagnoses.csv": {"table": prof}})
    ds = _dataset(client, p)
    body = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/profile").json()
    [rel] = body["relationships"]
    assert (rel["from"], rel["to"], rel["status"], rel["cardinality"]) == ("kind:table", "kind:image", "suggested", "1:N")
    assert rel["keys"] == "patient_id → folder name" and rel["coverage"]["unmatched"] == 1
    identity = next(i for i in body["issues"] if i["category"] == "identity")
    assert identity["count"] == 1 and identity["action"]["target"]["proposalId"] == rel["proposalId"]


def test_profile_is_scoped_to_the_project(client):
    a = client.post("/api/v1/projects", json={"title": "A"}).json()["id"]
    b = client.post("/api/v1/projects", json={"title": "B"}).json()["id"]
    imp = _import(client, a, {"x/one.png": png(2, 2)})
    _report(client, imp, {"one.png": "image"})
    ds = _dataset(client, a)
    assert client.get(f"/api/v1/projects/{b}/datasets/{ds['id']}/profile").status_code == 404
    assert client.get(f"/api/v1/projects/{a}/datasets/nope/profile").status_code == 404
