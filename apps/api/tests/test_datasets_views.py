"""todo13 Milestone 3: the Datasets landing reads (dataset summaries, attention) and collections
from the dataset definition, read defensively until `todo13-organize` lands them."""

from __future__ import annotations

import json

from sqlalchemy import text

from studio_api import db as kdb
from studio_api.models import DatasetRow

from .conftest import png
from .test_explore import _import, _report, _table


def _dataset(client, p: str, title: str = "Cohort") -> dict:
    src = client.get(f"/api/v1/projects/{p}/sources").json()["sources"][0]
    return client.post(f"/api/v1/projects/{p}/datasets", json={"title": title, "nodeIds": [src["rootNodeId"]]}).json()


def _mixed(client) -> tuple[str, dict]:
    p = client.post("/api/v1/projects", json={"title": "Mixed"}).json()["id"]
    csv_bytes, prof = _table(["patient_id", "diagnosis"], [["P001", "healthy"], ["P002", "lesion"], ["P009", "healthy"]])
    files = {f"mri/patient_00{i}/scan.png": png(3 + i, 3) for i in (1, 2)}
    files["mri/diagnoses.csv"] = csv_bytes
    files["mri/Doe_Jane.png"] = png(2, 2)
    files["mri/notes.bin"] = b"\x00\x01"
    imp = _import(client, p, files)
    _report(
        client,
        imp,
        {"scan.png": "image", "Doe_Jane.png": "image", "diagnoses.csv": "table", "notes.bin": "unknown"},
        {"diagnoses.csv": {"table": prof}},
        {"Doe_Jane.png": {"privacy": {"reason": "The name looks like a person's name"}}, "notes.bin": {"unsupported": "Unknown format"}},
    )
    return p, _dataset(client, p)


def test_summaries_are_one_bounded_row_per_dataset(client):
    p, ds = _mixed(client)
    r = client.get(f"/api/v1/projects/{p}/dataset-summaries")
    assert r.status_code == 200, r.text
    [s] = r.json()["datasets"]
    assert s["datasetId"] == ds["id"] and s["files"] == 5 and s["checking"] == 0
    kinds = {c["kind"]: c for c in s["collections"]}
    assert kinds["image"]["count"] == 3 and kinds["image"]["unit"]["other"] == "images"
    # Summaries carry counts, not the facts, fields or node lists the profile has.
    assert set(kinds["image"]) == {"id", "name", "kind", "count", "unit", "files", "suggested", "issues", "previewNodeId"}
    assert s["issues"]["blocking"] == 1 and s["issues"]["high"] == 1 and s["relationships"] == 1
    # Three inferred collections and one inferred connection, none confirmed.
    assert s["suggestions"] == 4 and s["snapshot"]["kind"] == "draft" and s["lastChangedAt"]
    text_ = json.dumps(r.json())
    for leak in ("Doe", "scan.png", "healthy", "lesion", "diagnoses.csv", "patient_00"):
        assert leak not in text_, leak


def test_attention_lists_malformed_files_and_unconfirmed_suggestions_by_risk(client):
    p, ds = _mixed(client)
    body = client.get(f"/api/v1/projects/{p}/dataset-attention").json()
    kinds = [i["kind"] for i in body["items"]]
    assert body["total"] == len(body["items"]) and body["byKind"]["malformed"] == 2
    # Held for privacy blocks a release: first. Suggestions are low and last.
    first = body["items"][0]
    assert first["kind"] == "malformed" and first["blocking"] is True and first["datasetId"] == ds["id"] and first["datasetTitle"] == "Cohort"
    assert first["action"]["target"]["section"] == "sources"
    assert kinds.index("suggestion") > kinds.index("malformed")
    structure = next(i for i in body["items"] if i["id"].endswith("structure.suggested@1"))
    assert structure["count"] == 3 and structure["action"]["target"] == {"section": "datasets", "datasetId": ds["id"], "tab": "structure"}
    # The unmatched table row is an identity suggestion with its Explore link.
    identity = next(i for i in body["items"] if "explore.relationship" in i["id"])
    assert identity["kind"] == "suggestion" and identity["action"]["target"]["section"] == "explore"
    assert "Doe" not in json.dumps(body)


def test_attention_for_one_dataset_and_project_scoping(client):
    p, ds = _mixed(client)
    other = client.post("/api/v1/projects", json={"title": "Other"}).json()["id"]
    one = client.get(f"/api/v1/projects/{p}/dataset-attention", params={"datasetId": ds["id"]}).json()
    assert one["items"] and all(i["datasetId"] == ds["id"] for i in one["items"])
    assert client.get(f"/api/v1/projects/{other}/dataset-attention", params={"datasetId": ds["id"]}).status_code == 404
    assert client.get(f"/api/v1/projects/{p}/dataset-attention", params={"datasetId": "nope"}).status_code == 404
    assert client.get("/api/v1/projects/nope/dataset-summaries").status_code == 404


def test_waiting_drop_plans_are_read_once_the_drops_table_exists(client):
    p, ds = _mixed(client)
    # Before todo13-drops: no table, no error, no plan rows.
    assert all(i["kind"] != "plan" for i in client.get(f"/api/v1/projects/{p}/dataset-attention").json()["items"])
    with kdb.session_scope() as s:
        s.execute(text("CREATE TABLE drops (id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(128), origin VARCHAR(16), conversation_id VARCHAR(64), message_id VARCHAR(64), task_id VARCHAR(128), dataset_id VARCHAR(128), created_by VARCHAR(256), created_at TIMESTAMP, state VARCHAR(16))"))
        s.execute(text("INSERT INTO drops (id, project_id, origin, dataset_id, created_by, state) VALUES ('drp1', :p, 'chat', :d, 'user:x', 'planned'), ('drp2', :p, 'chat', :d, 'user:x', 'applied')"), {"p": p, "d": ds["id"]})
    body = client.get(f"/api/v1/projects/{p}/dataset-attention").json()
    [plan] = [i for i in body["items"] if i["kind"] == "plan"]
    assert plan["id"] == "drop:drp1" and plan["datasetId"] == ds["id"] and plan["action"]["target"]["dropId"] == "drp1"


def test_collections_named_by_the_definition_replace_inferred_ones(client):
    p, ds = _mixed(client)
    with kdb.session_scope() as s:
        row = s.get(DatasetRow, ds["id"])
        row.definition = {**row.definition, "collections": [{"id": "col_xray", "name": "Chest X-rays", "kind": "image", "suggested": False}, {"id": "col_ct", "name": "CT series", "kind": "dicom-series"}, {"bad": True}]}
    prof = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/profile").json()
    by = {c["id"]: c for c in prof["collections"]}
    assert by["col_xray"]["name"] == "Chest X-rays" and by["col_xray"]["count"] == 3 and by["col_xray"]["suggested"] is False
    # A defined collection with nothing in it yet is listed empty, waiting for files.
    assert by["col_ct"]["count"] == 0 and by["col_ct"]["files"] == 0
    # Kinds no defined collection holds stay visible as inferred collections.
    assert "kind:table" in by and by["kind:table"]["suggested"] is True and "kind:image" not in by
    # Issues and connections follow the renamed ids.
    assert any(i.get("collectionId") == "col_xray" for i in prof["issues"])
    assert prof["relationships"][0]["to"] == "col_xray"


def test_unknown_files_never_change_confirmed_collections(client):
    """docs/datasets.md §15 criterion 5: an unreadable file is an issue and an inferred
    collection of its own; a confirmed collection keeps its name, id and state."""
    p, ds = _mixed(client)
    with kdb.session_scope() as s:
        row = s.get(DatasetRow, ds["id"])
        row.definition = {**row.definition, "collections": [{"id": "col_xray", "name": "Chest X-rays", "kind": "image", "suggested": False}]}
    before = {c["id"]: (c["name"], c["suggested"]) for c in client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/profile").json()["collections"]}
    imp = _import(client, p, {"mri/more/garbage.xyz": b"\x07\x08\x09"})
    _report(client, imp, {"garbage.xyz": "unknown"}, flags={"garbage.xyz": {"unsupported": "Unknown format"}})
    after = client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}/profile").json()
    by = {c["id"]: c for c in after["collections"]}
    assert (by["col_xray"]["name"], by["col_xray"]["suggested"]) == before["col_xray"] == ("Chest X-rays", False)
    assert by["kind:unknown"]["suggested"] is True
    assert any(i["category"] == "unreadable" for i in after["issues"])
