"""todo17 Milestone 1: admission pipeline, lint families, problem JSON, dry run, idempotency."""

from __future__ import annotations

import threading

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.pool import StaticPool

from studio_api.kernel.admission import Admitted, Ctx, Operation, PermissionDenied, WriteRejected, admit, normalise
from studio_api.kernel.admission import http as wh
from studio_api.kernel.admission.idempotency import IdempotencyError, MemoryIdempotencyStore, SqlIdempotencyStore, run_idempotent
from studio_api.kernel.admission.problem import problem, with_findings
from studio_api.kernel.lint import datasets, labels, layout, resolve_severity

RULES = {
    "labels": [
        {"id": "label-lv", "name": "Left ventricle", "synonyms": ["LV", "left-ventricle"], "allowedGeometries": ["polygon", "mask"]},
        {"id": "label-rv", "name": "Right ventricle"},
    ],
    "layout": {"folderPatterns": ["raw/*", "derived/*"], "fileNamePattern": r"[a-z0-9_]+\.(dcm|png)", "forbiddenCharacters": " #?", "maxDepth": 3},
    "datasets": {"requiredMetadata": ["modality", "license"], "uniqueNames": True, "oneModalityPerDataset": True},
}


def ann(label, geo="polygon"):
    return {"label": label, "geometry": {"type": geo}}


def codes(vs):
    return sorted(v.rule for v in vs)


# --- labels ---------------------------------------------------------------------------------


def test_labels_good():
    assert labels.check({"annotations": [ann("Left ventricle"), ann("right ventricle", "box")]}, RULES) == []


def test_labels_unknown_lists_allowed():
    (v,) = labels.check({"annotations": [ann("Aorta")]}, RULES)
    assert v.rule == "label.unknown" and v.severity == "error" and v.path == "/annotations/0/label"
    assert v.allowed == ["Left ventricle", "Right ventricle"] and v.fix and v.docs.endswith("label.unknown")


def test_labels_synonym_is_fixable_by_normaliser():
    out, fixes = normalise({"annotations": [ann("  LV ")]}, RULES)
    assert out["annotations"][0]["label"] == "Left ventricle"
    assert codes(fixes) == ["label.synonym"]
    assert labels.check(out, RULES) == []


def test_geometry_not_allowed():
    (v,) = labels.check({"annotations": [ann("LV", "box")]}, RULES)[1:]
    assert v.rule == "geometry.not-allowed" and v.allowed == ["polygon", "mask"]


def test_no_label_set_accepts_anything():
    assert labels.check({"annotations": [ann("x")]}, {}) == []


# --- layout ---------------------------------------------------------------------------------


def test_layout_good():
    assert layout.check({"path": "raw/ct/scan_01.dcm"}, RULES) == []


def test_layout_misplaced_and_name_pattern_never_echo_value():
    vs = layout.check({"path": "misc/John Smith.dcm"}, RULES)
    assert codes(vs) == ["layout.forbidden-char", "layout.misplaced", "name.pattern", "name.phi-suspect"]
    for v in vs:
        assert "value" not in v.to_json()
        assert "John" not in str(v.to_json())


def test_layout_too_deep_and_paths_list():
    vs = layout.check({"paths": ["raw/a/b/c/d.png", "raw/x/ok.png"]}, RULES)
    assert [(v.rule, v.path) for v in vs] == [("layout.too-deep", "/paths/0")]


# --- datasets -------------------------------------------------------------------------------


def test_dataset_good():
    d = {"dataset": {"name": "Cardiac", "metadata": {"modality": "MR", "license": "CC-BY"}, "modalities": ["MR"]}, "existingNames": ["Other"]}
    assert datasets.check(d, RULES) == []


def test_dataset_missing_metadata_and_name_taken():
    d = {"dataset": {"name": "cardiac ", "metadata": {"modality": "MR"}}, "existingNames": ["Cardiac"]}
    vs = datasets.check(d, RULES)
    assert codes(vs) == ["dataset.metadata-missing", "dataset.name-taken"]
    taken = next(v for v in vs if v.rule == "dataset.name-taken").to_json()
    assert "value" not in taken


def test_dataset_mixed_modality_is_evaluate_mode():
    d = {"dataset": {"name": "x", "metadata": {"modality": "MR", "license": "a"}, "modalities": ["MR", "CT"]}}
    (v,) = datasets.check(d, RULES)
    assert resolve_severity(v, RULES).evaluate is True
    assert resolve_severity(v, {**RULES, "enforce": ["dataset.mixed-modality"]}).evaluate is False


# --- admit ----------------------------------------------------------------------------------

saved: list = []
OP = Operation(id="test.annotations.save", families=[labels.check], persist=lambda v, ctx: saved.append(v) or {"saved": len(v["annotations"])})
DS_OP = Operation(
    id="test.datasets.create",
    families=[datasets.check],
    defaults={"dataset": {"metadata": {}}},
    prepare=lambda v, ctx: v.setdefault("existingNames", ctx.extra.get("names", [])),
    persist=lambda v, ctx: {"id": "ds1"},
)


def test_admit_persists_normalised_value_and_returns_findings():
    saved.clear()
    res = admit(OP, {"annotations": [ann("LV́ ".replace("́", "")), ann("Right ventricle")]}, Ctx(rules=RULES))
    assert isinstance(res, Admitted) and res.value == {"saved": 2}
    assert saved[0]["annotations"][0]["label"] == "Left ventricle"
    assert codes(res.findings) == ["label.synonym"]


def test_admit_rejects_with_every_violation():
    with pytest.raises(WriteRejected) as e:
        admit(OP, {"annotations": [ann("Aorta"), ann("LV", "box"), ann("Spleen")]}, Ctx(rules=RULES))
    assert codes(e.value.violations) == ["geometry.not-allowed", "label.synonym", "label.unknown", "label.unknown"]


def test_admit_dry_run_saves_nothing():
    saved.clear()
    res = admit(OP, {"annotations": [ann("LV")]}, Ctx(rules=RULES), dry_run=True)
    assert saved == [] and res.dry_run and res.value["annotations"][0]["label"] == "Left ventricle"
    with pytest.raises(WriteRejected):
        admit(OP, {"annotations": [ann("Aorta")]}, Ctx(rules=RULES), dry_run=True)


def test_severity_override_downgrades_and_off_silences():
    res = admit(OP, {"annotations": [ann("Aorta")]}, Ctx(rules={**RULES, "severityOverrides": {"label.unknown": "warn"}}))
    assert [(f.rule, f.severity) for f in res.findings] == [("label.unknown", "warn")]
    res = admit(OP, {"annotations": [ann("Aorta")]}, Ctx(rules={**RULES, "severityOverrides": {"label.unknown": "off"}}))
    assert res.findings == []


def test_evaluate_mode_records_but_never_rejects():
    rules = {**RULES, "severityOverrides": {"dataset.mixed-modality": "error"}}
    d = {"dataset": {"name": "x", "metadata": {"modality": "MR", "license": "a"}, "modalities": ["MR", "CT"]}}
    res = admit(DS_OP, d, Ctx(rules=rules))
    assert res.value == {"id": "ds1"} and res.findings[0].evaluate and res.findings[0].severity == "error"
    with pytest.raises(WriteRejected):
        admit(DS_OP, d, Ctx(rules={**rules, "enforce": ["dataset.mixed-modality"]}))


def test_admit_defaults_and_injected_existing_names():
    with pytest.raises(WriteRejected) as e:
        admit(DS_OP, {"dataset": {"name": "Taken", "metadata": {"modality": "MR", "license": "a"}}}, Ctx(rules=RULES, extra={"names": ["taken"]}))
    assert codes(e.value.violations) == ["dataset.name-taken"]
    # dataset.metadata-missing ships in evaluate mode (lint-rules.ts): recorded, not rejected...
    assert codes(admit(DS_OP, {}, Ctx(rules=RULES)).findings) == ["dataset.metadata-missing", "dataset.metadata-missing"]
    # ...until the project promotes it.
    with pytest.raises(WriteRejected) as e:
        admit(DS_OP, {}, Ctx(rules={**RULES, "enforce": ["dataset.metadata-missing"]}))
    assert codes(e.value.violations) == ["dataset.metadata-missing", "dataset.metadata-missing"]


def test_rules_loader_is_injectable_callable():
    seen = []
    admit(OP, {"annotations": []}, Ctx(project_id="p1", rules=lambda pid: seen.append(pid) or RULES))
    assert seen == ["p1"]


def test_permit_scope_and_role():
    op = Operation(id="t.scoped", scope="project:write", roles=frozenset({"owner", "editor"}))
    admit(op, {}, Ctx(rules={}, scopes=frozenset({"project:write"}), role="editor"))
    with pytest.raises(PermissionDenied):
        admit(op, {}, Ctx(rules={}, scopes=frozenset({"project:read"})))
    with pytest.raises(PermissionDenied):
        admit(op, {}, Ctx(rules={}, role="viewer"))


def test_problem_json_shape():
    with pytest.raises(WriteRejected) as e:
        admit(OP, {"annotations": [ann("Aorta")]}, Ctx(rules=RULES))
    p = problem(e.value)
    assert set(p) == {"type", "title", "status", "code", "violations", "retryable"}
    assert p["status"] == 422 and p["code"] == "write_rejected" and p["retryable"] is False
    assert set(p["violations"][0]) == {"rule", "severity", "path", "value", "allowed", "message", "fix", "docs"}


# --- idempotency ----------------------------------------------------------------------------


def _counter():
    n = {"calls": 0}

    def fn():
        n["calls"] += 1
        return 201, {"id": n["calls"]}

    return n, fn


def _stores():
    eng = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    with eng.begin() as c:
        c.execute(text("CREATE TABLE idempotency_keys (key TEXT, principal TEXT, op_id TEXT, body_hash TEXT, status TEXT, response TEXT, created_at TIMESTAMP, PRIMARY KEY (key, principal))"))
    return [MemoryIdempotencyStore(), SqlIdempotencyStore(eng)]


@pytest.mark.parametrize("store", _stores(), ids=["memory", "sql"])
def test_idempotency_semantics(store):
    n, fn = _counter()
    assert run_idempotent(store, "k1", "user:a", "op", {"x": 1}, fn) == (201, {"id": 1})
    assert run_idempotent(store, "k1", "user:a", "op", {"x": 1}, fn) == (201, {"id": 1})
    assert n["calls"] == 1
    with pytest.raises(IdempotencyError) as e:
        run_idempotent(store, "k1", "user:a", "op", {"x": 2}, fn)
    assert e.value.status == 422
    # another principal's key is a different key
    assert run_idempotent(store, "k1", "user:b", "op", {"x": 2}, fn) == (201, {"id": 2})
    # in progress -> 409
    assert store.begin("k2", "user:a", "op", "h") is None
    with pytest.raises(IdempotencyError) as e:
        store.begin("k2", "user:a", "op", "h")
    assert e.value.status == 409
    # failure releases the key
    def boom():
        raise RuntimeError

    with pytest.raises(RuntimeError):
        run_idempotent(store, "k3", "user:a", "op", {}, boom)
    assert run_idempotent(store, "k3", "user:a", "op", {}, fn)[0] == 201
    # no key: always runs
    run_idempotent(store, None, "user:a", "op", {}, fn)
    run_idempotent(store, None, "user:a", "op", {}, fn)
    assert n["calls"] == 5


def test_memory_store_concurrent_duplicate_gets_409():
    store = MemoryIdempotencyStore()
    gate, results = threading.Event(), []

    def slow():
        gate.wait(2)
        return 200, {}

    t = threading.Thread(target=lambda: results.append(run_idempotent(store, "k", "p", "op", {}, slow)))
    t.start()
    while store._rows.get(("k", "p")) is None:
        pass
    with pytest.raises(IdempotencyError) as e:
        run_idempotent(store, "k", "p", "op", {}, slow)
    gate.set()
    t.join()
    assert e.value.status == 409 and results == [(200, {})]


# --- HTTP glue ------------------------------------------------------------------------------


def _app():
    app = FastAPI()
    wh.install(app)
    store = MemoryIdempotencyStore()

    @app.post("/a", openapi_extra=wh.declares(OP.id))
    def save(body: dict, w: wh.WriteParams = Depends(wh.write_params)):
        def go():
            res = admit(OP, body, Ctx(rules=RULES), dry_run=w.dry_run)
            return 200, with_findings({"value": res.value}, res)

        return run_idempotent(store, w.idempotency_key, "user:a", OP.id, body, go)[1]

    return TestClient(app)


def test_http_rejection_is_problem_json():
    r = _app().post("/a", json={"annotations": [ann("Aorta"), ann("Spleen")]})
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/problem+json")
    assert len(r.json()["violations"]) == 2


def test_http_dry_run_and_findings():
    saved.clear()
    r = _app().post("/a?dryRun=true", json={"annotations": [ann("LV")]})
    assert r.status_code == 200 and r.json()["dryRun"] is True and saved == []
    assert r.json()["findings"][0]["rule"] == "label.synonym"


def test_http_idempotency_key_conflict():
    c = _app()
    h = {"Idempotency-Key": "abc"}
    assert c.post("/a", json={"annotations": []}, headers=h).status_code == 200
    r = c.post("/a", json={"annotations": [ann("LV")]}, headers=h)
    assert r.status_code == 422 and r.json()["code"] == "idempotency_key_reused"
