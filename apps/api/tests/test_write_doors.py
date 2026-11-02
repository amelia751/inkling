"""todo17 Milestone 1, annotation and environment doors: the Studio annotation save, the plugin
annotation commit and environment saves (PUT/PATCH and the legacy workspace PUT) run admit():
synonyms normalised, every violation as problem JSON, warnings as findings, dry run, idempotency."""

from __future__ import annotations

import copy

import pytest

from studio_api.kernel import labelset
import studio_api.kernel.lint.annotations as lint_annotations
from studio_api.kernel.lint import resolve_severity

from .test_annotations_write import box, claim_job
from .test_write_policy import VALID, ann

RULES = {
    "labels": [
        {"id": "normal", "name": "Normal", "synonyms": ["no finding"], "allowedGeometries": ["box", "polygon"]},
        {"id": "pneumonia", "name": "Pneumonia", "synonyms": ["PNA", "consolidation"], "allowedGeometries": ["box", "polygon"]},
        {"id": "nodule", "name": "Nodule", "attributes": {"type": "object", "required": ["size_mm"]}},
    ],
    "annotations": {"insideImage": True, "minSize": 4, "requiredAttributes": []},
}


def project_with_rules(c, rules=RULES, env=VALID):
    pid = c.post("/api/v1/projects", json={"title": "P"}).json()["id"]
    r = c.put(f"/api/v1/projects/{pid}/rules", json={"rules": rules, "baseRevision": 0})
    assert r.status_code == 200, r.text
    if env is not None:
        r = c.put(f"/api/v1/workspaces/{pid}/environment", json={"environment": env})
        assert r.status_code == 200, r.text
    return pid


def full(i, label, **geo):
    return ann(i, label, geometry={"type": "box", "x": 1, "y": 1, "w": 10, "h": 10, **geo})


# ---- The annotations lint family (good / bad / fixable) ------------------------------------------


def rule_codes(vs):
    return [v.rule for v in vs]


def test_family_good():
    data = {"annotations": [full(0, "normal")], "items": {"img/a.png": {"width": 100, "height": 100}}}
    assert lint_annotations.check(data, RULES) == []


def test_family_invalid_shape():
    (v,) = lint_annotations.check({"annotations": [{**full(0, "normal"), "provenance": "made-up"}]}, RULES)
    assert v.rule == "annotation.invalid" and v.path == "/annotations/0" and v.severity == "error"


def test_family_out_of_bounds_only_when_dimensions_known():
    a = full(0, "normal", x=95)
    assert lint_annotations.check({"annotations": [a]}, RULES) == []
    (v,) = lint_annotations.check({"annotations": [a], "items": {"img/a.png": {"width": 100, "height": 100}}}, RULES)
    assert v.rule == "annotation.out-of-bounds" and v.path == "/annotations/0/geometry"
    assert resolve_severity(v, RULES).evaluate is True  # evaluate mode (D5): recorded, not rejected
    assert lint_annotations.check({"annotations": [a], "items": {"img/a.png": {"width": 100, "height": 100}}}, {**RULES, "annotations": {"insideImage": False}}) == []


def test_family_too_small_and_per_geometry_min_size():
    a = full(0, "normal", w=2, h=3)
    (v,) = lint_annotations.check({"annotations": [a]}, RULES)
    assert v.rule == "annotation.too-small" and v.severity == "warn" and v.value == 3
    assert lint_annotations.check({"annotations": [a]}, {**RULES, "annotations": {"minSize": {"polygon": 50}}}) == []


def test_family_required_attributes_from_rules_and_label_schema():
    nod = full(0, "nodule")
    (v,) = lint_annotations.check({"annotations": [nod]}, RULES)
    assert v.rule == "annotation.attribute-missing" and v.path == "/annotations/0/attributes/size_mm"
    assert lint_annotations.check({"annotations": [{**nod, "attributes": {"size_mm": 4}}]}, RULES) == []
    rules = {**RULES, "annotations": {"requiredAttributes": ["reader"]}}
    assert rule_codes(lint_annotations.check({"annotations": [full(0, "normal")]}, rules)) == ["annotation.attribute-missing"]


def test_label_set_resolves_presets_and_canonicalises():
    labels = labelset.environment_labels({"extends": "preset:ecg"})
    assert "QRS complex" in labels  # preset-only labels count
    anns = [{"label": "PNA"}, {"label": "Pneumonia"}, {"label": "pneumonia"}, {"label": "cat"}]
    fixes = labelset.canonicalise(anns, RULES, ["normal"])
    assert [a["label"] for a in anns] == ["pneumonia", "pneumonia", "pneumonia", "cat"]
    assert rule_codes(fixes) == ["label.synonym", "label.synonym"] and fixes[0].allowed == ["pneumonia"]


# ---- PUT /api/annotations/{id} -------------------------------------------------------------------


def test_annotation_save_normalises_synonyms_and_returns_findings(client):
    pid = project_with_rules(client)
    doc = {"revision": 0, "annotations": [full(1, "PNA"), full(2, "Normal"), full(3, "normal", w=2, h=2)]}
    r = client.put(f"/api/annotations/{pid}", json=doc)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [a["label"] for a in body["annotations"]] == ["pneumonia", "normal", "normal"]
    assert sorted(f["rule"] for f in body["findings"]) == ["annotation.too-small", "label.synonym", "label.synonym"]
    saved = client.get(f"/api/annotations/{pid}").json()
    assert [a["label"] for a in saved["annotations"]] == ["pneumonia", "normal", "normal"] and saved["revision"] == 1


def test_annotation_save_rejects_every_violation_as_problem_json(client):
    pid = project_with_rules(client)
    doc = {"revision": 0, "annotations": [full(1, "cat"), {**full(2, "normal"), "geometry": {"type": "ellipse", "cx": 5, "cy": 5, "rx": 3, "ry": 3}}, full(3, "PNA")]}
    r = client.put(f"/api/annotations/{pid}", json=doc)
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == "write_rejected" and body["status"] == 422 and body["retryable"] is False
    rules = sorted(v["rule"] for v in body["violations"])
    assert rules == ["geometry.not-allowed", "label.synonym", "label.unknown"]
    unknown = next(v for v in body["violations"] if v["rule"] == "label.unknown")
    assert unknown["path"] == "/annotations/0/label" and "Pneumonia" in unknown["allowed"] and unknown["fix"] and unknown["docs"]
    assert client.get(f"/api/annotations/{pid}").json()["revision"] == 0


def test_annotation_save_enforced_evaluate_rule_rejects(client):
    pid = project_with_rules(client, {**RULES, "enforce": ["annotation.out-of-bounds"]})
    doc = {"revision": 0, "annotations": [full(1, "normal", x=95)], "items": {"img/a.png": {"width": 100, "height": 100}}}
    r = client.put(f"/api/annotations/{pid}", json=doc)
    assert r.status_code == 422 and [v["rule"] for v in r.json()["violations"]] == ["annotation.out-of-bounds"]


def test_annotation_save_dry_run_saves_nothing(client):
    pid = project_with_rules(client)
    r = client.put(f"/api/annotations/{pid}?dryRun=true", json={"revision": 0, "annotations": [full(1, "PNA")]})
    assert r.status_code == 200 and r.json()["dryRun"] is True
    assert r.json()["annotations"][0]["label"] == "pneumonia" and [f["rule"] for f in r.json()["findings"]] == ["label.synonym"]
    assert client.get(f"/api/annotations/{pid}").json() == {"revision": 0, "annotations": []}
    bad = client.put(f"/api/annotations/{pid}?dryRun=true", json={"revision": 0, "annotations": [full(1, "cat")]})
    assert bad.status_code == 422


def test_annotation_save_idempotent_replay(client):
    pid = project_with_rules(client)
    doc = {"revision": 0, "annotations": [full(1, "normal")]}
    h = {"Idempotency-Key": "save-1"}
    first = client.put(f"/api/annotations/{pid}", json=doc, headers=h)
    again = client.put(f"/api/annotations/{pid}", json=doc, headers=h)
    assert first.status_code == again.status_code == 200 and first.json() == again.json()
    assert client.get(f"/api/annotations/{pid}").json()["revision"] == 1  # saved once
    other = client.put(f"/api/annotations/{pid}", json={**doc, "revision": 1}, headers=h)
    assert other.status_code == 422 and other.json()["code"] == "idempotency_key_reused"
    # A rejected write doesn't burn its key.
    k = {"Idempotency-Key": "save-2"}
    assert client.put(f"/api/annotations/{pid}", json={"revision": 1, "annotations": [full(1, "cat")]}, headers=k).status_code == 422
    r = client.put(f"/api/annotations/{pid}", json={"revision": 1, "annotations": [full(1, "normal")]}, headers=k)
    assert r.status_code == 200, r.text


# ---- POST /api/v1/annotations (plugin commit) ----------------------------------------------------


def test_plugin_commit_runs_admission(registry_client):
    c = registry_client()
    _, h = claim_job(c)
    # ws-a isn't a project with rules: any label, as before; findings are returned.
    r = c.post("/api/v1/annotations", json={"annotations": [box()]}, headers=h)
    assert r.status_code == 200 and r.json()["findings"] == []
    dry = c.post("/api/v1/annotations?dryRun=true", json={"annotations": [box(id="b2")]}, headers=h)
    assert dry.status_code == 200 and dry.json()["dryRun"] is True
    assert len(c.get("/api/annotations/ws-a", headers={"X-Workspace-Id": "ws-a"}).json()["annotations"]) == 1
    bad = c.post("/api/v1/annotations", json={"annotations": [box(label="")]}, headers=h)
    assert bad.status_code == 422 and bad.json()["violations"][0]["rule"] == "annotation.invalid"


# ---- Environment saves -----------------------------------------------------------------------------


@pytest.mark.parametrize("route", ["legacy", "put"])
def test_environment_unresolved_is_problem_json(client, route):
    pid = project_with_rules(client, env=None)
    bad = copy.deepcopy(VALID)
    bad["tools"] = ["nope.tool"]
    if route == "legacy":
        r = client.put(f"/api/v1/workspaces/{pid}/environment", json={"environment": bad})
    else:
        r = client.put(f"/api/environments/{pid}", json={"revision": 0, "environment": bad})
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "write_rejected" and body["violations"] and all(v["rule"] == "env.unresolved" for v in body["violations"])
    assert body["errors"][0]["code"] == "reference" and body["ok"] is False  # legacy fields kept for clients
    assert client.get(f"/api/environments/{pid}").json()["revision"] == 0


def test_environment_label_drift_is_a_finding(client):
    pid = project_with_rules(client, env=None)
    drift = copy.deepcopy(VALID)
    drift["labels"][0]["classes"] += [{"id": "PNA"}, {"id": "cat"}]
    r = client.put(f"/api/environments/{pid}", json={"revision": 0, "environment": drift})
    assert r.status_code == 200, r.text
    findings = r.json()["findings"]
    assert sorted(f["value"] for f in findings if f["rule"] == "env.label-drift") == ["PNA", "cat"]
    assert r.json()["revision"] == 1
    legacy = client.put(f"/api/v1/workspaces/{pid}/environment", json={"environment": drift})
    assert legacy.status_code == 200 and {f["rule"] for f in legacy.json()["findings"]} == {"env.label-drift"}


def test_environment_dry_run_and_idempotency(client):
    pid = project_with_rules(client, env=None)
    r = client.put(f"/api/environments/{pid}?dryRun=true", json={"revision": 0, "environment": VALID})
    assert r.status_code == 200 and r.json()["dryRun"] is True and r.json()["environment"] == VALID
    assert client.get(f"/api/environments/{pid}").json()["revision"] == 0
    h = {"Idempotency-Key": "env-1"}
    first = client.put(f"/api/environments/{pid}", json={"revision": 0, "environment": VALID}, headers=h)
    again = client.put(f"/api/environments/{pid}", json={"revision": 0, "environment": VALID}, headers=h)
    assert first.status_code == again.status_code == 200 and first.json() == again.json()  # replay, not a 409
    assert client.get(f"/api/environments/{pid}").json()["revision"] == 1
    # Without a key the same retry is a stale revision.
    assert client.put(f"/api/environments/{pid}", json={"revision": 0, "environment": VALID}).status_code == 409
    patch = client.patch(f"/api/environments/{pid}?dryRun=true", json={"revision": 1, "patch": [{"op": "add", "path": "/labels/0/classes/-", "value": {"id": "cat"}}]})
    assert patch.status_code == 200 and [f["value"] for f in patch.json()["findings"]] == ["cat"]
    assert client.get(f"/api/environments/{pid}").json()["revision"] == 1


def test_routes_declare_their_operations(client):
    spec = client.get("/openapi.json").json()["paths"]
    assert spec["/api/annotations/{project_id}"]["put"]["x-operation"] == "annotations.save"
    assert spec["/api/v1/annotations"]["post"]["x-operation"] == "annotations.commit"
    assert spec["/api/environments/{project_id}"]["put"]["x-operation"] == "studio.save"
    assert spec["/api/environments/{project_id}"]["patch"]["x-operation"] == "studio.patch"
    assert spec["/api/v1/workspaces/{workspace_id}/environment"]["put"]["x-operation"] == "studio.save"
