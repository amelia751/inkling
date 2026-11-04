"""image.segment results → annotations: a recipe request (label, no prompts) keeps each mask's own name (todo25 D2)."""

from types import SimpleNamespace

from studio_api.kernel.contracts import normalize_result


def result(*labels):
    inst = [{"instance_id": f"i{n}", "mask": {"encoding": "rle", "size": [2, 2], "counts": [0, 4]}, **({"label": lb} if lb else {})} for n, lb in enumerate(labels)]
    return {"instances": inst, "provider": "mock", "model": "m"}


def job(**inp):
    return SimpleNamespace(input={"asset_id": "a.png", **inp}, job_id="j1", workspace_id="w")


def test_recipe_masks_keep_their_names_and_record_the_recipe():
    anns = normalize_result("image.segment", result("right lung", "left lung"), job(label="lungs"), author="plugin:x")
    assert [a["label"] for a in anns] == ["right lung", "left lung"]
    assert all(a["attributes"]["recipe"] == "lungs" and "prompt" not in a["attributes"] for a in anns)


def test_with_prompts_the_requested_label_still_wins():
    (a,) = normalize_result("image.segment", result("object"), job(label="cell", prompts=[{"type": "text", "text": "object"}]), author="plugin:x")
    assert a["label"] == "cell" and "recipe" not in a["attributes"]


def test_unnamed_masks_fall_back_to_the_label():
    (a,) = normalize_result("image.segment", result(None), job(label="lungs"), author="plugin:x")
    assert a["label"] == "lungs" and "recipe" not in a["attributes"]
