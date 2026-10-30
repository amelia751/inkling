"""The reference plugin end to end: install → command → worker (own locked env) → canonical masks."""

from __future__ import annotations

import httpx

from studio_worker.main import Worker

from .conftest import install


def test_segmentation_through_a_real_worker(stack, tmp_path):
    url, h = stack["url"], {"X-Workspace-Id": "ws"}
    install(url, "ws", stack["seg_id"])
    r = httpx.post(f"{url}/api/v1/commands", json={"capability": "image.segment", "input": {"asset_id": "img/a.png", "label": "cell", "prompts": [{"type": "point", "x": 10, "y": 10}]}}, headers=h)
    assert r.status_code == 202, r.text
    job_id = r.json()["job"]["jobId"]
    w = Worker(url, stack["token"], tmp_path, "w-e2e")
    assert w.tick()
    job = httpx.get(f"{url}/api/v1/jobs/{job_id}", headers=h).json()
    assert job["state"] == "succeeded", job
    anns = httpx.get(f"{url}/api/annotations/ws", headers=h).json()["annotations"]
    m = next(a for a in anns if a["id"] in job["result"]["annotationIds"])
    assert m["geometry"]["type"] == "mask" and m["geometry"]["dims"] == [32, 24]
    assert m["provenance"] == "ai-suggested" and m["attributes"]["provider"] == "mock" and m["label"] == "cell"
