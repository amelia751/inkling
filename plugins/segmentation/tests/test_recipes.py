"""Prompt recipes (todo25 D2): a label with no prompts → boxes sized to the image, masks named per box."""

import json

import jsonschema
import pytest
from studio_plugin_sdk import ToolError

from studio_plugin_segmentation.recipes import CONFIG_SCHEMA, default_recipes, find_recipe, recipe_prompts
from studio_plugin_segmentation.tools import segment_objects

from .conftest import REPO

RESULT = json.loads((REPO / "schemas/capabilities/image.segment.result.json").read_text())


def lungs():
    return find_recipe(None, "lungs")


@pytest.mark.parametrize(
    "size,boxes",
    [
        # The todo25 §0.3 probe images: normal/NORMAL2-IM-1427-0001.jpeg and pneumonia/person1946_bacteria_4874.jpeg.
        ((1776, 1416), [[266, 184, 852, 1204], [924, 184, 1510, 1204]]),
        ((968, 592), [[145, 77, 465, 503], [503, 77, 823, 503]]),
    ],
)
def test_lungs_boxes_for_both_probe_sizes(size, boxes):
    name, spec = lungs()
    assert name == "lungs" and spec["names"] == ["right lung", "left lung"]
    assert recipe_prompts(name, spec, *size) == [{"type": "box", "box": b} for b in boxes]


def test_defaults_are_valid_against_the_config_schema():
    schema = json.loads(CONFIG_SCHEMA.read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate({"recipes": default_recipes()}, schema)
    assert default_recipes()["lungs"]["boxesRel"] == [[0.15, 0.13, 0.48, 0.85], [0.52, 0.13, 0.85, 0.85]]


def test_mock_honours_the_recipe_and_names_each_mask(ctx):
    progress = []
    out = segment_objects(ctx(progress=progress), {"asset_id": "img/sample.png", "label": "lungs"})
    jsonschema.validate(out, RESULT)
    assert [i["label"] for i in out["instances"]] == ["right lung", "left lung"]
    # The sample is 64×48: the two masks sit in the left and right halves of the recipe's boxes.
    (r, left) = (i["box_xyxy"] for i in out["instances"])
    assert r[2] <= 32 <= left[0] and r[0] >= 0.15 * 64 - 1 and left[2] <= 0.85 * 64 + 1
    assert "recipe lungs" in progress[1]["message"]


def test_label_lookup_ignores_case_and_config_adds_recipes(ctx):
    cfg = {"recipes": {"halves": {"appliesTo": "any", "boxesRel": [[0, 0, 0.5, 1], [0.5, 0, 1, 1]], "names": ["a", "b"]}}}
    assert [i["label"] for i in segment_objects(ctx(config=cfg), {"asset_id": "img/sample.png", "label": "Halves"})["instances"]] == ["a", "b"]
    assert [i["label"] for i in segment_objects(ctx(config=cfg), {"asset_id": "img/sample.png", "label": "LUNGS"})["instances"]] == ["right lung", "left lung"]


def test_unknown_label_without_prompts_is_a_clear_non_recoverable_error(ctx):
    with pytest.raises(ToolError) as e:
        segment_objects(ctx(), {"asset_id": "img/sample.png", "label": "spleen"})
    assert e.value.recoverable is False and "'spleen'" in str(e.value) and "lungs" in str(e.value)


def test_label_with_prompts_is_not_a_recipe(ctx):
    out = segment_objects(ctx(), {"asset_id": "img/sample.png", "label": "lungs", "prompts": [{"type": "box", "box": [1, 1, 20, 20]}]})
    assert len(out["instances"]) == 1 and "label" not in out["instances"][0]


def test_invalid_recipe_in_config_is_refused(ctx):
    cfg = {"recipes": {"bad": {"appliesTo": "x", "boxesRel": [[0.5, 0, 0.2, 1]], "names": ["a"]}}}
    with pytest.raises(ToolError) as e:
        segment_objects(ctx(config=cfg), {"asset_id": "img/sample.png", "label": "bad"})
    assert e.value.recoverable is False
