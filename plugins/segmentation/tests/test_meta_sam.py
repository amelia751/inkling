"""The Meta SAM adapter against the request/response format in Meta's docs (checked 2026-10-30;
sources in providers/meta_sam.py). No network: the broker client is faked."""

import json

import pytest
from studio_plugin_sdk import SecretsClient

from studio_plugin_segmentation.normalize import to_result
from studio_plugin_segmentation.providers import ProviderError
from studio_plugin_segmentation.providers.meta_sam import ENDPOINT, MODEL, MetaSam, from_provider_response, parse_output, prompt_text, to_provider_request
from studio_plugin_segmentation.tools import segment_objects


def test_text_prompt_is_the_noun_phrase_and_image_is_a_data_url():
    body = to_provider_request(b"\x89PNG\r\n\x1a\n...", {"prompts": [{"type": "text", "text": "glasses"}]}, MODEL, 10, 8)
    assert body["model"] == "sam-3.1" and body["metadata"] == {"include_confidence": "true"}
    (msg,) = body["input"]
    assert msg["role"] == "user" and msg["content"][0] == {"type": "input_text", "text": "glasses"}
    assert msg["content"][1]["type"] == "input_image" and msg["content"][1]["image_url"].startswith("data:image/png;base64,")


def test_boxes_and_points_use_metas_token_grammar():
    req = {"prompts": [{"type": "box", "box": [1, 2, 5, 6]}, {"type": "box", "box": [0, 0, 3.5, 3]}, {"type": "point", "x": 2, "y": 3, "positive": False}]}
    # Studio boxes are half-open; Meta's x2/y2 are inclusive. Points join the first object.
    assert prompt_text(req, 10, 8) == "<0f>0<|box;x1=1;y1=2;x2=4;y2=5;w=10;h=8|>-<|point;x=2;y=3;w=10;h=8|>,1<|box;x1=0;y1=0;x2=3;y2=2;w=10;h=8|>"
    assert prompt_text({"prompts": [{"type": "point", "x": 9, "y": 7}]}, 10, 8) == "<0f>0<|point;x=9;y=7;w=10;h=8|>"


@pytest.mark.parametrize(
    "prompts",
    [
        [{"type": "text", "text": "a"}, {"type": "box", "box": [0, 0, 1, 1]}],  # text and geometry can't mix
        [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}],  # one concept (one billable request) per call
        [],
        [{"type": "point", "x": 10, "y": 0}],  # outside a 10-wide image
    ],
)
def test_requests_meta_cant_take_are_refused(prompts):
    with pytest.raises(ProviderError) as e:
        prompt_text({"prompts": prompts}, 10, 8)
    assert not e.value.recoverable


def fake_decoder(calls):
    def decode(payload, w, h):
        calls.append((payload, w, h))
        return bytes([1]) * (w * h)

    return decode


SAMPLE = "<0f>0<|box;x1=2;y1=1;x2=4;y2=2;w=8;h=6;c=0.9|><|mask;x=0;y=0;data=2,3,!abc|>,1<|box;x1=0;y1=0;x2=0;y2=0;w=8;h=6|><|mask;x=0;y=0;data=1,1,~xyz|>"


def test_response_masks_are_pasted_into_their_box():
    calls = []
    body = {"output": [{"type": "message", "content": [{"type": "output_text", "text": SAMPLE}]}], "status": "completed"}
    a, b = from_provider_response(body, 8, 6, decode=fake_decoder(calls))
    assert calls == [("!abc", 3, 2), ("~xyz", 1, 1)]
    rows = [a.bits[y * 8 : (y + 1) * 8] for y in range(6)]
    assert rows[1] == bytes([0, 0, 1, 1, 1, 0, 0, 0]) and rows[2] == rows[1] and sum(a.bits) == 6
    assert a.confidence == 0.9 and b.confidence is None and b.bits[0] == 1 and sum(b.bits) == 1
    result = to_result([a, b], 8, 6, provider="meta.sam", model=MODEL)
    assert [i["box_xyxy"] for i in result["instances"]] == [[2.0, 1.0, 5.0, 3.0], [0.0, 0.0, 1.0, 1.0]]


def test_no_match_is_an_empty_result():
    assert from_provider_response({"output": [{"type": "message", "content": [{"type": "output_text", "text": ""}]}]}, 8, 6, decode=fake_decoder([])) == []


@pytest.mark.parametrize(
    "text",
    [
        "garbage",
        "<0f>0<|box;x1=2;y1=1;x2=9;y2=2;w=8;h=6|><|mask;x=0;y=0;data=2,8,!a|>",  # box outside the image
        "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=16;h=12|><|mask;x=0;y=0;data=2,2,!a|>",  # answered for another size
        "<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=8;h=6;c=1.5|><|mask;x=0;y=0;data=2,2,!a|>",  # confidence out of range
        "<0f>0<|box;x1=0;y1=0;x2=1;w=8;h=6|><|mask;x=0;y=0;data=2,2,!a|>",  # missing y2
    ],
)
def test_malformed_output_is_a_provider_error(text):
    with pytest.raises(ProviderError):
        parse_output(text, 8, 6)


def test_without_metas_parser_masks_fail_closed(ctx):
    try:
        import meta_sam_parser  # noqa: F401
    except ImportError:
        with pytest.raises(ProviderError, match="meta-sam-parser") as e:
            from_provider_response({"output_text": SAMPLE}, 8, 6)
        assert not e.value.recoverable
        # And the provider refuses before making the (billable) call.
        broker = FakeBroker()
        c = ctx("meta.sam")
        c.secrets = SecretsClient(broker, {"META_MODEL_API_KEY": "t"})
        with pytest.raises(ProviderError, match="meta-sam-parser"):
            MetaSam(c).segment(c, b"", 8, 6, {"prompts": [{"type": "text", "text": "x"}]})
        assert broker.sent == []
    else:
        pytest.skip("meta-sam-parser is installed")


class FakeBroker:
    def __init__(self, status=200, body=None):
        self.status, self.body, self.sent = status, body if body is not None else {"output_text": ""}, []

    def post(self, path, headers=None, json=None):
        self.sent.append((path, headers, json))

        class R:
            status_code = self.status
            text = "x"

            def json(_):
                return self.body

        return R()


def test_calls_go_through_the_broker_to_metas_endpoint(ctx):
    broker = FakeBroker()
    c = ctx("meta.sam", secrets={"META_MODEL_API_KEY": "use-token"})
    c.secrets = SecretsClient(broker, {"META_MODEL_API_KEY": "use-token"})
    from studio_plugin_segmentation.providers import meta_sam

    orig = meta_sam.MetaSam.__init__

    def init(self, ctx):
        orig(self, ctx)
        self.decode = fake_decoder([])

    meta_sam.MetaSam.__init__ = init
    try:
        out = segment_objects(c, {"asset_id": "img/sample.png", "prompts": [{"type": "text", "text": "cell"}]})
    finally:
        meta_sam.MetaSam.__init__ = orig
    assert out["instances"] == [] and out["provider"] == "meta.sam" and out["model"] == MODEL
    ((path, headers, sent),) = broker.sent
    assert path == "/api/v1/secrets/proxy" and headers == {"X-Secret-Use-Token": "use-token"}
    assert sent["url"] == ENDPOINT and sent["inject"] == "Authorization" and sent["scheme"] == "Bearer"
    assert json.loads(sent["body"])["model"] == MODEL


@pytest.mark.parametrize("status,recoverable", [(401, False), (404, False), (429, True), (503, True), (400, False)])
def test_http_errors(ctx, status, recoverable):
    c = ctx("meta.sam")
    c.secrets = SecretsClient(FakeBroker(status), {"META_MODEL_API_KEY": "t"})
    p = MetaSam(c)
    p.decode = fake_decoder([])
    with pytest.raises(ProviderError) as e:
        p.segment(c, b"\x89PNG\r\n\x1a\n", 8, 6, {"prompts": [{"type": "text", "text": "x"}]})
    assert e.value.recoverable is recoverable
