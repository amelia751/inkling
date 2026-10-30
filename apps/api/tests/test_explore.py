"""todo6 Phase 5: the worker's inspection report, relationship matching rules and recompute,
label mappings, and what confirming a dataset proposal does (the worker itself is tested in
apps/worker/tests/test_inspection.py)."""

from __future__ import annotations

import hashlib

from studio_api.kernel import explore
from studio_api.routes.worker import worker_token

from .conftest import png

W = lambda: {"X-Worker-Token": worker_token()}  # noqa: E731


def _import(client, project_id: str, files: dict[str, bytes]) -> dict:
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = client.post(f"/api/v1/projects/{project_id}/imports", json=body).json()
    for f in s["files"]:
        if f["uploadUrl"]:
            client.put(f["uploadUrl"], content=next(d for rel, d in files.items() if rel.endswith(f["relPath"])))
    return client.post(f"/api/v1/imports/{s['id']}/complete").json()


def _table(header: list[str], rows: list[list[str]]) -> tuple[bytes, dict]:
    text = "\n".join(",".join(r) for r in [header, *rows]) + "\n"
    cols = []
    for i, h in enumerate(header):
        vals = [r[i] for r in rows if r[i]]
        t = "category" if len(set(vals)) < len(vals) else "id"
        cols.append({"name": h, "type": t, "filled": len(vals), "total": len(rows), "distinct": len(set(vals))})
    return text.encode(), {"header": True, "delimiter": "comma", "rowCount": len(rows), "columns": cols, "candidateKeys": [header[0]], "nameColumns": []}


def _report(client, imp: dict, kinds: dict[str, str], facts: dict[str, dict] | None = None, flags: dict[str, dict] | None = None) -> dict:
    files = client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=W()).json()["files"]
    nodes = [{"nodeId": f["nodeId"], "detectedKind": kinds.get(f["name"], "unknown"), "facts": (facts or {}).get(f["name"], {}), "flags": (flags or {}).get(f["name"], {})} for f in files]
    r = client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"inspector": "test", "nodes": nodes}, headers=W())
    assert r.status_code == 200, r.text
    return r.json()


def _proposals(client, project: str) -> dict[str, dict]:
    return {p["kind"]: p for p in client.get(f"/api/v1/projects/{project}/proposals").json()["proposals"]}


def test_patient_ids_match_folders_by_number_but_never_across_names(client):
    p = client.post("/api/v1/projects", json={"title": "MRI"}).json()["id"]
    csv_bytes, prof = _table(["patient_id", "diagnosis"], [["P001", "healthy"], ["p-002", "lesion"], ["3", "healthy"], ["P004", "lesion"], ["Q005", "healthy"]])
    files = {f"study/MRI/patient_00{i}/scan.png": png(4 + i, 4) for i in (1, 2, 3, 5)}
    files["study/echo/patient_002/clip.png"] = png(3, 3)  # the same id in a second folder: ambiguous
    files["study/diagnoses.csv"] = csv_bytes
    imp = _import(client, p, files)
    out = _report(client, imp, {"scan.png": "image", "clip.png": "image", "diagnoses.csv": "table"}, {"diagnoses.csv": {"table": prof}})
    assert out["state"] == "needs_review"
    rel = _proposals(client, p)["relationship"]
    ev = rel["evidence"]
    assert (rel["payload"]["column"], rel["payload"]["target"], rel["payload"]["rule"]) == ("patient_id", "folders", "numeric")
    # P001 = 1 = p-001; "Q005" never meets "patient_005" (different letters); P004 has no folder.
    assert ev["matched"] == 2 and ev["ambiguous"] == 1 and ev["unmatched"] == 2
    assert {r["value"] for r in ev["unmatchedRows"]} == {"P004", "Q005"}
    assert [c["name"] for c in ev["ambiguousRows"][0]["candidates"]] == ["patient_002", "patient_002"]
    assert rel["strength"] == "weak"  # 2 of 5, and letters were ignored
    # Fix the ambiguous row by picking the MRI folder: the server recomputes.
    mri = next(c["nodeId"] for c in ev["ambiguousRows"][0]["candidates"] if c["path"].startswith("MRI/"))
    r = client.post(f"/api/v1/proposals/{rel['id']}/recompute", json={"resolutions": {"1": mri}}).json()
    assert (r["evidence"]["matched"], r["evidence"]["ambiguous"], r["evidence"]["resolved"]) == (3, 0, 1)
    # Changing the comparison drops row fixes made for the old one.
    r = client.post(f"/api/v1/proposals/{rel['id']}/recompute", json={"rule": "normalized"}).json()
    assert r["evidence"]["matched"] == 0 and r["payload"]["resolutions"] == {}
    # Ignoring letters on a column of names is refused: it could link one person to another.
    assert client.post(f"/api/v1/proposals/{rel['id']}/recompute", json={"column": "diagnosis", "rule": "numeric"}).status_code == 422
    assert client.post(f"/api/v1/proposals/{rel['id']}/recompute", json={"resolutions": {"0": "nod-not-here"}}).status_code == 422


def test_mapping_conflicts_and_renames(client):
    p = client.post("/api/v1/projects", json={"title": "Labels"}).json()["id"]
    csv_bytes, prof = _table(["file", "label"], [["a.png", "Normal"], ["b.png", "normal "], ["c.png", "nodule"], ["d.png", "nodule"], ["e.png", "nodule"]])
    imp = _import(client, p, {"x/a.png": png(2, 2), "x/b.png": png(3, 2), "x/c.png": png(4, 2), "x/d.png": png(5, 2), "x/e.png": png(6, 2), "x/t.csv": csv_bytes})
    _report(client, imp, {f"{c}.png": "image" for c in "abcde"} | {"t.csv": "table"}, {"t.csv": {"table": prof}})
    props = _proposals(client, p)
    rel, mp, ds = props["relationship"], props["mapping"], props["dataset"]
    assert (rel["evidence"]["matched"], rel["strength"]) == (5, "strong")
    assert mp["evidence"]["conflicts"] == [{"values": ["Normal", "normal"], "reason": "differ only by case or spacing"}]
    assert mp["strength"] == "possible"
    # Rename both spellings to one class: the server recomputes the classes.
    r = client.post(f"/api/v1/proposals/{mp['id']}/recompute", json={"classes": [{"value": "Normal", "id": "normal"}, {"value": "normal", "id": "normal"}, {"value": "nodule", "id": "nodule"}]}).json()
    assert sorted({c["id"] for c in r["payload"]["classes"]}) == ["nodule", "normal"] and r["evidence"]["merged"] == ["normal"]
    pv = client.get(f"/api/v1/proposals/{ds['id']}/preview").json()
    assert pv["labelClasses"] == ["nodule", "normal"] and pv["importedLabels"] == 5 and {g["label"]: g["count"] for g in pv["groups"]} == {"nodule": 3, "normal": 2}
    # Nothing is applied before a person confirms.
    assert client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"] == []
    client.post(f"/api/v1/proposals/{ds['id']}/recompute", json={"title": "Chest films"})
    out = client.post(f"/api/v1/proposals/{ds['id']}/confirm", json={}).json()
    assert out["dataset"]["title"] == "Chest films" and out["importedLabels"] == 5
    doc = client.get(f"/api/v1/tasks/{out['task']['id']}/document").json()
    assert sorted(a["label"] for a in doc["assets"]) == ["nodule"] * 3 + ["normal"] * 2


def test_held_table_blocks_label_import_until_cleared(client):
    p = client.post("/api/v1/projects", json={"title": "Held"}).json()["id"]
    csv_bytes, prof = _table(["file", "label"], [["a.png", "x"], ["b.png", "y"], ["c.png", "x"]])
    imp = _import(client, p, {"d/a.png": png(2, 2), "d/b.png": png(3, 3), "d/c.png": png(4, 4), "d/t.csv": csv_bytes})
    _report(client, imp, {"a.png": "image", "b.png": "image", "c.png": "image", "t.csv": "table"}, {"t.csv": {"table": prof}}, {"t.csv": {"privacy": {"reason": "Held: column “email” looks like an identifier field", "source": "table"}}})
    props = _proposals(client, p)
    ds = props["dataset"]
    assert client.get(f"/api/v1/proposals/{ds['id']}/preview").json()["blocking"]
    assert client.post(f"/api/v1/proposals/{ds['id']}/confirm", json={}).status_code == 409
    table = props["relationship"]["payload"]["tableNodeId"]
    assert client.post(f"/api/v1/source-nodes/{table}/privacy/clear", json={"reason": "The column is empty in this export"}).status_code == 200
    assert client.post(f"/api/v1/proposals/{ds['id']}/confirm", json={}).json()["importedLabels"] == 3


def test_a_clean_import_is_ready_and_summarised(client):
    p = client.post("/api/v1/projects", json={"title": "Clean"}).json()["id"]
    imp = _import(client, p, {"films/a.png": png(2, 2), "films/b.png": png(3, 3)})
    assert _report(client, imp, {"a.png": "image", "b.png": "image"})["state"] == "ready"
    s = client.get(f"/api/v1/projects/{p}/explore").json()
    assert s["clean"] and s["readyProposalId"] == _proposals(client, p)["dataset"]["id"]
    assert s["files"]["byKind"] == [{"kind": "image", "label": "Images", "count": 2}]
    assert [t["status"] for t in s["tasks"]] == ["proposed"]
    # The report is applied once.
    assert client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"nodes": []}, headers=W()).status_code == 409
    assert client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"nodes": []}).status_code == 401


def test_id_rules():
    assert explore.key_of("a/img_001.PNG", "normalized") == "img001"
    assert explore.key_of("P001", "numeric") == "p|1" and explore.key_of("1", "numeric") == "|1"
    assert explore.prefix_compatible("p|1", "|1") and explore.prefix_compatible("pt|1", "patient|1") and explore.prefix_compatible("p|1", "patient|1")
    assert not explore.prefix_compatible("s|1", "img|1") and not explore.prefix_compatible("q|5", "patient|5")
    assert explore.key_of("Smith", "numeric") is None
    assert explore.numeric_like(["P001", "p-002", "3"]) and not explore.numeric_like(["Smith", "P001"])
