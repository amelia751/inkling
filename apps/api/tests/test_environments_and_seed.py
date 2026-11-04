"""The production stand-ins for apps/web/dev/seed-server.ts: /seed/* and /api/environments/*
(same response shapes, so the Studio runs unchanged against the kernel)."""

from __future__ import annotations

import json

import pytest

from .conftest import png, ws, at_rev

ENV = {"extends": "preset:image-2d", "task": "classification", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "cat"}]}]}


@pytest.fixture
def c(make_client, seed):
    m = json.loads((seed / "manifest.json").read_text())
    m["projects"].append({"id": "with-env", "title": "E", "assets": [], "environment": ENV})
    m["projects"].append({"id": "legacy", "title": "L", "viewer": "pathology", "task": "classification", "labels": ["tumor", "stroma"], "assets": []})
    (seed / "manifest.json").write_text(json.dumps(m))
    (seed / ".annotations").mkdir()
    (seed / ".annotations" / "ws-a.json").write_text("{}")
    return make_client()


# ---- /seed ---------------------------------------------------------------------------------


def test_seed_files_stream_with_ranges(c):
    full = c.get("/seed/img/a.png")
    assert full.status_code == 200 and full.content == png(40, 30) and full.headers["content-type"] == "image/png"
    assert full.headers["accept-ranges"] == "bytes" and int(full.headers["content-length"]) == len(full.content)
    part = c.get("/seed/img/a.png", headers={"Range": "bytes=2-9"})
    assert part.status_code == 206 and part.content == full.content[2:10] and part.headers["content-range"] == f"bytes 2-9/{len(full.content)}"
    tail = c.get("/seed/img/a.png", headers={"Range": "bytes=-4"})
    assert tail.status_code == 206 and tail.content == full.content[-4:]
    assert c.get("/seed/img/a.png", headers={"Range": "bytes=9999-"}).status_code == 416
    assert c.head("/seed/img/a.png").headers["content-length"] == str(len(full.content))
    assert json.loads(c.get("/seed/manifest.json").content)["projects"][0]["id"] == "ws-a"


def test_seed_never_serves_private_or_outside_paths(c):
    assert c.get("/seed/.annotations/ws-a.json").status_code == 404
    assert c.get("/seed/img/missing.png").status_code == 404
    assert c.get("/seed/img/../../etc/passwd").status_code == 404
    assert c.get("/seed/%2e%2e/secret").status_code == 404


# ---- /api/environments -----------------------------------------------------------------------


def test_get_falls_back_to_the_manifest_environment(c):
    assert c.get("/api/environments/with-env").json() == {"revision": 0, "environment": None, "effective": ENV}
    legacy = c.get("/api/environments/legacy").json()["effective"]
    assert legacy["extends"] == "preset:pathology" and legacy["task"] == "classification"
    # A classification task gets only its Choices group (todo8 D4), no region copy.
    assert [g["name"] for g in legacy["labels"]] == ["class"] and legacy["labels"][0]["classes"] == [{"id": "tumor"}, {"id": "stroma"}]
    assert c.get("/api/environments/nope").json() == {"revision": 0, "environment": None, "effective": None}
    assert c.get("/api/environments/Bad_Id").status_code == 400


def test_put_is_optimistic_and_keeps_history(c):
    r = c.put("/api/environments/with-env", json={"revision": 0, "environment": ENV, "author": "ann"})
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["revision"] == 1 and doc["environment"] == ENV and doc["author"] == "ann" and doc["savedAt"].endswith("Z")
    stale = c.put("/api/environments/with-env", json={"revision": 0, "environment": {**ENV, "task": "x"}})
    assert stale.status_code == 409 and stale.json()["error"] == "revision conflict" and stale.json()["current"]["revision"] == 1
    # todo11 D2: no revision is no longer "last writer wins"; it's refused.
    missing = c.put("/api/environments/with-env", json={"environment": {**ENV, "task": "segmentation"}})
    assert missing.status_code == 422 and missing.json()["errors"][0]["path"] == "/revision"
    r = c.put("/api/environments/with-env", json={"revision": 1, "environment": {**ENV, "task": "segmentation"}})
    assert r.json()["revision"] == 2 and r.json()["author"] == "local-expert"
    got = c.get("/api/environments/with-env").json()
    assert got["revision"] == 2 and got["effective"]["task"] == "segmentation" and got["environment"] == got["effective"]
    hist = c.get("/api/environments/with-env/history").json()
    assert [h["revision"] for h in hist] == [1, 2] and hist[0]["environment"] == ENV and set(hist[0]) == {"revision", "environment", "savedAt", "author", "contentHash", "parentHash", "authorKind"}
    assert c.put("/api/environments/with-env", content=b"").status_code == 400
    assert c.put("/api/environments/with-env", json={**at_rev(c, "with-env", None), "environment": "nope"}).status_code == 422


def test_patch_applies_rfc6902_to_the_saved_or_manifest_environment(c):
    r = c.patch("/api/environments/with-env", json={**at_rev(c, "with-env", None), "patch": [{"op": "replace", "path": "/task", "value": "detection"}, {"op": "add", "path": "/labels/0/classes/-", "value": {"id": "dog"}}]})
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1 and r.json()["environment"]["task"] == "detection"
    assert r.json()["environment"]["labels"][0]["classes"] == [{"id": "cat"}, {"id": "dog"}]
    r = c.patch("/api/environments/with-env", json={"revision": 1, "patch": [{"op": "remove", "path": "/task"}]})
    assert r.status_code == 200 and "task" not in r.json()["environment"]
    bad = c.patch("/api/environments/with-env", json={**at_rev(c, "with-env", None), "patch": [{"op": "replace", "path": "/nope/deeper", "value": 1}]})
    assert bad.status_code == 422 and bad.json()["ok"] is False and bad.json()["errors"][0]["path"] == "/0"
    assert c.get("/api/environments/with-env").json()["revision"] == 2  # a failed patch saves nothing
    assert c.patch("/api/environments/with-env", json={**at_rev(c, "with-env", None), "patch": {"op": "x"}}).status_code == 422
    assert c.patch("/api/environments/nope", json={**at_rev(c, "nope", None), "patch": []}).status_code == 404
    assert c.patch("/api/environments/with-env", json={"revision": 0, "patch": []}).status_code == 409


def test_validation_and_catalog_are_served_by_the_api(c):
    """todo11 D2: no more 501 split brain for validation and the catalogue."""
    r = c.post("/api/environments/validate", json=ENV)
    assert r.status_code == 200 and r.json()["ok"], r.text
    bad = c.post("/api/environments/validate", json={**ENV, "tools": ["studio.core.tools.nope"]})
    assert bad.status_code == 422 and bad.json()["errors"][0] == {"path": "/tools/0", "code": "reference", "message": bad.json()["errors"][0]["message"]}
    cat = c.get("/api/catalog").json()
    assert cat["version"] == 1 and cat["modules"] and cat["contributions"]
    assert c.get("/api/catalog/schema").json()["$ref"] == "#/$defs/EnvironmentSpec"
    prompt = c.get("/api/catalog/prompt")  # todo17 M0: the MCP `catalog` tool reads it from the API
    assert prompt.status_code == 200 and prompt.headers["content-type"].startswith("text/markdown") and "# " in prompt.text
    assert c.get("/api/catalog/capabilities").status_code == 501


def test_a_session_token_cant_edit_another_workspace(c):
    tok = c.post("/api/v1/sessions", json={"scopes": ["assets.read"]}, headers=ws("ws-a")).json()["token"]
    assert c.get("/api/environments/with-env", headers={"Authorization": f"Bearer {tok}"}).status_code == 403


# ---- todo10 Phase 1: hashes, parents, provenance, lockfile ------------------------------------


def test_every_revision_has_a_stable_hash_and_a_parent(c):
    from studio_api.kernel.canonical import content_hash

    reordered = json.loads(json.dumps(ENV, sort_keys=True))  # same value, other key order
    a = c.put("/api/environments/with-env", json={**at_rev(c, "with-env", None), "environment": ENV, "author": "ann"}).json()
    b = c.put("/api/environments/with-env", json={**at_rev(c, "with-env", None), "environment": {**ENV, "task": "detection"}}).json()
    back = c.put("/api/environments/with-env", json={**at_rev(c, "with-env", None), "environment": reordered}).json()
    # The first revision's parent is its base (the manifest environment); then each other's.
    assert a["parentHash"] == content_hash(ENV) == a["contentHash"]
    assert b["parentHash"] == a["contentHash"] != b["contentHash"]
    assert back["contentHash"] == a["contentHash"] and back["parentHash"] == b["contentHash"]
    hist = c.get("/api/environments/with-env/history").json()
    assert [h["contentHash"] for h in hist] == [a["contentHash"], b["contentHash"], a["contentHash"]]
    assert all(h["parentHash"].startswith("sha256:") for h in hist) and all(h["authorKind"] == "person" for h in hist)
    assert c.get("/api/environments/with-env").json()["contentHash"] == a["contentHash"]
    # No base at all: the parent is the hash of null.
    from studio_api.kernel.canonical import NULL_CONTENT_HASH

    assert c.get("/api/environments/nope").json()["effective"] is None
    base = c.get("/api/environments/ws-b").json()["effective"]
    first = c.put("/api/environments/ws-b", json={**at_rev(c, "ws-b", None), "environment": ENV}).json()
    assert first["parentHash"] == (content_hash(base) if base is not None else NULL_CONTENT_HASH)


def test_agent_revisions_record_the_run_and_prompt_hash(c):
    ph = "sha256:" + "ab" * 32
    # The Studio's assistant panel: a person's session saying its agent made the change.
    r = c.put("/api/environments/with-env", json={**at_rev(c, "with-env", None), "environment": ENV, "author": "agent:claude", "provenance": {"runId": "run_42", "promptHash": ph}}).json()
    assert r["authorKind"] == "agent" and r["agentRunId"] == "run_42" and r["promptHash"] == ph and r["author"] == "agent:claude"
    # Garbage provenance is dropped, not stored.
    r = c.put("/api/environments/with-env", json={**at_rev(c, "with-env", None), "environment": ENV, "author": "agent:x", "provenance": {"runId": "../etc", "promptHash": "md5:1"}}).json()
    assert r["authorKind"] == "agent" and "agentRunId" not in r and "promptHash" not in r
    # An agent session is always an agent, whatever author it claims.
    tok = c.post("/api/v1/sessions", json={"scopes": ["assets.read"], "agent": "builder"}, headers=ws("with-env")).json()["token"]
    r = c.patch("/api/environments/with-env", json={**at_rev(c, "with-env", None), "patch": [{"op": "replace", "path": "/task", "value": "detection"}], "author": "dr-house"}, headers={"Authorization": f"Bearer {tok}", "X-Agent-Run": "run_7", "X-Agent-Prompt-Hash": ph})
    assert r.status_code == 200, r.text
    assert r.json()["author"] == "agent:run_7" and r.json()["authorKind"] == "agent" and r.json()["agentRunId"] == "run_7" and r.json()["promptHash"] == ph
    kinds = [h["authorKind"] for h in c.get("/api/environments/with-env/history").json()]
    assert kinds == ["agent", "agent", "agent"]


def test_lockfile_is_generated_from_the_workspace_pins_and_round_trips(c):
    from studio_api.kernel import studio_defs
    from studio_api.kernel.canonical import canonicalize, content_hash

    body = c.get("/api/environments/ws-a/lockfile").json()
    lock = body["lockfile"]
    assert lock["lockfileVersion"] == 1 and lock["plugins"], lock
    ids = [p["id"] for p in lock["plugins"]]
    assert ids == sorted(ids)
    for p in lock["plugins"]:
        assert set(p) == {"id", "version", "digest", "signer", "permissions", "configRevision"}
        assert p["digest"].startswith("sha256:") and len(p["digest"]) == 71 and p["signer"] == "first-party"
    # Round trip: the canonical text parses back to the same lockfile with the same hash.
    text = canonicalize(lock)
    assert studio_defs.normalize_lockfile(json.loads(text)) == lock
    assert body["contentHash"] == content_hash(lock) == studio_defs.lockfile_hash(json.loads(text))
    assert c.get("/api/environments/ws-a/lockfile").json()["contentHash"] == body["contentHash"]  # stable


def test_v1_validate_reports_without_the_web_server(c):
    """todo23 W10 (S12): a full report from the kernel alone; a planted bug fails it."""
    r = c.post("/api/v1/environments/validate", json=ENV)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] and body["errors"] == [] and isinstance(body["warnings"], list)
    assert body["resolved"]["task"] == "classification" and body["resolved"].get("viewports")  # preset merged in
    bad = c.post("/api/v1/environments/validate", json={**ENV, "viewports": [{"id": "main", "renderer": "studio.nope.renderers.ghost"}]})
    assert bad.status_code == 200 and not bad.json()["ok"] and bad.json()["resolved"] is None
    assert any(e["code"] in ("schema", "reference") for e in bad.json()["errors"])
    assert c.post("/api/v1/environments/validate", content=b"not json").status_code == 400
