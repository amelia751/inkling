"""todo17 D2: the API's resolve-level checks (kernel/environment_resolve.py) report the same
(code, path) pairs as the Studio's resolve.ts on every shared fixture; the TypeScript side runs
the same file in apps/web/src/extension-host/resolve-conformance.test.ts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio_api.kernel import environment_policy as policy
from studio_api.kernel.environment_resolve import resolve_issues

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT / "packages" / "environment-core" / "fixtures" / "resolve-cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_resolve_conformance(case):
    got = sorted((e["code"], e["path"]) for e in resolve_issues(case["environment"], ROOT))
    assert got == sorted((e["code"], e["path"]) for e in case["expect"])


def test_bundled_presets_resolve_clean():
    for f in sorted((ROOT / "registry" / "presets").glob("*.json")):
        if f.name != "intents.json":
            assert [i for i in resolve_issues({"extends": f"preset:{f.stem}"}, ROOT) if i["severity"] == "error"] == [], f.name


def test_check_write_rejects_resolve_errors(monkeypatch):
    monkeypatch.setattr(policy, "_root", lambda: ROOT)
    bad = next(c for c in CASES if c["expect"] and c["expect"][0]["code"] == "label-target")
    r = policy.check_write(principal="person", installed=[], environment=bad["environment"])
    assert r.status == 422 and r.errors[0]["code"] == bad["expect"][0]["code"]
    ok = policy.check_write(principal="person", installed=[], environment={"title": "overlay"})
    assert ok.ok and {w["code"] for w in ok.warnings} == {"missing-data-kind", "missing-viewport"}
