from segmentation_plugin.tools import segment_objects


def test_mock_is_deterministic_and_reports_progress(ctx):
    progress = []
    req = {"asset_id": "img/sample.png", "prompts": [{"type": "text", "text": "object"}]}
    a = segment_objects(ctx(progress=progress), req)
    b = segment_objects(ctx(), req)
    assert a == b and a["instances"][0]["label"] == "object"
    assert [p["progress"] for p in progress] == [0.1, 0.3, 0.9]


def test_no_prompt_gives_one_mask(ctx):
    out = segment_objects(ctx(), {"asset_id": "img/sample.png"})
    assert len(out["instances"]) == 1
