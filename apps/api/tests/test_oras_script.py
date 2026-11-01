"""tools/oras-plugins.sh against a live kernel, with a stand-in `oras` (todo10 Phase 8).

The stand-in implements the two `oras copy` forms the script uses by copying OCI image layout
directories into and out of a folder that plays the registry, so export → registry → import
runs end to end without a registry binary. The layouts themselves are the kernel's real
export and what it accepts on import.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

from studio_api import config, db
from studio_api.naming import naming

from .test_artifacts import GEN, package, tarball

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools" / "oras-plugins.sh"

FAKE_ORAS = r'''#!/usr/bin/env python3
"""oras copy [-r] (--from-oci-layout DIR:TAG REF | --to-oci-layout REF DIR:TAG) over a folder registry."""
import json, os, shutil, sys
reg = os.environ["FAKE_REGISTRY"]
a = [x for x in sys.argv[1:] if x != "-r"]
assert a[0] == "copy", a
def slot(ref): return os.path.join(reg, ref.replace("/", "_").replace(":", "@"))
if a[1] == "--from-oci-layout":
    src, tag = a[2].rsplit(":", 1)
    idx = json.load(open(os.path.join(src, "index.json")))
    assert any((m.get("annotations") or {}).get("org.opencontainers.image.ref.name") == tag for m in idx["manifests"]), "tag not in layout"
    shutil.copytree(src, slot(a[3]))
elif a[1] == "--to-oci-layout":
    dst, _tag = a[3].rsplit(":", 1)
    shutil.copytree(slot(a[2]), dst)
else:
    sys.exit("unsupported")
'''


def _port() -> int:
    for p in range(8220, 8230):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    pytest.skip("no free port in 8220-8229")


@pytest.fixture
def kernel(tmp_path, seed):
    import uvicorn

    s = config.load_settings(database_url=f"sqlite:///{tmp_path / 'api.db'}", seed_root=seed, data_dir=tmp_path / "data", secret_key="oras-test-key")
    config.set_settings(s)
    db.reset_engine()
    from studio_api.app import create_app

    port = _port()
    server = uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    url = f"http://127.0.0.1:{port}"
    for _ in range(200):
        try:
            if httpx.get(f"{url}/api/v1/health").status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.05)
    yield url
    server.should_exit = True
    t.join(timeout=5)


@pytest.mark.skipif(shutil.which("bash") is None or shutil.which("curl") is None, reason="needs bash and curl")
def test_export_to_a_registry_and_import_back(kernel, tmp_path):
    h = {"X-Workspace-Id": "ws-a"}
    assert httpx.post(f"{kernel}/api/v1/plugins/artifacts", content=tarball(package()), headers=h).json()["registered"]
    fake = tmp_path / "oras"
    fake.write_text(FAKE_ORAS.replace("#!/usr/bin/env python3", f"#!{sys.executable}"))
    fake.chmod(0o755)
    (tmp_path / "registry").mkdir()
    prefix = naming()["envPrefix"]
    env = {**os.environ, "ORAS": str(fake), "FAKE_REGISTRY": str(tmp_path / "registry"), f"{prefix}API_URL": kernel, f"{prefix}WORKSPACE": "ws-a"}

    out = subprocess.run(["bash", str(SCRIPT), "export", f"{GEN}@0.1.0", "registry.test/plugins"], env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    pushed = tmp_path / "registry" / f"registry.test_plugins_{GEN}@0.1.0"
    assert (pushed / "oci-layout").is_file() and len(json.loads((pushed / "index.json").read_text())["manifests"]) == 3

    # Import into another workspace of the same installation (its own key is trusted).
    env[f"{prefix}WORKSPACE"] = "ws-b"
    out = subprocess.run(["bash", str(SCRIPT), "import", f"registry.test/plugins/{GEN}:0.1.0"], env=env, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    imported = json.loads(out.stdout)["imported"]
    # Same id and version already exist here (ws-a built it): nothing new, nothing refused.
    assert imported == []

    # Usage errors exit non-zero with the usage text.
    assert subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True).returncode == 2
    assert subprocess.run(["bash", str(SCRIPT), "export", GEN, "r"], env=env, capture_output=True).returncode == 1
