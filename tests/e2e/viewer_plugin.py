"""The rung-4 PLY viewer fixture (todo10 Phase 5), shared by viewer_test.py and mcp_apps_host_test.py.

`pack()` builds the plugin package the way the agent's build step does: plugin.yaml and
ui/contributions.json only, with the viewer's ESM source (viewer.mjs) placed in the renderer's
`config.module`, as a gzipped tarball for `POST /api/v1/plugins/artifacts`. `synthetic_ply()`
writes a synthetic point cloud (a coloured sphere); no real data is involved.
"""
from __future__ import annotations

import io
import json
import math
import struct
import tarfile
from pathlib import Path

HERE = Path(__file__).parent / "fixtures" / "viewer-ply"


def files(namespace: str) -> dict[str, bytes]:
    yaml = (HERE / "plugin.yaml").read_text().replace("{{namespace}}", namespace)
    ui = json.loads((HERE / "ui" / "contributions.json").read_text())
    ui["renderers"][0]["config"]["module"] = (HERE / "viewer.mjs").read_text()
    return {"plugin.yaml": yaml.encode(), "ui/contributions.json": (json.dumps(ui, indent=2) + "\n").encode()}


def plugin_id(namespace: str) -> str:
    return f"{namespace}.ply-viewer"


def contributions(namespace: str) -> dict:
    return json.loads(files(namespace)["ui/contributions.json"])


def pack(namespace: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, data in files(namespace).items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def synthetic_ply(n: int = 2000) -> bytes:
    """Binary little-endian PLY: n points on a unit sphere (Fibonacci lattice), coloured by height."""
    header = f"ply\nformat binary_little_endian 1.0\ncomment synthetic sphere\nelement vertex {n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    body = bytearray()
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        y = 1 - 2 * (i + 0.5) / n
        r = math.sqrt(1 - y * y)
        x, z = math.cos(golden * i) * r, math.sin(golden * i) * r
        c = int((y + 1) * 127)
        body += struct.pack("<fffBBB", x, y, z, c, 64, 255 - c)
    return header.encode() + bytes(body)
