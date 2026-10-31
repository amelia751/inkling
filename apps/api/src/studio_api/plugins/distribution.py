"""Distribution between installations and promotion tiers (todo10 Phase 8).

Export / import. A stored artifact leaves as an OCI image layout (`oci-layout`, `index.json`,
`blobs/sha256/*`). It holds the plugin manifest tagged `<version>` plus its signature and
attestation referrers, so `oras copy -r --from-oci-layout <dir>:<version> <registry>/<id>:<version>`
pushes it with its signatures to any OCI registry (zot, GHCR, Artifact Registry, Harbor), and
`oras copy -r` mirrors it into an air-gapped registry unchanged (tools/oras-plugins.sh). Import
reads such a layout back. It verifies every byte from the manifest down, plus the signature and
attestation by a key this installation trusts (its own Signer or `INKLING_API_SIGNER_TRUSTED_KEYS_FILE`).
Then it stores the blobs and registers the artifact. Both directions need `plugins.approve`
(a person): a new signer or new code is capability-widening (§3.4).

Promotion. generated (one workspace) → organisation (every project of that organisation) →
curated (every workspace of this installation), one step at a time. A promotion is requested,
then reviewed by a person who is neither the requester nor the artifact's author, and the
artifact is re-verified at approval. Every request and decision is an append-only
`plugin_promotions` row plus an audit entry.
"""

from __future__ import annotations

import io
import json
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session
from studio_signing import oci

from ..context import RequestContext
from ..kernel import audit
from ..models import PluginArtifact, PluginPromotion
from ..naming import canonical_id
from . import catalog, digest, store

TIERS = ("generated", "organisation", "curated")
NEXT = {"generated": "organisation", "organisation": "curated"}
MAX_LAYOUT_BYTES = 64 * 1024 * 1024


def _row(db: Session, plugin_id: str, version: str) -> PluginArtifact:
    row = db.get(PluginArtifact, (canonical_id(plugin_id), version))
    if row is None:
        raise HTTPException(404, f"{plugin_id}@{version} isn't a stored artifact")
    return row


def _verify_row(row: PluginArtifact) -> dict[str, bytes]:
    try:
        return store.verify(manifest_digest=row.manifest_digest, artifact_digest=row.artifact_digest, signature=row.signature, manifest=row.manifest, attestation_digest=row.attestation_digest)
    except oci.ArtifactRefused as e:
        raise HTTPException(409, {"message": f"{row.plugin_id}@{row.version} failed verification", "reason": str(e)}) from e


# ---- export --------------------------------------------------------------------------------


def _manifest_closure(digest_: str) -> dict[str, bytes]:
    """A manifest and every blob it names (config, layers), each checked against its digest."""
    raw = oci.checked(store.get, digest_, "manifest")
    doc = json.loads(raw)
    out = {digest_: raw}
    for d in [doc.get("config") or {}, *(doc.get("layers") or [])]:
        out[d["digest"]] = oci.checked(store.get, d["digest"], "blob")
    return out


def export_layout(db: Session, ctx: RequestContext, plugin_id: str, version: str, root: Path) -> dict:
    row = _row(db, plugin_id, version)
    if row.trust_tier == "generated" and row.workspace_id != ctx.workspace_id:
        raise HTTPException(404, f"{plugin_id}@{version} isn't a stored artifact")
    _verify_row(row)
    mt = store.media_types()
    blobs = _manifest_closure(row.manifest_digest)
    manifests = [oci.descriptor(oci.OCI_MANIFEST, blobs[row.manifest_digest], artifactType=mt.artifact, annotations={"org.opencontainers.image.ref.name": row.version, "org.opencontainers.image.title": row.plugin_id})]
    for ref in row.referrers or []:
        rb = _manifest_closure(ref)
        blobs.update(rb)
        rdoc = json.loads(rb[ref])
        manifests.append(oci.descriptor(oci.OCI_MANIFEST, rb[ref], artifactType=rdoc.get("artifactType")))
    oci.write_layout(root, blobs, manifests)
    audit.record(db, ctx, "plugins.export", target=f"{row.plugin_id}@{row.version}", after={"manifestDigest": row.manifest_digest, "referrers": list(row.referrers or [])})
    return {"pluginId": row.plugin_id, "version": row.version, "manifestDigest": row.manifest_digest, "referrers": list(row.referrers or [])}


def export_tar(db: Session, ctx: RequestContext, plugin_id: str, version: str) -> tuple[bytes, dict]:
    with tempfile.TemporaryDirectory(prefix="oci-export-") as d:
        info = export_layout(db, ctx, plugin_id, version, Path(d))
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tf:
            for p in sorted(Path(d).rglob("*")):
                if p.is_file():
                    tf.add(p, arcname=p.relative_to(d).as_posix(), recursive=False)
        return buf.getvalue(), info


# ---- import --------------------------------------------------------------------------------


def _untar_layout(data: bytes, root: Path) -> None:
    if len(data) > MAX_LAYOUT_BYTES:
        raise HTTPException(413, "layout too large")
    try:
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:*")
    except tarfile.TarError as e:
        raise HTTPException(422, "not a tar of an OCI image layout") from e
    with tf:
        for m in tf.getmembers():
            name = m.name.removeprefix("./")
            if m.isdir() or not name or name.rsplit("/", 1)[-1].startswith("._"):
                continue  # directories; macOS AppleDouble metadata
            parts = name.split("/")
            if not m.isreg() or name.startswith("/") or ".." in parts or not (name in ("oci-layout", "index.json") or (len(parts) == 3 and parts[:2] == ["blobs", "sha256"])):
                raise HTTPException(422, f"{m.name}: not part of an OCI image layout")
            f = tf.extractfile(m)
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(f.read() if f else b"")


def _all_manifests(root: Path, get) -> dict[str, dict]:  # noqa: ANN001
    """Every OCI manifest in the layout's blobs (oras may not list referrers in index.json)."""
    out: dict[str, dict] = {}
    for p in sorted((root / "blobs" / "sha256").glob("*")):
        d = f"sha256:{p.name}"
        try:
            doc = json.loads(oci.checked(get, d, "blob"))
        except (ValueError, oci.ArtifactRefused):
            continue
        if isinstance(doc, dict) and doc.get("mediaType") == oci.OCI_MANIFEST:
            out[d] = doc
    return out


def import_layout(db: Session, ctx: RequestContext, root: Path, *, tier: str = "generated") -> list[dict]:
    """Verify and register every plugin artifact in the layout. Nothing is stored unless all pass."""
    if tier not in TIERS:
        raise HTTPException(422, f"tier must be one of {', '.join(TIERS)}")
    mt = store.media_types()
    try:
        _, get = oci.read_layout(root)
        manifests = _all_manifests(root, get)
    except oci.ArtifactRefused as e:
        raise HTTPException(422, str(e)) from e
    plugins = {d: m for d, m in manifests.items() if m.get("artifactType") == mt.artifact}
    if not plugins:
        raise HTTPException(422, "the layout has no plugin artifact")
    staged: list[tuple[PluginArtifact, dict[str, bytes]]] = []
    for md, doc in plugins.items():
        target = f"{(doc.get('annotations') or {}).get('org.opencontainers.image.title')}@{(doc.get('annotations') or {}).get('org.opencontainers.image.version')}"
        try:
            _, files, config = oci.unpack(get, md, mt)
            refs = {d: m for d, m in manifests.items() if (m.get("subject") or {}).get("digest") == md}
            sig_ref = next((d for d, m in refs.items() if m.get("artifactType") == mt.signature), None)
            att_ref = next((d for d, m in refs.items() if m.get("artifactType") == oci.IN_TOTO), None)
            if sig_ref is None:
                raise oci.ArtifactRefused("no signature referrer")
            sig = json.loads(oci.checked(get, refs[sig_ref]["layers"][0]["digest"], "signature"))
            if bad := store.check_signature(md, sig):
                raise oci.ArtifactRefused(bad)
        except oci.ArtifactRefused as e:
            store.audit_refusal(ctx, target, str(e), where="import", manifest_digest=md)
            raise HTTPException(409, {"message": f"{target} was refused: it failed verification", "reason": str(e)}) from e
        pid, version = canonical_id(str(config.get("id") or "")), str(config.get("version") or "")
        ann = doc.get("annotations") or {}
        if ann.get("org.opencontainers.image.title") != pid or ann.get("org.opencontainers.image.version") != version:
            raise HTTPException(422, f"{md}: annotations don't match its plugin.yaml")
        if any(not e.stored for e in catalog.versions(pid, db)):
            raise HTTPException(409, f"{pid} is a curated plugin of this installation; an import can't take its id")
        existing = catalog.get(pid, version, db)
        if existing is not None and existing.version == version:
            if existing.artifact_digest == digest.files_digest(files):
                continue  # already here, same bytes
            raise HTTPException(409, f"{pid}@{version} already exists here with different contents")
        blobs = {d: get(d) for d in _closure_digests(md, doc, refs)}
        row = PluginArtifact(
            plugin_id=pid,
            version=version,
            manifest_digest=md,
            artifact_digest=oci.tree_digest(files),
            trust_tier=tier,
            publisher=f"imported:{sig.get('keyId')}",
            workspace_id=ctx.workspace_id,
            org_id=catalog.org_of(db, ctx.workspace_id) if tier == "organisation" else None,
            manifest=config,
            signature=sig,
            referrers=sorted(refs),
            attestation_digest=att_ref,
            licenses={"code": config.get("license")},
            source="imported",
            created_by=ctx.principal,
        )
        staged.append((row, blobs))
    out = []
    for row, blobs in staged:
        store.put(blobs)
        try:  # the attestation is checked once its blobs are in the store
            store.verify(manifest_digest=row.manifest_digest, artifact_digest=row.artifact_digest, signature=row.signature, manifest=row.manifest, attestation_digest=row.attestation_digest)
        except oci.ArtifactRefused as e:
            store.audit_refusal(ctx, f"{row.plugin_id}@{row.version}", str(e), where="import", manifest_digest=row.manifest_digest)
            raise HTTPException(409, {"message": f"{row.plugin_id}@{row.version} was refused: it failed verification", "reason": str(e)}) from e
        db.add(row)
        audit.record(db, ctx, "plugins.import", target=f"{row.plugin_id}@{row.version}", after={"manifestDigest": row.manifest_digest, "tier": row.trust_tier, "signer": row.signature.get("keyId")})
        out.append({"pluginId": row.plugin_id, "version": row.version, "manifestDigest": row.manifest_digest, "artifactDigest": row.artifact_digest, "trustTier": row.trust_tier})
    db.flush()
    return out


def _closure_digests(md: str, doc: dict, refs: dict[str, dict]) -> list[str]:
    out = [md, doc["config"]["digest"], *(d["digest"] for d in doc.get("layers") or [])]
    for rd, r in refs.items():
        out += [rd, r["config"]["digest"], *(d["digest"] for d in r.get("layers") or [])]
    return out


def import_tar(db: Session, ctx: RequestContext, data: bytes, *, tier: str = "generated") -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="oci-import-") as d:
        _untar_layout(data, Path(d))
        return import_layout(db, ctx, Path(d), tier=tier)


# ---- promotion -----------------------------------------------------------------------------


def promotion_dict(p: PluginPromotion) -> dict:
    return {
        "id": p.id,
        "pluginId": p.plugin_id,
        "version": p.version,
        "manifestDigest": p.manifest_digest,
        "from": p.from_tier,
        "to": p.to_tier,
        "state": p.state,
        "requestedBy": p.requested_by,
        "reviewedBy": p.reviewed_by,
        "reason": p.reason,
        "at": p.created_at.isoformat(),
    }


def request_promotion(db: Session, ctx: RequestContext, plugin_id: str, version: str, reason: str = "") -> PluginPromotion:
    row = _row(db, plugin_id, version)
    if not catalog.visible(db, catalog.from_row(row), ctx.workspace_id):
        raise HTTPException(404, f"{plugin_id}@{version} isn't a stored artifact")
    to = NEXT.get(row.trust_tier)
    if to is None:
        raise HTTPException(409, f"{row.plugin_id}@{row.version} is already {row.trust_tier}")
    if to == "organisation" and catalog.org_of(db, row.workspace_id) is None:
        raise HTTPException(409, "the artifact's workspace belongs to no organisation")
    open_ = db.scalar(select(PluginPromotion).where(PluginPromotion.plugin_id == row.plugin_id, PluginPromotion.version == row.version, PluginPromotion.state == "requested"))
    if open_ is not None:
        return open_
    p = PluginPromotion(plugin_id=row.plugin_id, version=row.version, manifest_digest=row.manifest_digest, from_tier=row.trust_tier, to_tier=to, state="requested", requested_by=ctx.principal, reason=reason[:2000], workspace_id=ctx.workspace_id)
    db.add(p)
    db.flush()
    audit.record(db, ctx, "plugins.promotion.request", target=f"{row.plugin_id}@{row.version}", after={"id": p.id, "from": p.from_tier, "to": to})
    return p


def review_promotion(db: Session, ctx: RequestContext, promotion_id: int, approve: bool, reason: str = "") -> PluginPromotion:
    """A person's decision. The reviewer can't be the requester or the artifact's author."""
    if not ctx.allows("plugins.approve"):
        raise HTTPException(403, "this session can't review promotions")
    p = db.get(PluginPromotion, promotion_id)
    if p is None or p.workspace_id != ctx.workspace_id:
        raise HTTPException(404, "no such promotion request")
    if p.state != "requested":
        raise HTTPException(409, f"promotion is already {p.state}")
    row = _row(db, p.plugin_id, p.version)
    if ctx.principal in (p.requested_by, row.created_by):
        raise HTTPException(403, "a promotion needs a second person: the reviewer can't be its requester or the artifact's author")
    if row.manifest_digest != p.manifest_digest or row.trust_tier != p.from_tier:
        raise HTTPException(409, "the artifact changed since the request")
    p.state, p.reviewed_by, p.reviewed_at = ("approved" if approve else "rejected"), ctx.principal, datetime.now(UTC)
    if reason:
        p.reason = (p.reason + "\n" if p.reason else "") + f"review: {reason[:2000]}"
    if approve:
        _verify_row(row)  # re-verified at the moment it widens
        row.trust_tier = p.to_tier
        if p.to_tier == "organisation":
            row.org_id = catalog.org_of(db, row.workspace_id)
        row.promoted_by, row.promoted_at = ctx.principal, p.reviewed_at
    db.flush()
    audit.record(db, ctx, f"plugins.promotion.{p.state}", target=f"{p.plugin_id}@{p.version}", after={"id": p.id, "from": p.from_tier, "to": p.to_tier, "manifestDigest": p.manifest_digest})
    return p


def promotions(db: Session, ctx: RequestContext, state: str | None = None) -> list[dict]:
    q = select(PluginPromotion).where(PluginPromotion.workspace_id == ctx.workspace_id)
    if state:
        q = q.where(PluginPromotion.state == state)
    return [promotion_dict(p) for p in db.scalars(q.order_by(PluginPromotion.id.desc()).limit(200))]
