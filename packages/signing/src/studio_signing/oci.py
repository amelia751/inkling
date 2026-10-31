"""Plugin artifacts in an OCI-compatible layout (todo10 §3.1, Phase 3; D4).

One plugin version is one OCI image manifest:

    manifest (application/vnd.oci.image.manifest.v1+json, artifactType <ns>.plugin.v1)
      config  application/vnd.<ns>.plugin.config.v1+json   plugin.yaml as JSON
      layer   application/vnd.<ns>.plugin.package.v1.tar   the package, a deterministic tar
      annotations: title (plugin id), version, <ns>.plugin.tree-digest

Every blob is stored at `artifacts/sha256/<hex>` and named by its own sha256, so the
manifest digest pins everything below it; signatures are over the manifest digest.
Signatures and attestations are referrers (OCI 1.1 `subject`), so `oras copy -r` carries
them to another registry unchanged (Phase 8).

The *tree digest* (sha256 over `<path>\\0<sha256 of file>\\n` for every file, sorted) is
the digest pins and lockfiles use; it ignores tar metadata, and tools/build-registry.mjs
computes the same value for first-party plugins.

Nothing here touches storage: callers pass a `get(digest) -> bytes` and store what
`pack` returns. Both the API and the worker's `build_plugin` use it.
"""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import DIGEST_RE, sha256_digest

OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_EMPTY = "application/vnd.oci.empty.v1+json"
EMPTY_JSON = b"{}"
DSSE = "application/vnd.dsse.envelope.v1+json"
IN_TOTO = "application/vnd.in-toto+json"
STATEMENT_V1 = "https://in-toto.io/Statement/v1"
SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1"

EXCLUDE_DIRS = {"node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".data"}
MAX_FILES = 2000
MAX_LAYER_BYTES = 64 * 1024 * 1024


class ArtifactRefused(ValueError):
    """The artifact failed verification; `str(e)` is the reason, safe to show and audit."""


@dataclass(frozen=True)
class MediaTypes:
    artifact: str
    config: str
    layer: str
    signature: str
    tree_annotation: str

    @classmethod
    def for_namespace(cls, ns: str) -> MediaTypes:
        return cls(
            artifact=f"application/vnd.{ns}.plugin.v1",
            config=f"application/vnd.{ns}.plugin.config.v1+json",
            layer=f"application/vnd.{ns}.plugin.package.v1.tar",
            signature=f"application/vnd.{ns}.plugin.signature.v1+json",
            tree_annotation=f"{ns}.plugin.tree-digest",
        )


def _excluded(rel: str) -> bool:
    return any(part in EXCLUDE_DIRS for part in rel.split("/"))


def tree_digest(files: dict[str, bytes]) -> str:
    h = hashlib.sha256()
    for rel in sorted(files):
        if _excluded(rel):
            continue
        h.update(f"{rel}\0{hashlib.sha256(files[rel]).hexdigest()}\n".encode())
    return f"sha256:{h.hexdigest()}"


def tree_digest_of_hashes(hashes: dict[str, str]) -> str:
    """The same digest from `{path: hex sha256}` (what the browser recomputes)."""
    h = hashlib.sha256()
    for rel in sorted(hashes):
        if not _excluded(rel):
            h.update(f"{rel}\0{hashes[rel]}\n".encode())
    return f"sha256:{h.hexdigest()}"


def canonical_json(doc: Any) -> bytes:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def layer_tar(files: dict[str, bytes]) -> bytes:
    """Same files → same bytes: sorted, mtime 0, root-owned, mode 0644, PAX format, no compression."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        for rel in sorted(files):
            if _excluded(rel):
                continue
            info = tarfile.TarInfo(rel)
            info.size, info.mtime, info.mode, info.uid, info.gid, info.uname, info.gname = len(files[rel]), 0, 0o644, 0, 0, "", ""
            tf.addfile(info, io.BytesIO(files[rel]))
    return buf.getvalue()


def untar_layer(data: bytes) -> dict[str, bytes]:
    """Regular files with safe relative paths only; anything else refuses the artifact."""
    out: dict[str, bytes] = {}
    try:
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
    except tarfile.TarError as e:
        raise ArtifactRefused(f"package layer isn't a tar archive ({e.__class__.__name__})") from e
    with tf:
        for m in tf.getmembers():
            parts = m.name.split("/")
            if not m.isreg():
                raise ArtifactRefused(f"package layer has a non-file entry {m.name!r}")
            if m.name.startswith("/") or ".." in parts or "" in parts or m.name in out:
                raise ArtifactRefused(f"package layer has an unsafe path {m.name!r}")
            if len(out) >= MAX_FILES:
                raise ArtifactRefused("package layer has too many files")
            f = tf.extractfile(m)
            out[m.name] = f.read() if f else b""
    return out


def descriptor(media_type: str, data: bytes, **extra: Any) -> dict:
    return {"mediaType": media_type, "digest": sha256_digest(data), "size": len(data), **extra}


@dataclass
class Packed:
    """What to store: every blob by digest, plus the manifest's digest (the artifact's identity)."""

    manifest_digest: str
    tree_digest: str
    blobs: dict[str, bytes] = field(default_factory=dict)
    media_types: dict[str, str] = field(default_factory=dict)

    def add(self, media_type: str, data: bytes) -> dict:
        d = descriptor(media_type, data)
        self.blobs[d["digest"]] = data
        self.media_types[d["digest"]] = media_type
        return d


def pack(files: dict[str, bytes], *, plugin_id: str, version: str, manifest: dict, mt: MediaTypes, created: str | None = None) -> Packed:
    td = tree_digest(files)
    p = Packed(manifest_digest="", tree_digest=td)
    config = p.add(mt.config, canonical_json(manifest))
    layer = p.add(mt.layer, layer_tar(files))
    annotations = {"org.opencontainers.image.title": plugin_id, "org.opencontainers.image.version": version, mt.tree_annotation: td}
    if created:
        annotations["org.opencontainers.image.created"] = created
    doc = {"schemaVersion": 2, "mediaType": OCI_MANIFEST, "artifactType": mt.artifact, "config": config, "layers": [layer], "annotations": annotations}
    raw = canonical_json(doc)
    p.manifest_digest = p.add(OCI_MANIFEST, raw)["digest"]
    return p


def referrer(subject_digest: str, subject_size: int, *, artifact_type: str, layer_media_type: str, layer: bytes, annotations: dict | None = None) -> tuple[bytes, bytes, bytes]:
    """An OCI 1.1 referrer manifest pointing at `subject` → (manifest bytes, empty config, layer)."""
    doc = {
        "schemaVersion": 2,
        "mediaType": OCI_MANIFEST,
        "artifactType": artifact_type,
        "config": descriptor(OCI_EMPTY, EMPTY_JSON),
        "layers": [descriptor(layer_media_type, layer)],
        "subject": {"mediaType": OCI_MANIFEST, "digest": subject_digest, "size": subject_size},
        **({"annotations": annotations} if annotations else {}),
    }
    return canonical_json(doc), EMPTY_JSON, layer


def checked(get: Callable[[str], bytes], digest: str, what: str) -> bytes:
    if not DIGEST_RE.match(digest or ""):
        raise ArtifactRefused(f"{what} has no valid sha256 digest")
    try:
        data = get(digest)
    except KeyError as e:
        raise ArtifactRefused(f"{what} {digest} is missing from the artifact store") from e
    if sha256_digest(data) != digest:
        raise ArtifactRefused(f"{what} {digest} doesn't match its digest (the stored bytes changed)")
    return data


def read_manifest(get: Callable[[str], bytes], manifest_digest: str, mt: MediaTypes) -> dict:
    raw = checked(get, manifest_digest, "artifact manifest")
    try:
        doc = json.loads(raw)
    except ValueError as e:
        raise ArtifactRefused("artifact manifest isn't JSON") from e
    if doc.get("mediaType") != OCI_MANIFEST or doc.get("artifactType") != mt.artifact:
        raise ArtifactRefused("artifact manifest isn't a plugin artifact")
    layers = doc.get("layers") or []
    if len(layers) != 1 or layers[0].get("mediaType") != mt.layer:
        raise ArtifactRefused("artifact manifest must have exactly one package layer")
    if int(layers[0].get("size") or 0) > MAX_LAYER_BYTES:
        raise ArtifactRefused("package layer is too large")
    return doc


def unpack(get: Callable[[str], bytes], manifest_digest: str, mt: MediaTypes, *, expect_tree: str | None = None) -> tuple[dict, dict[str, bytes], dict]:
    """Verify every byte from the manifest down → (manifest doc, package files, plugin.yaml as JSON).

    Raises ArtifactRefused with the first problem found.
    """
    doc = read_manifest(get, manifest_digest, mt)
    layer = doc["layers"][0]
    data = checked(get, layer["digest"], "package layer")
    if len(data) != int(layer.get("size", -1)):
        raise ArtifactRefused("package layer size doesn't match the manifest")
    files = untar_layer(data)
    td = tree_digest(files)
    if td != (doc.get("annotations") or {}).get(mt.tree_annotation):
        raise ArtifactRefused("package files don't match the manifest's tree digest")
    if expect_tree and td != expect_tree:
        raise ArtifactRefused(f"package tree digest {td} isn't the pinned {expect_tree}")
    try:
        config = json.loads(checked(get, doc["config"]["digest"], "artifact config"))
    except (KeyError, TypeError, ValueError) as e:
        raise ArtifactRefused("artifact config is missing or isn't JSON") from e
    return doc, files, config


# ---- attestations --------------------------------------------------------------------------


def provenance_statement(subject_name: str, manifest_digest: str, *, builder: str, build_type: str, external: dict, internal: dict | None = None, run: dict | None = None) -> dict:
    """An in-toto Statement v1 with a SLSA v1 provenance predicate (§3.1: which agent run,
    prompt hash, model, checks passed, sample digests tested go in `externalParameters` /
    `internalParameters`)."""
    return {
        "_type": STATEMENT_V1,
        "subject": [{"name": subject_name, "digest": {"sha256": manifest_digest.removeprefix("sha256:")}}],
        "predicateType": SLSA_PROVENANCE_V1,
        "predicate": {
            "buildDefinition": {"buildType": build_type, "externalParameters": external, "internalParameters": internal or {}},
            "runDetails": {"builder": {"id": builder}, "metadata": run or {}},
        },
    }


# ---- OCI image layout (directories `oras copy --from-oci-layout` reads) ---------------------


def write_layout(root: Any, blobs: dict[str, bytes], manifests: list[dict]) -> None:
    """`root/oci-layout`, `root/index.json` (the given manifest descriptors), `root/blobs/sha256/*`."""
    from pathlib import Path

    root = Path(root)
    (root / "blobs" / "sha256").mkdir(parents=True, exist_ok=True)
    (root / "oci-layout").write_text(json.dumps({"imageLayoutVersion": "1.0.0"}))
    for d, data in blobs.items():
        if sha256_digest(data) != d:
            raise ArtifactRefused(f"blob {d} doesn't match its digest")
        (root / "blobs" / "sha256" / d.removeprefix("sha256:")).write_bytes(data)
    (root / "index.json").write_text(json.dumps({"schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": manifests}, indent=2))


def read_layout(root: Any) -> tuple[list[dict], Callable[[str], bytes]]:
    """(index manifests, get) for an OCI image layout directory."""
    from pathlib import Path

    root = Path(root)
    try:
        if json.loads((root / "oci-layout").read_text()).get("imageLayoutVersion") != "1.0.0":
            raise ArtifactRefused("not an OCI image layout 1.0.0")
        index = json.loads((root / "index.json").read_text())
    except (OSError, ValueError) as e:
        raise ArtifactRefused("not an OCI image layout (oci-layout / index.json)") from e

    def get(d: str) -> bytes:
        if not DIGEST_RE.match(d):
            raise KeyError(d)
        p = root / "blobs" / "sha256" / d.removeprefix("sha256:")
        if not p.is_file():
            raise KeyError(d)
        return p.read_bytes()

    return list(index.get("manifests") or []), get
