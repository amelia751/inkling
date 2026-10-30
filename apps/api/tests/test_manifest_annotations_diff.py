"""plugin.yaml `annotations.diff` (todo4 V13) is validated by the kernel like the TS contract."""

from studio_api.kernel.contracts import validate_plugin_manifest

from .conftest import manifest


def test_optional_diff_rules_validate():
    assert validate_plugin_manifest(manifest("acme.seg")) == []
    ok = manifest("acme.seg", annotations={"diff": [{"kind": "mask2d", "geometry": {"metric": "iou", "threshold": 0.95}, "conflict_fields": ["class_id", "geometry"]}]})
    assert validate_plugin_manifest(ok) == []


def test_bad_diff_rules_are_rejected():
    rule = {"kind": "mask2d", "geometry": {"metric": "iou", "threshold": 0.9}}
    for diff in (
        [{"kind": "cube", "geometry": {"metric": "exact", "threshold": 0}}],
        [{**rule, "geometry": {"metric": "iou", "threshold": 1.5}}],
        [{**rule, "compare_fields": ["free_text"]}],
        [rule, rule],
    ):
        assert validate_plugin_manifest(manifest("acme.seg", annotations={"diff": diff})), diff
    assert validate_plugin_manifest(manifest("acme.seg", annotations={"diff": [rule], "run": "x"}))
