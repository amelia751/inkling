"""§14 #8: a provider switch preserves existing masks and their provenance."""

from __future__ import annotations

from .conftest import mask_result, run_worker_once, ws
from .test_installer_flow import install


def test_switch_keeps_old_masks_and_records_the_new_provider(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg", grant=["network.egress:api.segment.test", "secrets.use:SEG_API_KEY"])
    c.put("/api/v1/secrets/SEG_API_KEY", json={"value": "sk-test"}, headers=ws("ws-a"))
    c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    claim, _ = run_worker_once(c, mask_result("mock", "mock-1"))
    assert claim["provider"]["id"] == "mock" and claim["secretUseTokens"] == {}
    before = c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]

    c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.seg", "config": {"provider": "hosted.sam", "budgetUsdPerJob": 2}}, headers=ws("ws-a"))
    c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws("ws-a"))
    claim, _ = run_worker_once(c, mask_result("hosted.sam", "sam-x"), cost=0.5)
    assert claim["provider"]["id"] == "hosted.sam" and set(claim["secretUseTokens"]) == {"SEG_API_KEY"}
    after = c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]
    assert after[0] == before[0]  # unchanged, provenance included
    assert {a["attributes"]["provider"] for a in after} == {"mock", "hosted.sam"}
    assert all(a["geometry"]["type"] == "mask" for a in after)  # same canonical schema either way


def test_switch_to_an_ungranted_provider_is_refused(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png", "provider": "hosted.sam"}}, headers=ws("ws-a"))
    assert r.status_code == 403 and "network.egress:api.segment.test" in str(r.json())
