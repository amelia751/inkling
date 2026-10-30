"""§14 #10: the price estimate and budget denial happen before an external billable batch begins."""

from __future__ import annotations

from .conftest import worker_headers, ws
from .test_installer_flow import install


def setup(c):
    install(c, "ws-a", "test.seg", grant=["network.egress:api.segment.test", "secrets.use:SEG_API_KEY"])
    c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.seg", "config": {"provider": "hosted.sam"}}, headers=ws("ws-a"))


def test_batch_over_budget_is_denied_before_any_job(registry_client):
    c = registry_client()
    setup(c)  # $0.50 per image, default budget $1.00
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "inputs": [{"asset_id": "img/a.png"}] * 3}, headers=ws("ws-a"))
    assert r.status_code == 402 and r.json()["detail"]["estimateUsd"] == 1.5 and r.json()["detail"]["budgetUsd"] == 1.0
    assert c.get("/api/v1/jobs", headers=ws("ws-a")).json()["jobs"] == []
    assert c.post("/api/v1/worker/claim", json={"workerId": "w"}, headers=worker_headers()).json() == {"job": None}
    assert any(e["action"] == "gateway.budget_denied" for e in c.get("/api/v1/audit", headers=ws("ws-a")).json()["entries"])


def test_batch_within_budget_queues_one_job_per_item(registry_client):
    c = registry_client()
    setup(c)
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "inputs": [{"asset_id": "img/a.png"}] * 2}, headers=ws("ws-a"))
    assert r.status_code == 202 and len(r.json()["jobs"]) == 2 and r.json()["estimateUsd"] == 1.0


def test_raising_the_budget_is_a_config_change(registry_client):
    c = registry_client()
    setup(c)
    c.post("/api/v1/workspaces/ws-a/plugins/configure", json={"pluginId": "test.seg", "config": {"budgetUsdPerBatch": 5}}, headers=ws("ws-a"))
    assert c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "inputs": [{"asset_id": "img/a.png"}] * 3}, headers=ws("ws-a")).status_code == 202


def test_hosted_provider_without_pricing_is_never_called(registry_client, tmp_path):
    import copy

    from studio_api.db import session_scope
    from studio_api.models import PluginVersion

    c = registry_client()
    install(c, "ws-a", "test.seg", grant=["network.egress:api.segment.test", "secrets.use:SEG_API_KEY"])
    with session_scope() as s:  # as if this version published no price
        row = s.get(PluginVersion, ("test.seg", "1.1.0"))
        m = copy.deepcopy(row.manifest)
        del m["providers"][1]["pricing"]
        row.manifest = m
    r = c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png", "provider": "hosted.sam"}}, headers=ws("ws-a"))
    assert r.status_code == 402 and "pricing" in str(r.json())
    assert c.get("/api/v1/jobs", headers=ws("ws-a")).json()["jobs"] == []
