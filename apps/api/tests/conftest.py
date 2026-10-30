"""Shared fixtures: an isolated kernel (in-memory SQLite, temp seed data) per test."""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio_api import config, db
from studio_api.naming import ns


def png(w: int, h: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


@pytest.fixture
def seed(tmp_path: Path) -> Path:
    root = tmp_path / "seed"
    (root / "img").mkdir(parents=True)
    (root / "img" / "a.png").write_bytes(png(40, 30))
    (root / "img" / "b.png").write_bytes(png(20, 20))
    manifest = {
        "projects": [
            {"id": "ws-a", "title": "A", "assets": [{"path": "img/a.png"}]},
            {"id": "ws-b", "title": "B", "assets": [{"path": "img/b.png"}]},
        ]
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


@pytest.fixture
def make_client(seed: Path, tmp_path: Path):
    def make(**overrides) -> TestClient:
        s = config.load_settings(database_url="sqlite:///:memory:", seed_root=seed, data_dir=tmp_path / "data", secret_key="test-secret-key", **overrides)
        config.set_settings(s)
        db.reset_engine()
        from studio_api.app import create_app

        return TestClient(create_app())

    yield make
    db.reset_engine()


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


def ws(name: str, **extra) -> dict:
    return {"X-Workspace-Id": name, **extra}


SEGMENTATION = ns("segmentation")


# ---- A fixture registry of synthetic plugin packages ------------------------------------------

from studio_api.naming import plugin_schema_version  # noqa: E402
from studio_api.plugins.digest import tree_digest  # noqa: E402


def manifest(id_: str, version: str = "1.0.0", **extra) -> dict:
    m = {
        "schemaVersion": plugin_schema_version(),
        "id": id_,
        "name": id_,
        "version": version,
        "publisher": extra.pop("publisher", "first-party"),
        "license": "MIT",
        "compatibility": {"studio": ">=0.1.0 <1.0.0", "pluginApi": "^1"},
        "capabilities": [],
        "runtime": {"kind": "browser-bundled"},
        "permissions": {"required": [], "optional": []},
    }
    m.update(extra)
    return m


SEG_MANIFEST = dict(
    capabilities=[{"id": "image.segment", "tool": "segment_objects", "mediaTypes": ["image/png"]}],
    runtime={"kind": "python-worker", "entrypoint": "fake_plugin.tools:register", "maxExecutionSeconds": 30, "concurrency": 1},
    providers=[
        {"id": "mock", "implements": ["image.segment"], "hosting": "mock"},
        {
            "id": "hosted.sam",
            "implements": ["image.segment"],
            "hosting": "hosted",
            "egress": ["api.segment.test"],
            "secrets": ["SEG_API_KEY"],
            "pricing": {"unit": "image", "usdPerUnit": 0.5, "effectiveAt": "2026-10-01", "sourceUrl": "https://example.test/pricing"},
        },
    ],
    permissions={"required": ["assets.read", "annotations.write"], "optional": ["network.egress:api.segment.test", "secrets.use:SEG_API_KEY"]},
    resources={"defaultBudgetUsdPerJob": 1.0},
    ui={"contributions": "ui/contributions.json"},
)


def write_registry(root: Path, packages: list[tuple[str, dict, dict[str, str]]]) -> Path:
    """packages: (dir name, manifest, extra files). Returns the registry dir."""
    import yaml

    entries = []
    for name, m, extra in packages:
        d = root / "plugins" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "plugin.yaml").write_text(yaml.safe_dump(m, sort_keys=False))
        for rel, text in extra.items():
            (d / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / rel).write_text(text)
        entries.append({"id": m["id"], "version": m["version"], "publisher": m["publisher"], "trustTier": "first-party" if m["publisher"] == "first-party" else "vetted", "artifactDigest": tree_digest(d), "path": f"plugins/{name}", "manifest": m, "licenses": {"code": m["license"]}})
    reg = root / "registry"
    reg.mkdir(parents=True, exist_ok=True)
    (reg / "index.json").write_text(json.dumps({"version": 1, "plugins": entries}))
    return reg


@pytest.fixture
def registry_client(make_client, tmp_path: Path):
    """A kernel whose registry has: a UI plugin, a python-worker segmentation plugin (two
    versions) that requires it, and a vetted plugin with a dependency conflict."""

    def make(**overrides):
        seg_files = {"uv.lock": "# locked\n", "ui/contributions.json": json.dumps({"toolbarActions": [{"id": "segment", "surface": "image.viewer.toolbar", "title": "Segment", "command": "test.seg.segment_objects"}], "panels": []})}
        reg = write_registry(
            tmp_path / "repo",
            [
                ("viewer", manifest("test.viewer", publisher="acme", capabilities=[{"id": "image.view", "mediaTypes": ["image/png"]}]), {}),
                ("viewer2", manifest("test.viewer", "2.0.0", publisher="acme"), {}),
                ("seg", manifest("test.seg", requires={"test.viewer": "^1"}, **SEG_MANIFEST), seg_files),
                ("seg11", manifest("test.seg", "1.1.0", requires={"test.viewer": "^1"}, **SEG_MANIFEST), seg_files),
                ("needs2", manifest("test.needs2", publisher="acme", requires={"test.viewer": "^2"}), {}),
            ],
        )
        return make_client(registry_dir=reg, **overrides)

    return make
