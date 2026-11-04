"""todo24 W6: the label set boot_studio's description shows a model (packages/studio-tools'
labels-patch-example.json) passes the agent's write checks on a fresh boot of every preset, so a
model that copies it gets a Studio on the first try."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio_api.kernel import environment_policy as policy

ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = json.loads((ROOT / "packages" / "studio-tools" / "src" / "labels-patch-example.json").read_text())
PRESETS = sorted(json.loads(f.read_text())["id"] for f in (ROOT / "registry" / "presets").glob("*.json"))
TITLE = {"op": "add", "path": "/title", "value": "Chest X-ray triage"}


@pytest.mark.parametrize("preset", PRESETS)
def test_example_label_set_validates_on_a_fresh_boot(preset, monkeypatch):
    monkeypatch.setattr(policy, "_root", lambda: ROOT)
    r = policy.check_write(principal="agent", installed=[], base={"extends": f"preset:{preset}"}, patch=[EXAMPLE, TITLE], is_patch=True)
    assert r.ok, r.errors


def test_replace_on_a_fresh_boot_is_what_the_description_warns_about(monkeypatch):
    monkeypatch.setattr(policy, "_root", lambda: ROOT)
    r = policy.check_write(principal="agent", installed=[], base={"extends": "preset:image-2d"}, patch=[{**EXAMPLE, "op": "replace"}], is_patch=True)
    assert r.status == 422
