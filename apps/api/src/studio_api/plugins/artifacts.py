"""Artifact builder for agent-authored plugins (docs/plugins.md §9, todo2 Phase 9).

    tarball → safe unpack → manifest + declarative-UI + dependency checks → tree digest →
    OCI manifest + deterministic layer at artifacts/sha256/<digest> (store.py) → signature over
    the manifest digest (the configured Signer: local Ed25519 in dev, Cloud KMS in production)
    → DSSE-signed in-toto provenance attestation → `plugin_artifacts` row with trust_tier
    `generated`, visible to the authoring workspace only (todo10 Phase 3)

The package is never executed here. Activation still goes through the normal install flow
(plan → stage → validate → human approval); `stage` and every later load re-verify the
bytes, the signature and the attestation (store.verify).
Generated plugins may only use declarative UI (D2): no `ui.module`, panels name trusted
renderers only.
"""

from __future__ import annotations

import difflib
import io
import json
import re
import tarfile
import tomllib
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session
from studio_signing import dsse_sign, envelope, oci

from ..config import settings
from ..context import RequestContext
from ..models import PluginArtifact
from ..naming import canonical_id, naming
from . import catalog, digest, store

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


def check(files: dict[str, bytes], ctx: RequestContext, db: Session | None = None) -> tuple[dict, Report]:
    """Everything that can be decided from the files alone (run_plugin_checks's host half)."""
    from ..kernel.contracts import validate_plugin_manifest

    r = Report()
    m = _manifest(files)
    r.errors += [f"plugin.yaml: {e}" for e in validate_plugin_manifest(m)]
    pid = canonical_id(str(m.get("id") or ""))
    if pid and not pid.startswith(f"{naming()['namespace']}."):
        r.errors.append(f"id must be in the {naming()['namespace']} namespace")
    for e in catalog.versions(pid, db):
        if not e.stored:
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


# ---- Review diff -----------------------------------------------------------------------------


def _read_tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in digest.package_files(root)}


def _base(db: Session, base: str | None, plugin_id: str) -> tuple[str, dict[str, bytes]]:
    """The tree the diff is against: an explicit base plugin, the previous stored version, or the template."""
    if base and base != "template":
        e = catalog.get(base, db=db)
        try:
            files = catalog.load_files(e) if e else None
        except oci.ArtifactRefused:
            files = None
        if e is None or files is None:
            raise HTTPException(422, f"base {base} isn't in the registry")
        return f"{e.id}@{e.version}", files
    prev = catalog.versions(plugin_id, db)
    if base is None and prev:
        try:
            return f"{prev[-1].id}@{prev[-1].version}", catalog.load_files(prev[-1])
        except oci.ArtifactRefused:
            pass  # a refused base never feeds the review; fall back to the template
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


# ---- Provenance ------------------------------------------------------------------------------

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_SHORT = re.compile(r"^[A-Za-z0-9._:/@+-]{1,200}$")


def provenance(run_id: str | None = None, prompt_hash: str | None = None, model: str | None = None, sample_digests: str | None = None) -> dict:
    """What the author claims about the build (§3.1): agent run, prompt hash, model, sample
    digests tested. Fixed formats only, so no free text reaches the attestation."""
    out: dict = {}
    if run_id:
        if not _SHORT.match(run_id):
            raise HTTPException(422, "runId must be a short identifier")
        out["agentRunId"] = run_id
    if prompt_hash:
        if not _DIGEST.match(prompt_hash):
            raise HTTPException(422, "promptHash must be sha256:<64 hex>")
        out["promptHash"] = prompt_hash
    if model:
        if not _SHORT.match(model):
            raise HTTPException(422, "model must be a short identifier")
        out["model"] = model
    samples = [x for x in (sample_digests or "").split(",") if x]
    if any(not _DIGEST.match(x) for x in samples) or len(samples) > 100:
        raise HTTPException(422, "sampleDigests must be up to 100 comma-separated sha256:<64 hex>")
    if samples:
        out["sampleDigests"] = samples
    return out


# ---- Store and registry ----------------------------------------------------------------------


def store_signed(files: dict[str, bytes], m: dict, *, plugin_id: str, version: str, external: dict, internal: dict, ctx: RequestContext, created: str) -> dict:
    """Pack (OCI), store every blob, sign the manifest digest, attest. Returns the row's fields.

    The worker's `build_plugin` produces the same layout with `studio_signing.oci.pack`.
    """
    mt = store.media_types()
    packed = oci.pack(files, plugin_id=plugin_id, version=version, manifest=m, mt=mt, created=created)
    signer = store.signer()
    sig = envelope(signer, packed.manifest_digest)
    msize = len(packed.blobs[packed.manifest_digest])
    blobs = dict(packed.blobs)
    media = dict(packed.media_types)
    refs: list[str] = []

    def add_ref(raw: bytes, cfg: bytes, layer: bytes, layer_type: str) -> str:
        for b, t in ((raw, oci.OCI_MANIFEST), (cfg, oci.OCI_EMPTY), (layer, layer_type)):
            blobs[oci.sha256_digest(b)] = b
            media[oci.sha256_digest(b)] = t
        refs.append(oci.sha256_digest(raw))
        return refs[-1]

    add_ref(*oci.referrer(packed.manifest_digest, msize, artifact_type=mt.signature, layer_media_type=mt.signature, layer=oci.canonical_json(sig)), mt.signature)
    statement = oci.provenance_statement(
        f"{plugin_id}@{version}",
        packed.manifest_digest,
        builder=f"{naming()['namespace']}.api/plugins/artifacts",
        build_type=f"{naming()['namespace']}.plugin-artifact/v1",
        external=external,
        internal=internal,
        run={"invocationId": ctx.correlation_id, "startedOn": created, "author": ctx.principal},
    )
    dsse = dsse_sign(signer, oci.IN_TOTO, oci.canonical_json(statement))
    att = add_ref(*oci.referrer(packed.manifest_digest, msize, artifact_type=oci.IN_TOTO, layer_media_type=oci.DSSE, layer=oci.canonical_json(dsse)), oci.DSSE)
    store.put(blobs, media)
    return {"manifest_digest": packed.manifest_digest, "artifact_digest": packed.tree_digest, "signature": sig, "referrers": refs, "attestation_digest": att}


def build(data: bytes, ctx: RequestContext, db: Session, *, base: str | None = None, dry_run: bool = False, claims: dict | None = None) -> dict:
    files = unpack(data)
    m, r = check(files, ctx, db)
    pid, version = canonical_id(str(m.get("id") or "")), str(m.get("version") or "")
    art_digest = digest.files_digest(files)
    out = {"pluginId": pid, "version": version, "artifactDigest": art_digest, "ok": r.ok, "errors": r.errors, "warnings": r.warnings, "checks": r.checks}
    if dry_run or not r.ok:
        return out
    existing = db.get(PluginArtifact, (pid, version))
    if existing is not None:
        if existing.artifact_digest == art_digest:
            return {**out, "registered": False, "duplicate": True, "manifestDigest": existing.manifest_digest}
        raise HTTPException(409, f"{pid}@{version} already exists with different contents; bump the version")
    base_name, base_files = _base(db, base, pid)
    review = {"base": base_name, **code_diff(base_files, files)}
    created = datetime.now(UTC).isoformat()
    stored = store_signed(
        files,
        m,
        plugin_id=pid,
        version=version,
        external={**(claims or {}), "base": base_name},
        internal={"checks": r.checks, "warnings": r.warnings},
        ctx=ctx,
        created=created,
    )
    if stored["artifact_digest"] != art_digest:  # the stored tree must be exactly what was checked
        raise HTTPException(500, "artifact store packed a different tree than was checked")
    # The stored bytes are read back and verified before the entry exists.
    try:
        store.verify(manifest_digest=stored["manifest_digest"], artifact_digest=art_digest, signature=stored["signature"], manifest=m, attestation_digest=stored["attestation_digest"])
    except oci.ArtifactRefused as e:
        raise HTTPException(500, f"artifact store didn't return what was written: {e}") from e
    db.add(
        PluginArtifact(
            plugin_id=pid,
            version=version,
            publisher=f"generated:{ctx.principal}",
            trust_tier="generated",
            manifest=m,
            licenses={"code": m.get("license")},
            workspace_id=ctx.workspace_id,
            review=review,
            created_by=ctx.principal,
            source="built",
            **stored,
        )
    )
    db.flush()
    return {
        **out,
        "registered": True,
        "manifestDigest": stored["manifest_digest"],
        "signature": {k: stored["signature"][k] for k in ("signer", "alg", "keyId")},
        "attestationDigest": stored["attestation_digest"],
        "review": {k: v for k, v in review.items() if k != "diff"},
    }
