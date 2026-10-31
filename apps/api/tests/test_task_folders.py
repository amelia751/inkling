"""todo8 D3: the task document's items carry their current Data folder (below the task's
common folder) and their source node, and follow renames in Files."""

from __future__ import annotations

from .conftest import png
from .test_files import _by_name, _inspect_all, _new, _ops


def _doc(client, task: str) -> dict[str, dict]:
    doc = client.get(f"/api/v1/tasks/{task}/document").json()
    return {a["nodeId"]: a for a in doc["assets"]}


def test_folders_are_current_paths_below_the_common_folder(client):
    files = {
        "cardiac/2024/mri/patient_07/series_2/IM-0001.png": png(4, 4),
        "cardiac/2024/mri/patient_08/series_2/IM-0001.png": png(5, 5),
        "cardiac/2024/mri/patient_08/IM-0002.png": png(6, 6),
    }
    p, _, imp = _new(client, files)
    _inspect_all(client, imp)
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [n["cardiac"].id], "task": {"title": "Outline", "preset": "preset:image-2d"}}).json()
    task = ds["tasks"][0]["id"]
    doc = _doc(client, task)
    assert len(doc) == 3
    # Duplicate names keep their own node and folder; the shared `cardiac/2024/mri` is stripped.
    by_folder = sorted((tuple(a["folder"]), a["name"]) for a in doc.values())
    assert by_folder == [(("patient_07", "series_2"), "IM-0001.png"), (("patient_08",), "IM-0002.png"), (("patient_08", "series_2"), "IM-0001.png")]
    assert len({a["nodeId"] for a in doc.values()}) == 3 and all(a["nodeId"].startswith("nod-") for a in doc.values())

    # A rename in Files changes `folder` on the next fetch (computed from the parent chain,
    # never the original path); item ids (asset paths) don't move.
    paths = {k: a["path"] for k, a in doc.items()}
    patient_07 = next(x for x in _by_name(p).values() if x.name == "patient_07")
    assert _ops(client, p, [{"kind": "rename", "nodeId": patient_07.id, "name": "patient_seven"}]).status_code == 200
    after = _doc(client, task)
    assert {k: a["path"] for k, a in after.items()} == paths
    assert sorted(tuple(a["folder"]) for a in after.values()) == [("patient_08",), ("patient_08", "series_2"), ("patient_seven", "series_2")]


def test_a_single_folder_task_has_empty_folders(client):
    p, _, imp = _new(client, {"study/a.png": png(4, 4), "study/b.png": png(5, 5)})
    _inspect_all(client, imp)
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Two", "nodeIds": [n["study"].id], "task": {"title": "Look", "preset": "preset:image-2d"}}).json()
    assert [a["folder"] for a in _doc(client, ds["tasks"][0]["id"]).values()] == [[], []]


def test_sample_documents_carry_nodes_and_folders(client):
    doc = client.get("/api/v1/tasks/ws-a/document").json()
    assert doc["assets"] and all(a.get("nodeId") and isinstance(a.get("folder"), list) for a in doc["assets"])
    first = doc["assets"][0]
    detail = client.get(f"/api/v1/source-nodes/{first['nodeId']}").json()
    assert detail["pathText"].endswith(first["path"].split("/")[-1])


def test_classification_gets_only_its_choices_group():
    from studio_api.kernel.projects import label_groups

    assert label_groups(["normal", "pneumonia"], "classification") == [{"name": "class", "control": "Choices", "classes": [{"id": "normal"}, {"id": "pneumonia"}]}]
    assert label_groups(["tumor"], "segmentation") == [{"name": "labels", "control": "Labels", "classes": [{"id": "tumor"}]}]
