"""Artifact builder for agent-authored plugins (docs/plugins.md §9, todo2 Phase 9).

    tarball → safe unpack → manifest + declarative-UI + dependency checks → digest → sign
    (dev Ed25519 key; sigstore later) → private artifact store → registry entry with
    trust_tier `generated`, visible to the authoring workspace only

The package is never executed here. Activation still goes through the normal install flow
(plan → stage → validate → human approval), and `stage` verifies the signature and digest.
Generated plugins may only use declarative UI (D2): no `ui.module`, panels name trusted
renderers only.
"""

from __future__ import annotations

import base64
import difflib
import io
import json
import re
import shutil
import tarfile
import tomllib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from fastapi import HTTPException

from ..config import settings
from ..context import RequestContext
from ..naming import canonical_id, naming
from . import catalog, digest

MAX_FILES = 400
MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_DIFF_CHARS = 200_000

# Mirrors apps/web/src/extension-host/trusted-renderers.tsx. The web fails closed on unknown
# names anyway; rejecting here gives the author the error before review.
TRUSTED_RENDERERS = ("studio.declarative-panel.v1", "studio.sandbox-frame.v1", "studio.mask-review.v1")
# Trusted renderers that can fill a viewport (`renderers` in contributions.json, todo10 rung 4):
# the viewer's ESM module goes in `config.module` and runs only in the MCP Apps sandbox.
VIEWPORT_RENDERERS = ("studio.sandbox-frame.v1",)
# The one non-index dependency source a plugin may use: the SDK the worker provides.
ALLOWED_PATH_SOURCES = {"studio-plugin-sdk"}
COPYLEFT = re.compile(r"\b(A?GPL|SSPL|EUPL|OSL)\b", re.I)


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    checks: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors


# ---- Unpacking -------------------------------------------------------------------------------


def unpack(data: bytes) -> dict[str, bytes]:
    """Regular files only, relative paths only, bounded size. Anything else is a 422."""
    try:
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
    except tarfile.TarError as e:
        raise HTTPException(422, f"not a tar archive: {e}") from e
    files: dict[str, bytes] = {}
    total = 0
    with tf:
        for m in tf.getmembers():
            name = m.name.lstrip("./") if m.name.startswith("./") else m.name
            if m.isdir() or not name:
                continue
            if not m.isreg():
                raise HTTPException(422, f"{m.name}: only regular files are allowed (no links or devices)")
            parts = name.split("/")
            if name.startswith("/") or ".." in parts or any(p == "" for p in parts):
                raise HTTPException(422, f"{m.name}: unsafe path")
            if any(p in digest.EXCLUDE_DIRS for p in parts):
                continue
            if m.size > MAX_FILE_BYTES:
                raise HTTPException(422, f"{name}: larger than {MAX_FILE_BYTES // 1024} KB")
            total += m.size
            if total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
                raise HTTPException(422, f"package exceeds {MAX_FILES} files or {MAX_TOTAL_BYTES // 1024 // 1024} MB")
            f = tf.extractfile(m)
            files[name] = f.read() if f else b""
    if "plugin.yaml" not in files:
        raise HTTPException(422, "package has no plugin.yaml at its root")
    return files


# ---- Checks ----------------------------------------------------------------------------------


def _manifest(files: dict[str, bytes]) -> dict:
    try:
        m = yaml.safe_load(files["plugin.yaml"].decode())
    except (yaml.YAMLError, UnicodeDecodeError) as e:
        raise HTTPException(422, f"plugin.yaml doesn't parse: {e}") from e
    if not isinstance(m, dict):
        raise HTTPException(422, "plugin.yaml must be a mapping")
    return m


def _check_ui(m: dict, files: dict[str, bytes], r: Report) -> None:
    ui = m.get("ui") or {}
    if ui.get("module"):
        r.errors.append("generated plugins may only use declarative UI: remove ui.module (D2)")
    if any(p.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs")) for p in files):
        r.errors.append("generated plugins can't ship JavaScript or TypeScript; UI is ui/contributions.json only")
    rel = ui.get("contributions")
    if not rel:
        return
    if rel not in files:
        r.errors.append(f"ui.contributions points at {rel}, which isn't in the package")
        return
    from ..kernel.contracts._generated import ui_contributions_v1

    try:
        doc = json.loads(files[rel])
        ui_contributions_v1.UiContributions.model_validate(doc)
    except Exception as e:  # noqa: BLE001 — any parse or schema error is a check failure
        r.errors.append(f"{rel}: {str(e)[:500]}")
        return
    for p in doc.get("panels") or []:
        if p.get("renderer") not in TRUSTED_RENDERERS:
            r.errors.append(f"{rel}: panel {p.get('id')} names renderer {p.get('renderer')!r}, which isn't a trusted renderer ({', '.join(TRUSTED_RENDERERS)})")
    for v in doc.get("renderers") or []:
        if v.get("renderer") not in VIEWPORT_RENDERERS:
            r.errors.append(f"{rel}: renderer {v.get('id')} names {v.get('renderer')!r}, which can't fill a viewport ({', '.join(VIEWPORT_RENDERERS)})")
    prefix = f"{m.get('id')}."
    for a in doc.get("toolbarActions") or []:
        cmd = canonical_id(str(a.get("command") or ""))
        if not cmd.startswith(prefix):
            r.warnings.append(f"{rel}: action {a.get('id')} runs {cmd}, a command of another plugin; it only works if that plugin is active")
    r.checks["ui"] = "ok"


def _check_dependencies(files: dict[str, bytes], m: dict, r: Report) -> None:
    runtime = (m.get("runtime") or {}).get("kind")
    if "pyproject.toml" not in files:
        if runtime == "python-worker":
            r.errors.append("python-worker plugins need pyproject.toml and uv.lock")
        r.checks["dependencies"] = "none"
        return
    if "uv.lock" not in files:
        r.errors.append("pyproject.toml without uv.lock: dependencies must be locked")
    try:
        py = tomllib.loads(files["pyproject.toml"].decode())
    except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
        r.errors.append(f"pyproject.toml doesn't parse: {e}")
        return
    deps = list((py.get("project") or {}).get("dependencies") or [])
    for name, src in ((py.get("tool") or {}).get("uv") or {}).get("sources", {}).items():
        if name in ALLOWED_PATH_SOURCES and isinstance(src, dict) and set(src) == {"path"}:
            continue
        r.errors.append(f"dependency {name} comes from {sorted(src) if isinstance(src, dict) else src}, not the package index")
    if "uv.lock" in files:
        try:
            lock = tomllib.loads(files["uv.lock"].decode())
        except (tomllib.TOMLDecodeError, UnicodeDecodeError) as e:
            r.errors.append(f"uv.lock doesn't parse: {e}")
            lock = {}
        for pkg in lock.get("package") or []:
            src = pkg.get("source") or {}
            if not src or "registry" in src or "virtual" in src or "editable" in src:
                continue
            if pkg.get("name") in ALLOWED_PATH_SOURCES and "directory" in src:
                continue
            r.errors.append(f"locked package {pkg.get('name')} comes from {sorted(src)}, not the package index")
    r.checks["dependencies"] = {"declared": deps}


def check(files: dict[str, bytes], ctx: RequestContext) -> tuple[dict, Report]:
    """Everything that can be decided from the files alone (run_plugin_checks's host half)."""
    from ..kernel.contracts import validate_plugin_manifest

    r = Report()
    m = _manifest(files)
    r.errors += [f"plugin.yaml: {e}" for e in validate_plugin_manifest(m)]
    pid = canonical_id(str(m.get("id") or ""))
    if pid and not pid.startswith(f"{naming()['namespace']}."):
        r.errors.append(f"id must be in the {naming()['namespace']} namespace")
    for e in catalog.versions(pid):
        if e.trust_tier != "generated":
            r.errors.append(f"{pid} is a {e.trust_tier} plugin; a generated plugin can't take its id (fork it under a new id)")
            break
        if e.workspace_id and e.workspace_id != ctx.workspace_id:
            r.errors.append(f"{pid} belongs to another workspace")
            break
    if m.get("signature"):
        r.errors.append("plugin.yaml can't carry its own signature; the kernel signs the artifact")
    _check_ui(m, files, r)
    _check_dependencies(files, m, r)
    licence = str(m.get("license") or "")
    if COPYLEFT.search(licence):
        r.warnings.append(f"licence {licence} is copyleft; check it's acceptable for this workspace")
    r.checks["manifest"] = "ok" if not any(e.startswith("plugin.yaml") for e in r.errors) else "failed"
    return m, r


# ---- Signing ---------------------------------------------------------------------------------


def _signing_key() -> Ed25519PrivateKey:
    f = settings().data_dir / "plugin-signing.key"
    if not f.is_file():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        f.chmod(0o600)
    key = serialization.load_pem_private_key(f.read_bytes(), password=None)
    assert isinstance(key, Ed25519PrivateKey)
    return key


def _payload(plugin_id: str, version: str, artifact_digest: str) -> bytes:
    return f"{plugin_id}@{version}\n{artifact_digest}\n".encode()


def sign(plugin_id: str, version: str, artifact_digest: str) -> dict:
    sig = _signing_key().sign(_payload(plugin_id, version, artifact_digest))
    pub = _signing_key().public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {"alg": "ed25519", "keyId": base64.urlsafe_b64encode(pub[:8]).decode().rstrip("="), "sig": base64.b64encode(sig).decode()}


def verify(e: catalog.Entry, staged_digest: str) -> str | None:
    """None if `e`'s signature covers its id, version and the staged digest; else the problem."""
    s = e.signature or {}
    if s.get("alg") != "ed25519" or not s.get("sig"):
        return "generated artifacts must be signed"
    pub: Ed25519PublicKey = _signing_key().public_key()
    try:
        pub.verify(base64.b64decode(s["sig"]), _payload(e.id, e.version, staged_digest))
    except Exception:  # noqa: BLE001 — InvalidSignature or a malformed signature
        return "signature doesn't match the staged package"
    return None


# ---- Review diff -----------------------------------------------------------------------------


def _read_tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in digest.package_files(root)}


def _base(base: str | None, plugin_id: str) -> tuple[str, dict[str, bytes]]:
    """The tree the diff is against: an explicit base plugin, the previous generated version, or the template."""
    if base and base != "template":
        e = catalog.get(base)
        d = catalog.package_dir(e) if e else None
        if d is None or not d.is_dir():
            raise HTTPException(422, f"base {base} isn't in the registry")
        assert e is not None
        return f"{e.id}@{e.version}", _read_tree(d)
    prev = catalog.versions(plugin_id)
    if base is None and prev and (d := catalog.package_dir(prev[-1])) and d.is_dir():
        return f"{prev[-1].id}@{prev[-1].version}", _read_tree(d)
    tmpl = settings().plugins_dir / "_template"
    return "template", _read_tree(tmpl) if tmpl.is_dir() else {}


def code_diff(base_files: dict[str, bytes], files: dict[str, bytes]) -> dict:
    out: list[str] = []
    added = sorted(set(files) - set(base_files))
    removed = sorted(set(base_files) - set(files))
    changed = sorted(p for p in set(files) & set(base_files) if files[p] != base_files[p])
    for p in sorted(set(files) | set(base_files)):
        if p in base_files and p in files and files[p] == base_files[p]:
            continue
        try:
            a = base_files.get(p, b"").decode().splitlines(keepends=True)
            b = files.get(p, b"").decode().splitlines(keepends=True)
        except UnicodeDecodeError:
            out.append(f"Binary file {p} differs\n")
            continue
        out.extend(difflib.unified_diff(a, b, f"a/{p}" if p in base_files else "/dev/null", f"b/{p}" if p in files else "/dev/null"))
    text = "".join(out)
    truncated = len(text) > MAX_DIFF_CHARS
    return {"added": added, "changed": changed, "removed": removed, "diff": text[:MAX_DIFF_CHARS], "truncated": truncated}


# ---- Store and registry ----------------------------------------------------------------------


def _store_root() -> Path:
    return settings().data_dir / "plugin-artifacts"


def _generated_index() -> Path:
    return settings().data_dir / "registry-generated.json"


def build(data: bytes, ctx: RequestContext, *, base: str | None = None, dry_run: bool = False) -> dict:
    files = unpack(data)
    m, r = check(files, ctx)
    pid, version = canonical_id(str(m.get("id") or "")), str(m.get("version") or "")
    art_digest = digest.files_digest(files)
    out = {"pluginId": pid, "version": version, "artifactDigest": art_digest, "ok": r.ok, "errors": r.errors, "warnings": r.warnings, "checks": r.checks}
    if dry_run or not r.ok:
        return out
    existing = next((e for e in catalog.versions(pid) if e.version == version), None)
    if existing is not None:
        if existing.artifact_digest == art_digest:
            return {**out, "registered": False, "duplicate": True}
        raise HTTPException(409, f"{pid}@{version} already exists with different contents; bump the version")
    base_name, base_files = _base(base, pid)
    review = {"base": base_name, **code_diff(base_files, files)}

    pkg = _store_root() / pid / version / "package"
    if pkg.exists():
        shutil.rmtree(pkg)
    for rel, b in files.items():
        (pkg / rel).parent.mkdir(parents=True, exist_ok=True)
        (pkg / rel).write_bytes(b)
    (pkg.parent / "package.tar").write_bytes(data)
    if digest.tree_digest(pkg) != art_digest:  # the stored tree must be exactly what was checked
        shutil.rmtree(pkg.parent)
        raise HTTPException(500, "artifact store wrote a different tree than was checked")

    entry = {
        "id": pid,
        "version": version,
        "publisher": f"generated:{ctx.principal}",
        "trustTier": "generated",
        "artifactDigest": art_digest,
        "path": str(pkg),
        "manifest": m,
        "licenses": {"code": m.get("license")},
        "signature": sign(pid, version, art_digest),
        "workspaceId": ctx.workspace_id,
        "createdBy": ctx.principal,
        "createdAt": datetime.now(UTC).isoformat(),
        "review": review,
    }
    idx = _generated_index()
    doc = json.loads(idx.read_text()) if idx.is_file() else {"version": 1, "plugins": []}
    doc["plugins"].append(entry)
    idx.parent.mkdir(parents=True, exist_ok=True)
    tmp = idx.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, indent=2))
    tmp.replace(idx)
    return {**out, "registered": True, "review": {k: v for k, v in review.items() if k != "diff"}}
