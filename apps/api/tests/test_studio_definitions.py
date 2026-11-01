"""todo10 Phase 2: the Studio definition (`.studio/`: lockfile, environments, READMEs) is
committed into the dataset's repository at meaningful moments, a release pins it, and
restoring an old version restores it. Against the in-memory fake of apps/versioning."""

from __future__ import annotations

import pytest

from studio_api.kernel import studio_defs
from studio_api.kernel.canonical import content_hash

from .test_versioning import ALICE, BOB, ann, deid_pass, fake, save, vc, work  # noqa: F401

ENV1 = {"extends": "preset:image-2d", "task": "classification", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "cat"}]}]}
ENV2 = {**ENV1, "task": "detection"}


def put_env(c, env, headers=ALICE):
    r = c.put("/api/environments/ws-a", json={"environment": env}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def studio(c, ref, **params):
    r = c.get("/api/v1/datasets/ds/studio", params={"ref": ref, **params}, headers=ALICE)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def setup(vc):  # noqa: F811
    put_env(vc, ENV1)
    assert vc.put("/api/environments/ws-a/readme", json={"text": "# Cats\n\nOne class per image.\n"}, headers=ALICE).status_code == 200
    return vc


def test_task_setup_saved_commits_the_studio_and_annotation_saves_keep_it(setup):
    c = setup
    b = work(c, ALICE)
    r = c.post("/api/v1/datasets/ds/studio/commits", json={"reason": "Task setup saved"}, headers=ALICE)
    assert r.status_code == 201, r.text
    s1 = r.json()["studio"]
    assert s1["tasks"]["ws-a"] == content_hash(ENV1) and s1["lockfileHash"].startswith("sha256:")
    # Nothing changed: no new commit.
    assert c.post("/api/v1/datasets/ds/studio/commits", json={"reason": "again"}, headers=ALICE).json() == {"branch": b["name"], "unchanged": True}
    at = studio(c, b["name"])
    assert at["tasks"]["ws-a"]["environment"] == ENV1 and at["tasks"]["ws-a"]["readme"].startswith("# Cats")
    assert at["lockfile"] == c.get("/api/environments/ws-a/lockfile", headers=ALICE).json()["lockfile"]
    # An annotation save keeps the branch's Studio setup.
    head = work(c, ALICE)
    assert save(c, ALICE, head, [ann("a1")]).status_code == 201
    assert studio(c, b["name"])["studioTree"] == at["studioTree"]


def test_a_release_pins_the_environment_and_lockfile(setup):
    c = setup
    b = work(c, ALICE)
    assert save(c, ALICE, b, [ann("a1")]).status_code == 201
    # Requesting review commits the current setup onto the source first.
    rv = c.post("/api/v1/datasets/ds/reviews", json={"title": "first"}, headers=ALICE).json()
    rv = deid_pass(c, rv)
    assert c.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/approve", json={"source_oid": rv["source_oid"]}, headers=BOB).status_code == 200
    assert c.post(f"/api/v1/datasets/ds/reviews/{rv['id']}/merge", json={}, headers=BOB).status_code == 200
    lock = c.get("/api/environments/ws-a/lockfile", headers=ALICE).json()
    rel = c.post("/api/v1/datasets/ds/releases", json={"tag": "v1", "ref": "main"}, headers=BOB)
    assert rel.status_code == 201, rel.text
    pinned = rel.json()["studio"]
    assert pinned["tasks"] == {"ws-a": content_hash(ENV1)} and pinned["lockfileHash"] == lock["contentHash"] and "studioWarning" not in rel.json()
    # Later changes don't move what v1 pinned.
    put_env(c, ENV2)
    v1 = studio(c, "tag:v1", current=True)
    assert v1["tasks"]["ws-a"]["environment"] == ENV1 and v1["lockfile"] == lock["lockfile"]
    assert v1["current"]["tasks"]["ws-a"]["environment"] == ENV2 and v1["current"]["summary"]["fingerprint"] != v1["summary"]["fingerprint"]


def test_restoring_an_old_version_restores_its_studio_setup(setup):
    c = setup
    b = work(c, ALICE)
    first = c.post("/api/v1/datasets/ds/studio/commits", json={"reason": "Task setup saved"}, headers=ALICE).json()
    put_env(c, ENV2)
    second = c.post("/api/v1/datasets/ds/studio/commits", json={"reason": "Task setup saved"}, headers=ALICE).json()
    assert second["studio"]["tasks"]["ws-a"] == content_hash(ENV2)
    # A plugin pin changes too (disable one): the old version's lockfile brings it back.
    pins = c.get("/api/environments/ws-a/lockfile", headers=ALICE).json()["lockfile"]["plugins"]
    victim = pins[-1]["id"]
    from studio_api import db as kdb
    from studio_api.context import RequestContext
    from studio_api.plugins import installer

    with kdb.session_scope() as s:
        installer._pin(s, RequestContext("ws-a", "user:alice", "t"), victim, pins[-1]["version"], pins[-1]["digest"], 0, "DISABLED")
    assert victim not in [p["id"] for p in c.get("/api/environments/ws-a/lockfile", headers=ALICE).json()["lockfile"]["plugins"]]
    head = work(c, ALICE)
    r = c.post("/api/v1/datasets/ds/reverts", json={"branch": b["name"], "expected_head": head["commit_oid"], "target_oid": first["commit_oid"]}, headers=ALICE)
    assert r.status_code == 201, r.text
    restored = r.json()["restoredStudio"]
    assert restored["environments"]["ws-a"]["contentHash"] == content_hash(ENV1) and victim in restored["plugins"]["restored"]
    got = c.get("/api/environments/ws-a", headers=ALICE).json()
    assert got["environment"] == ENV1 and got["contentHash"] == content_hash(ENV1)
    assert victim in [p["id"] for p in c.get("/api/environments/ws-a/lockfile", headers=ALICE).json()["lockfile"]["plugins"]]
    assert studio_defs.content_hash(c.get("/api/environments/ws-a/lockfile", headers=ALICE).json()["lockfile"]) == first["studio"]["lockfileHash"]


def test_an_agent_can_commit_only_to_its_branch_and_never_restores(setup):
    from .test_versioning import agent_token

    c = setup
    h = agent_token(c)
    r = c.post("/api/v1/datasets/ds/studio/commits", json={}, headers=h)
    assert r.status_code == 201, r.text and r.json()["branch"].startswith("work/agent-")
    assert c.post("/api/v1/datasets/ds/studio/commits", json={"branch": "work/user-alice/ds"}, headers=h).status_code == 403
