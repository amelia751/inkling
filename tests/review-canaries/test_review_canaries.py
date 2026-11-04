"""todo23 W9 calibration: the deterministic pre-review catches every planted class in
tests/review-canaries/ and nothing in the control. `uv run pytest tests/review-canaries`."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from pre_review import review  # noqa: E402

MANIFEST = json.loads((HERE / "manifest.json").read_text())
SCHEMA = json.loads((HERE.parent.parent / "schemas" / "review.v1.json").read_text())


@pytest.mark.parametrize("canary", MANIFEST["canaries"], ids=lambda c: c["dir"].split("/")[-1])
def test_pre_review_catches_the_planted_class(canary):
    doc = review(HERE / canary["dir"])
    classes = {f["class"] for f in doc["findings"]}
    assert classes == set(canary["expect"]), doc["findings"]
    assert doc["verdict"] == canary["verdict"]


def test_output_is_review_v1():
    doc = review(HERE / MANIFEST["canaries"][0]["dir"])
    assert set(SCHEMA["required"]) <= set(doc)
    assert doc["verdict"] in SCHEMA["properties"]["verdict"]["enum"]
    finding = SCHEMA["properties"]["findings"]["items"]
    for f in doc["findings"]:
        assert set(finding["required"]) <= set(f) and f["severity"] in finding["properties"]["severity"]["enum"]
