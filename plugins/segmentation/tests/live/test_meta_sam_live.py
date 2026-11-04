"""Live: one image, one box, against Meta's real SAM 3.1 API. By hand only, about $0.0025 a run:

    STUDIO_API_PROVIDER_KEY_META=… uv run pytest tests/live -q      # or STUDIO_AGENT_MUSE_API_KEY (same Meta key)

Never collected by the default run (`norecursedirs` in pyproject.toml), and skipped without a key.
The broker is stood in for by a client that adds the key itself, so this checks Meta's
request/response format and the real parser, not the kernel's proxy.
"""

import os
from pathlib import Path

import httpx
import jsonschema
import pytest
from studio_plugin_sdk import JobsClient, SecretsClient, ToolContext

from studio_plugin_segmentation.tools import segment_objects

from ..conftest import REPO, FakeAssets

KEY = os.environ.get("STUDIO_API_PROVIDER_KEY_META") or os.environ.get("STUDIO_AGENT_MUSE_API_KEY")
IMAGE = Path(os.environ.get("STUDIO_SEGMENTATION_LIVE_IMAGE") or Path(__file__).parents[2] / "fixtures/sample_image.png")

pytestmark = pytest.mark.skipif(not KEY, reason="live: set STUDIO_API_PROVIDER_KEY_META (or STUDIO_AGENT_MUSE_API_KEY)")


class DirectBroker:
    """Plays the kernel's `/api/v1/secrets/proxy`: forwards the request with the key added."""

    def __init__(self):
        self.calls = 0

    def post(self, path, headers=None, json=None):
        assert path == "/api/v1/secrets/proxy"
        self.calls += 1
        return httpx.request(json["method"], json["url"], content=json["body"], headers={**json["headers"], json["inject"]: f"{json['scheme']} {KEY}"}, timeout=60)


def test_one_box_on_one_image():
    broker = DirectBroker()
    ctx = ToolContext(workspace_id="live", job_id="live", assets=FakeAssets({"img": IMAGE.read_bytes()}), jobs=JobsClient(lambda _: None), secrets=SecretsClient(broker, {"META_MODEL_API_KEY": "live"}), provider={"id": "meta.sam"})
    from studio_plugin_sdk.masks import image_size

    w, h = image_size(IMAGE.read_bytes())
    out = segment_objects(ctx, {"asset_id": "img", "prompts": [{"type": "box", "box": [round(w * 0.1), round(h * 0.1), round(w * 0.9), round(h * 0.9)]}]})
    assert broker.calls == 1
    jsonschema.validate(out, __import__("json").loads((REPO / "schemas/capabilities/image.segment.result.json").read_text()))
    assert out["provider"] == "meta.sam" and out["model"] == "sam-3.1" and len(out["instances"]) <= 1
