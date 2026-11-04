"""Generic provider adapters (todo25 W7): OIP v2, Replicate/Cog, HF Inference Endpoints.
No network: the broker and httpx are faked."""

import base64
import json
from pathlib import Path

import httpx
import jsonschema
import pytest
import yaml
from studio_plugin_sdk import SecretsClient
from studio_plugin_sdk.masks import decode_rle, encode_rle, png_gray

from studio_plugin_segmentation.providers import ProviderError, get_provider
from studio_plugin_segmentation.providers.adapter import decode_png, rasterize
from studio_plugin_segmentation.providers.hf import HuggingFace
from studio_plugin_segmentation.providers.oip import Oip
from studio_plugin_segmentation.providers.replicate import Replicate
from studio_plugin_segmentation.tools import segment_objects

from .conftest import REPO

MANIFEST = yaml.safe_load((Path(__file__).parent.parent / "plugin.yaml").read_text())
DECLS = {p["id"]: p for p in MANIFEST["providers"]}
W, H = 64, 48  # fixtures/sample_image.png


def square(x0, y0, x1, y1, w=W, h=H) -> bytes:
    return bytes(1 if x0 <= x < x1 and y0 <= y < y1 else 0 for y in range(h) for x in range(w))


def png_b64(bits, w=W, h=H) -> str:
    return base64.b64encode(png_gray(bits, h, w)).decode()


class Resp:
    def __init__(self, status=200, body=None, content=b""):
        self.status_code, self._body, self.content, self.text = status, body, content, json.dumps(body)[:300] if body is not None else ""

    def json(self):
        return self._body


class FakeBroker:
    """The kernel's /api/v1/secrets/proxy: routes {method, url} to canned responses."""

    def __init__(self, routes):
        self.routes, self.sent = routes, []

    def post(self, path, headers=None, json=None):
        assert path == "/api/v1/secrets/proxy"
        self.sent.append((headers, json))
        r = self.routes[(json["method"], json["url"])]
        return r.pop(0) if isinstance(r, list) else r


def with_provider(ctx, pid, secrets=None, broker=None, config=None):
    c = ctx(pid, config=config)
    c.provider = DECLS[pid]
    if broker is not None:
        c.secrets = SecretsClient(broker, secrets or {})
    return c


def test_manifest_validates_and_adapter_hosts_are_declared_egress():
    schema = json.loads((REPO / "schemas/plugin.v1.json").read_text())
    jsonschema.validate(MANIFEST, schema)
    adapters = [p for p in MANIFEST["providers"] if p.get("adapter")]
    assert {p["adapter"]["kind"] for p in adapters} == {"oip", "replicate", "hf"}
    for p in adapters:
        assert httpx.URL(p["adapter"]["endpoint"]).host in p["egress"]
        assert p.get("modelLicense")
        if p["adapter"].get("secret"):
            assert p["adapter"]["secret"] in p["secrets"]
        if p["hosting"] == "hosted":
            assert p.get("pricing")


def test_get_provider_builds_adapters_from_the_manifest(ctx):
    assert isinstance(get_provider("oip.sam", with_provider(ctx, "oip.sam")), Oip)
    assert isinstance(get_provider("replicate.yolo26-seg", with_provider(ctx, "replicate.yolo26-seg")), Replicate)
    assert isinstance(get_provider("hf.medsam2", with_provider(ctx, "hf.medsam2")), HuggingFace)


def test_endpoint_override_must_stay_on_a_declared_host(ctx):
    ok = get_provider("oip.sam", with_provider(ctx, "oip.sam", config={"endpoints": {"oip.sam": "https://sam-oip.internal/v2-proxy"}}))
    assert ok.infer_url() == "https://sam-oip.internal/v2-proxy/v2/models/sam-3.1/infer"
    for bad in ("https://evil.example/", "http://sam-oip.internal/"):
        with pytest.raises(ProviderError) as e:
            get_provider("oip.sam", with_provider(ctx, "oip.sam", config={"endpoints": {"oip.sam": bad}}))
        assert not e.value.recoverable


# ---- OIP v2 ----------------------------------------------------------------------------------


def test_oip_dense_tensor_through_the_egress_proxy(ctx, monkeypatch):
    sent = []

    def fake_request(method, url, json=None, headers=None, timeout=None):
        sent.append((method, url, json))
        mask = square(10, 5, 20, 15)
        return Resp(body={"outputs": [{"name": "masks", "datatype": "UINT8", "shape": [1, H, W], "data": list(mask)}, {"name": "scores", "datatype": "FP32", "shape": [1], "data": [0.87]}]})

    monkeypatch.setattr(httpx, "request", fake_request)
    out = segment_objects(with_provider(ctx, "oip.sam"), {"asset_id": "img/sample.png", "prompts": [{"type": "box", "box": [10, 5, 20, 15]}, {"type": "point", "x": 12, "y": 7, "positive": False}]})
    ((method, url, body),) = sent
    assert (method, url) == ("POST", "https://sam-oip.internal/v2/models/sam-3.1/infer")
    names = {i["name"]: i for i in body["inputs"]}
    assert names["image"]["datatype"] == "BYTES" and base64.b64decode(names["image"]["data"][0])[:4] == b"\x89PNG"
    assert names["boxes"] == {"name": "boxes", "datatype": "FP32", "shape": [1, 4], "data": [10.0, 5.0, 20.0, 15.0]}
    assert names["points"]["data"] == [12.0, 7.0, 0.0]
    (inst,) = out["instances"]
    assert out["provider"] == "oip.sam" and out["model"] == "sam-3.1"
    assert inst["box_xyxy"] == [10.0, 5.0, 20.0, 15.0] and inst["confidence"] == 0.87
    assert bytes(decode_rle(inst["mask"])) == square(10, 5, 20, 15)


def test_oip_bytes_output_of_rle_strings(ctx, monkeypatch):
    rle = json.dumps(encode_rle(square(0, 0, 4, 4), H, W))
    monkeypatch.setattr(httpx, "request", lambda *a, **k: Resp(body={"outputs": [{"name": "masks", "datatype": "BYTES", "shape": [1], "data": [rle]}, {"name": "labels", "datatype": "BYTES", "shape": [1], "data": ["lung"]}]}))
    out = segment_objects(with_provider(ctx, "oip.sam"), {"asset_id": "img/sample.png", "prompts": [{"type": "point", "x": 1, "y": 1}]})
    assert out["instances"][0]["label"] == "lung" and out["instances"][0]["box_xyxy"] == [0.0, 0.0, 4.0, 4.0]


def test_oip_wrong_tensor_shape_is_refused(ctx, monkeypatch):
    monkeypatch.setattr(httpx, "request", lambda *a, **k: Resp(body={"outputs": [{"name": "masks", "datatype": "BOOL", "shape": [1, 2, 2], "data": [1, 0, 0, 1]}]}))
    with pytest.raises(ProviderError):
        get_provider("oip.sam", with_provider(ctx, "oip.sam")).segment(None, b"", W, H, {"prompts": []})


def test_oip_text_prompt_is_refused_by_features(ctx):
    from studio_plugin_sdk import ToolError

    with pytest.raises(ToolError):
        segment_objects(with_provider(ctx, "oip.sam"), {"asset_id": "img/sample.png", "prompts": [{"type": "text", "text": "lung"}]})


# ---- Replicate -------------------------------------------------------------------------------

CREATE = "https://api.replicate.com/v1/models/ultralytics/yolo26-seg/predictions"
GET = "https://api.replicate.com/v1/predictions/p1"


def test_replicate_create_poll_and_masks_by_data_url_and_file_url(ctx):
    file_url = "https://replicate.delivery/out/m1.png"
    broker = FakeBroker({
        ("POST", CREATE): Resp(201, {"id": "p1", "status": "starting", "urls": {"get": GET}}),
        ("GET", GET): [Resp(body={"id": "p1", "status": "processing", "urls": {"get": GET}}), Resp(body={"id": "p1", "status": "succeeded", "output": [{"mask": "data:image/png;base64," + png_b64(square(0, 0, 8, 8)), "label": "dog", "score": 0.9}, {"mask": file_url, "label": "cat"}]})],
        ("GET", file_url): Resp(content=png_gray(square(30, 20, 40, 30), H, W)),
    })
    c = with_provider(ctx, "replicate.yolo26-seg", {"REPLICATE_API_TOKEN": "use"}, broker)
    p = get_provider("replicate.yolo26-seg", c)
    slept = []
    p.sleep = slept.append
    raw = p.segment(c, c.assets.read("img/sample.png"), W, H, {"prompts": []})
    assert [r.label for r in raw] == ["dog", "cat"] and raw[0].confidence == 0.9 and raw[1].confidence is None
    assert raw[0].bits == square(0, 0, 8, 8) and raw[1].bits == square(30, 20, 40, 30)
    assert len(slept) == 2
    headers, first = broker.sent[0]
    assert headers == {"X-Secret-Use-Token": "use"} and first["inject"] == "Authorization" and first["headers"]["Prefer"] == "wait"
    body = json.loads(first["body"])
    assert "version" not in body and body["input"]["image"].startswith("data:image/png;base64,")


def test_replicate_failed_prediction_and_off_egress_file(ctx):
    c = with_provider(ctx, "replicate.yolo26-seg", {"REPLICATE_API_TOKEN": "use"}, FakeBroker({("POST", CREATE): Resp(body={"id": "p1", "status": "failed", "error": "OOM"})}))
    with pytest.raises(ProviderError, match="failed: OOM"):
        get_provider("replicate.yolo26-seg", c).segment(c, b"", W, H, {})
    c = with_provider(ctx, "replicate.yolo26-seg", {"REPLICATE_API_TOKEN": "use"}, FakeBroker({("POST", CREATE): Resp(body={"status": "succeeded", "output": ["https://elsewhere.example/m.png"]})}))
    with pytest.raises(ProviderError, match="egress"):
        get_provider("replicate.yolo26-seg", c).segment(c, b"", W, H, {})


def test_replicate_without_a_granted_secret_fails_closed(ctx):
    with pytest.raises(PermissionError, match="REPLICATE_API_TOKEN"):
        segment_objects(with_provider(ctx, "replicate.yolo26-seg"), {"asset_id": "img/sample.png"})


# ---- Hugging Face ----------------------------------------------------------------------------

HF = "https://medsam2.us-east-1.aws.endpoints.huggingface.cloud"


def test_hf_pipeline_response_with_png_masks(ctx):
    broker = FakeBroker({("POST", HF): Resp(body=[{"mask": png_b64(square(5, 5, 25, 30)), "label": "left lung", "score": 0.95}])})
    c = with_provider(ctx, "hf.medsam2", {"HF_TOKEN": "use"}, broker)
    out = segment_objects(c, {"asset_id": "img/sample.png", "prompts": [{"type": "box", "box": [4, 4, 26, 31]}]})
    (inst,) = out["instances"]
    assert inst["label"] == "left lung" and inst["box_xyxy"] == [5.0, 5.0, 25.0, 30.0]
    (_, sent), = broker.sent
    body = json.loads(sent["body"])
    assert sent["url"] == HF and body["parameters"] == {"boxes": [[4.0, 4.0, 26.0, 31.0]]} and base64.b64decode(body["inputs"])[:4] == b"\x89PNG"


@pytest.mark.parametrize("status,recoverable", [(401, False), (403, False), (429, True), (503, True), (422, False)])
def test_hf_http_errors(ctx, status, recoverable):
    c = with_provider(ctx, "hf.medsam2", {"HF_TOKEN": "use"}, FakeBroker({("POST", HF): Resp(status, {"error": "x"})}))
    with pytest.raises(ProviderError) as e:
        get_provider("hf.medsam2", c).segment(c, b"\x89PNG\r\n\x1a\n", W, H, {})
    assert e.value.recoverable is recoverable


# ---- mask formats ----------------------------------------------------------------------------


def test_png_roundtrip_and_polygons():
    bits = square(3, 2, 9, 7, 12, 10)
    w, h, back = decode_png(png_gray(bits, 10, 12))
    assert (w, h, back) == (12, 10, bits)
    assert rasterize([[3, 2], [9, 2], [9, 7], [3, 7]], 12, 10) == bits
    assert rasterize([3, 2, 9, 2, 9, 7, 3, 7], 12, 10) == bits
    assert rasterize([[[0, 0], [2, 0], [2, 2], [0, 2]], [[3, 2], [9, 2], [9, 7], [3, 7]]], 12, 10) == bytes(a | b for a, b in zip(square(0, 0, 2, 2, 12, 10), bits, strict=True))
