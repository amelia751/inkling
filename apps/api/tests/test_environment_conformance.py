"""todo11 D2.5: the API's environment checks agree with packages/environment-core on every
shared fixture (status, and the path and code of every error). The TypeScript side runs the
same file in packages/environment-core/src/validate.test.ts; a disagreement fails the build."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio_api.kernel import environment_policy as policy

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT / "packages" / "environment-core" / "fixtures" / "cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_conformance(case, monkeypatch):
    monkeypatch.setattr(policy, "_root", lambda: ROOT)
    r = policy.check_write(principal=case["principal"], installed=case.get("installed") or [], base=case.get("base"), patch=case.get("patch"), environment=case.get("environment"), is_patch="patch" in case)
    assert r.status == case["expect"]["status"], r.errors
    got = sorted((e["code"], e["path"]) for e in r.errors)
    want = sorted((e["code"], e["path"]) for e in case["expect"]["errors"])
    assert got == want


def test_bundled_presets_are_valid(monkeypatch):
    monkeypatch.setattr(policy, "_root", lambda: ROOT)
    for f in sorted((ROOT / "registry" / "presets").glob("*.json")):
        if f.name == "intents.json":
            continue
        spec = json.loads(f.read_text())["spec"]
        assert policy.check_write(principal="person", installed=[], environment=spec).errors == [], f.name
