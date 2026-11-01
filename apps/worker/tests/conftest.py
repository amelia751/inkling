"""A live kernel (uvicorn in a thread, temp SQLite) and a registry with real plugin packages:
the reference segmentation plugin and small misbehaving ones."""

from __future__ import annotations

import json
import socket
import struct
import subprocess
import textwrap
import threading
import time
import zlib
from pathlib import Path

import httpx
import pytest
import uvicorn
import yaml

REPO = Path(__file__).resolve().parents[3]
SDK = REPO / "packages" / "plugin-sdk"


def png(w: int, h: int) -> bytes:
    raw = b"".join(b"\x00" + bytes(w) for _ in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)  # noqa: E731
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw)) + ch(b"IEND", b"")


BAD_TOOLS = textwrap.dedent('''
    import time, httpx
    from studio_plugin_sdk import Registry

    def register(tools: Registry):
        @tools.tool("hang")
        def hang(ctx, req):
            time.sleep(600)

        @tools.tool("crash")
        def crash(ctx, req):
            import os
            os._exit(3)

        @tools.tool("garbage")
        def garbage(ctx, req):
            return {"instances": [{"instance_id": "x", "mask": {"encoding": "rle", "size": [2, 2], "counts": [1]}}], "provider": "p", "model": "m"}

        @tools.tool("phone_home")
        def phone_home(ctx, req):
            r = httpx.get(req["url"], timeout=10)
            return {"instances": [], "provider": "p", "model": "m", "status": r.status_code}
''')


def make_bad_plugin(root: Path) -> Path:
    d = root / "plugins" / "bad"
    (d / "src" / "bad_plugin").mkdir(parents=True)
    (d / "src" / "bad_plugin" / "__init__.py").write_text("")
    (d / "src" / "bad_plugin" / "tools.py").write_text(BAD_TOOLS)
    (d / "pyproject.toml").write_text(textwrap.dedent(f'''
        [project]
        name = "bad-plugin"
        version = "1.0.0"
        requires-python = ">=3.12"
        dependencies = ["studio-plugin-sdk", "httpx>=0.28"]
        [tool.uv.sources]
        studio-plugin-sdk = {{ path = "{SDK}" }}
        [build-system]
        requires = ["hatchling"]
        build-backend = "hatchling.build"
        [tool.hatch.build.targets.wheel]
        packages = ["src/bad_plugin"]
    '''))
    subprocess.run(["uv", "lock", "--quiet", "--project", str(d)], check=True)
    return d


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="session")
def stack(tmp_path_factory):
    """Kernel on a free port with a registry of: the segmentation plugin (repo) and `test.bad`."""
    from studio_api import config, db
    from studio_api.naming import plugin_schema_version
    from studio_api.plugins.digest import tree_digest

    root = tmp_path_factory.mktemp("stack")
    seed = root / "seed"
    (seed / "img").mkdir(parents=True)
    (seed / "img" / "a.png").write_bytes(png(32, 24))
    from .canary import write_canary_samples

    canary_assets = write_canary_samples(seed / "bnd")
    projects = [{"id": w, "title": w, "assets": [{"path": "img/a.png"}]} for w in ("ws", "iso", "egress")]
    projects.append({"id": "bnd", "title": "bnd", "assets": [{"path": f"bnd/{n}"} for n in canary_assets]})
    (seed / "manifest.json").write_text(json.dumps({"projects": projects}))
    bad = make_bad_plugin(root)
    bad_manifest = {
        "schemaVersion": plugin_schema_version(), "id": "test.bad", "name": "bad", "version": "1.0.0", "publisher": "acme", "license": "MIT",
        "compatibility": {"studio": "*", "pluginApi": "^1"},
        "capabilities": [{"id": "image.segment", "tool": "garbage"}],
        "runtime": {"kind": "python-worker", "entrypoint": "bad_plugin.tools:register", "maxExecutionSeconds": 3},
        "permissions": {"required": ["assets.read"], "optional": []},
    }
    (bad / "plugin.yaml").write_text(yaml.safe_dump(bad_manifest))
    seg_dir = REPO / "plugins" / "segmentation"
    seg_manifest = yaml.safe_load((seg_dir / "plugin.yaml").read_text())
    reg = root / "registry"
    reg.mkdir()
    (reg / "index.json").write_text(json.dumps({"plugins": [
        {"id": seg_manifest["id"], "version": seg_manifest["version"], "publisher": "first-party", "trustTier": "first-party", "artifactDigest": tree_digest(seg_dir), "path": str(seg_dir), "manifest": seg_manifest},
        {"id": "test.bad", "version": "1.0.0", "publisher": "acme", "trustTier": "vetted", "artifactDigest": tree_digest(bad), "path": str(bad), "manifest": bad_manifest},
    ]}))
    build_key = root / "build-signing.key"
    s = config.load_settings(database_url=f"sqlite:///{root / 'api.db'}", seed_root=seed, data_dir=root / "data", secret_key="worker-test-key", registry_dir=reg, signer_key_file=build_key)
    config.set_settings(s)
    db.reset_engine()
    from studio_api.app import create_app

    port = free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{url}/api/v1/health").status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.05)
    from studio_api.routes.worker import worker_token

    yield {"url": url, "token": worker_token(), "root": root, "seg_id": seg_manifest["id"], "build_key": build_key}
    server.should_exit = True
    t.join(timeout=5)


def install(url: str, ws: str, plugin: str, grant: list[str] | None = None) -> None:
    h = {"X-Workspace-Id": ws}
    plan = httpx.post(f"{url}/api/v1/workspaces/{ws}/plugins/plan", json={"pluginId": plugin}, headers=h).json()
    staged = httpx.post(f"{url}/api/v1/workspaces/{ws}/plugins/stage", json={"requestId": plan["requestId"]}, headers=h).json()
    assert staged["state"] == "AWAITING_APPROVAL", staged
    r = httpx.post(f"{url}/api/v1/workspaces/{ws}/plugins/approve", json={"requestId": plan["requestId"], "grantOptional": grant or []}, headers=h).json()
    assert r["state"] == "ACTIVATED", r
