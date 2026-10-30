"""Results match the image.segment contract (schemas/capabilities/*.json); bad provider output never passes."""

import json

import jsonschema
import pytest
from studio_plugin_sdk import ToolError
from studio_plugin_sdk.masks import decode_rle

from studio_plugin_segmentation.normalize import to_result
from studio_plugin_segmentation.providers.base import RawInstance
from studio_plugin_segmentation.tools import segment_objects

from .conftest import REPO

RESULT = json.loads((REPO / "schemas/capabilities/image.segment.result.json").read_text())
REQUEST = json.loads((REPO / "schemas/capabilities/image.segment.request.json").read_text())


def test_result_matches_the_contract(ctx):
    req = {"asset_id": "img/sample.png", "prompts": [{"type": "point", "x": 20, "y": 20, "positive": True}, {"type": "box", "box": [30, 10, 60, 40]}]}
    jsonschema.validate(req, REQUEST)
    out = segment_objects(ctx(), req)
    jsonschema.validate(out, RESULT)
    assert out["provider"] == "mock" and len(out["instances"]) == 2
    for inst in out["instances"]:
        assert sum(inst["mask"]["counts"]) == 64 * 48
        assert "confidence" not in inst  # the mock has no calibrated score, so none is invented
        assert sum(decode_rle(inst["mask"])) > 0


def test_mask_size_mismatch_is_an_error():
    with pytest.raises(ValueError):
        to_result([RawInstance(b"\x01" * 10)], 64, 48, provider="x", model="y")


def test_empty_masks_are_dropped():
    assert to_result([RawInstance(b"\x00" * (4 * 3))], 4, 3, provider="x", model="y")["instances"] == []


def test_unsupported_prompt_types_are_refused_not_ignored(ctx):
    with pytest.raises(ToolError) as e:
        segment_objects(ctx("local.sam"), {"asset_id": "img/sample.png", "prompts": [{"type": "text", "text": "lung"}]})
    assert "text" in str(e.value) and e.value.recoverable is False
