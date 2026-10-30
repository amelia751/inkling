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
