#!/usr/bin/env python3
"""Pack first-party plugins into an OCI image layout (todo10 Phase 3; the CI signing input).

    uv run python tools/pack-plugins.py --out dist/plugins            # every plugins/<dir>
    uv run python tools/pack-plugins.py --out dist/plugins image2d    # just these

Each plugin becomes one OCI manifest (studio_signing.oci.pack: plugin.yaml as the config, the
package as one deterministic tar layer), so the same tree always gives the same manifest
digest. The tree digest must equal registry/index.json's `artifactDigest`, or this exits 1
(the registry is stale: run `node tools/build-registry.mjs`).

Writes `<out>/` as an OCI image layout (`oci-layout`, `index.json`, `blobs/sha256/*`; refs are
`<id>@<version>` in `org.opencontainers.image.ref.name`) plus `<out>/manifests.json`:
[{id, version, treeDigest, manifestDigest, blob}] for the signing step
(.github/workflows/sign-plugins.yml runs `cosign sign-blob` on each `blob`).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml
from studio_signing import oci

ROOT = Path(__file__).resolve().parents[1]


def package_files(d: Path) -> dict[str, bytes]:
    out = {}
    for p in sorted(d.rglob("*")):
        rel = p.relative_to(d).as_posix()
        if p.is_file() and not any(part in oci.EXCLUDE_DIRS for part in rel.split("/")):
            out[rel] = p.read_bytes()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("plugins", nargs="*", help="plugin folder names (default: all)")
    args = ap.parse_args()

    ns = json.loads((ROOT / "schemas" / "naming.json").read_text())["namespace"]
    mt = oci.MediaTypes.for_namespace(ns)
    index = {e["id"]: e for e in json.loads((ROOT / "registry" / "index.json").read_text())["plugins"] if e.get("path")}
    dirs = [ROOT / "plugins" / n for n in args.plugins] if args.plugins else sorted(p for p in (ROOT / "plugins").iterdir() if p.is_dir() and not p.name.startswith("_") and (p / "plugin.yaml").is_file())

    blobs: dict[str, bytes] = {}
    refs: list[dict] = []
    out: list[dict] = []
    stale: list[str] = []
    for d in dirs:
        files = package_files(d)
        m = yaml.safe_load(files["plugin.yaml"])
        pid, version = m["id"], str(m["version"])
        packed = oci.pack(files, plugin_id=pid, version=version, manifest=m, mt=mt)
        reg = index.get(pid)
        if reg is None or reg.get("artifactDigest") != packed.tree_digest:
            stale.append(f"{pid}: registry {reg.get('artifactDigest') if reg else 'missing'}, tree {packed.tree_digest}")
        blobs.update(packed.blobs)
        raw = packed.blobs[packed.manifest_digest]
        refs.append(oci.descriptor(oci.OCI_MANIFEST, raw, artifactType=mt.artifact, annotations={"org.opencontainers.image.ref.name": f"{pid}@{version}"}))
        out.append({"id": pid, "version": version, "treeDigest": packed.tree_digest, "manifestDigest": packed.manifest_digest, "blob": f"blobs/sha256/{packed.manifest_digest[7:]}"})
    if stale:
        print("registry/index.json is stale (node tools/build-registry.mjs):\n  " + "\n  ".join(stale), file=sys.stderr)
        return 1
    oci.write_layout(args.out, blobs, refs)
    (args.out / "manifests.json").write_text(json.dumps(out, indent=2))
    for e in out:
        print(f"{e['id']}@{e['version']} {e['manifestDigest']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
