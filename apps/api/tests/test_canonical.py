"""RFC 8785 canonical JSON in the kernel matches the browser's (packages/contracts/src/canonical.ts)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio_api.kernel.canonical import NULL_CONTENT_HASH, canonicalize, content_hash

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "packages/contracts/test-vectors/canonical.json").read_text())["vectors"]


@pytest.mark.parametrize("v", VECTORS, ids=[v["input"][:40] for v in VECTORS])
def test_shared_vectors(v):
    value = json.loads(v["input"])
    assert canonicalize(value) == v["canonical"]
    assert content_hash(value) == v["hash"]


def test_key_order_never_changes_the_hash():
    a = {"extends": "preset:x", "labels": [{"name": "l", "classes": [{"id": "a"}]}], "task": "t"}
    b = {"task": "t", "labels": [{"classes": [{"id": "a"}], "name": "l"}], "extends": "preset:x"}
    assert content_hash(a) == content_hash(b) != content_hash({**a, "task": "u"})
    assert content_hash(None) == NULL_CONTENT_HASH


def test_not_json_raises():
    for bad in (float("nan"), float("inf"), {1: "x"}, {"a": object()}):
        with pytest.raises((TypeError, ValueError)):
            canonicalize(bad)
