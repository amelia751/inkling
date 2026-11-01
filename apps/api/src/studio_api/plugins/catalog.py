"""Registry catalog (docs/plugins.md §7.1): search and inspect plugin versions.

Sources: the curated `registry/index.json` (built by tools/build-registry.mjs from
plugins/*/plugin.yaml) plus the `plugin_artifacts` table: signed, content-addressed
artifacts the kernel built or imported (todo10 Phase 3, 8), trust tier `generated`
(one workspace), `organisation` (every project of one organisation) or `curated` (all). Studio built-ins (core, overlay2d, cornerstone, timeline) are listed as
`builtin`: always present, never installed, but dependencies can name them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import PluginArtifact
from ..naming import canonical_id
from . import semver

TRUST_TIERS = ("builtin", "first-party", "vetted", "curated", "organisation", "generated")
# Tiers whose bytes live in the artifact store (store.py) rather than in plugins/.
STORED_TIERS = ("generated", "organisation", "curated")


@dataclass(frozen=True)
class Entry:
    id: str
    version: str
    publisher: str
    trust_tier: str
    artifact_digest: str
    manifest: dict
    path: str | None
    licenses: dict
    cost_hints: dict
    signature: dict | None = None
    # Generated plugins belong to the workspace that built them (§9); None = every workspace.
    workspace_id: str | None = None
    review: dict | None = None
    # Stored artifacts (todo10 Phase 3): the signed OCI manifest and its attestation.
    manifest_digest: str | None = None
    attestation_digest: str | None = None
    org_id: str | None = None
    referrers: tuple[str, ...] = ()
    stored: bool = False

    def visible_to(self, workspace_id: str | None, org_id: str | None = None) -> bool:
        if workspace_id is None or self.trust_tier == "curated":
            return True
        if self.trust_tier == "organisation":
            return self.org_id is not None and self.org_id == org_id
        return self.workspace_id is None or self.workspace_id == workspace_id

    @property
    def signer_id(self) -> str:
        """Who vouches for these bytes: the signing key id, or how a curated entry is trusted."""
        if self.signature and self.signature.get("keyId"):
            return str(self.signature["keyId"])
        return "image" if self.trust_tier in ("builtin", "first-party", "vetted") else "unsigned"

    @property
    def capabilities(self) -> list[dict]:
        return list(self.manifest.get("capabilities") or [])

    @property
    def runtime(self) -> str:
        return (self.manifest.get("runtime") or {}).get("kind", "none")

    def summary(self) -> dict:
        perms = self.manifest.get("permissions") or {}
        return {
            "id": self.id,
            "version": self.version,
            "name": self.manifest.get("name"),
            "description": self.manifest.get("description"),
            "publisher": self.publisher,
            "trustTier": self.trust_tier,
            "artifactDigest": self.artifact_digest,
            "runtime": self.runtime,
            "capabilities": [c["id"] for c in self.capabilities],
            "mediaTypes": sorted({t for c in self.capabilities for t in c.get("mediaTypes") or []}),
            "permissions": {"required": perms.get("required", []), "optional": perms.get("optional", [])},
            "providers": [p["id"] for p in self.manifest.get("providers") or []],
            "licenses": self.licenses,
            "costHints": self.cost_hints,
            "compatibility": self.manifest.get("compatibility"),
            "requires": self.manifest.get("requires") or {},
            **({"manifestDigest": self.manifest_digest, "signer": self.signer_id} if self.stored else {}),
        }


def _from_index(raw: dict) -> Entry:
    return Entry(
        id=canonical_id(raw["id"]),
        version=raw["version"],
        publisher=raw.get("publisher", ""),
        trust_tier=raw.get("trustTier", "vetted"),
        artifact_digest=raw.get("artifactDigest", ""),
        manifest=raw.get("manifest") or {},
        path=raw.get("path"),
        licenses=raw.get("licenses") or {},
        cost_hints=raw.get("costHints") or {},
        signature=raw.get("signature"),
        workspace_id=raw.get("workspaceId"),
        review=raw.get("review"),
    )


def from_row(r: PluginArtifact) -> Entry:
    return Entry(
        id=r.plugin_id,
        version=r.version,
        publisher=r.publisher,
        trust_tier=r.trust_tier,
        artifact_digest=r.artifact_digest,
        manifest=r.manifest or {},
        path=None,
        licenses=r.licenses or {},
        cost_hints={},
        signature=r.signature,
        workspace_id=r.workspace_id,
        review=r.review,
        manifest_digest=r.manifest_digest,
        attestation_digest=r.attestation_digest,
        org_id=r.org_id,
        referrers=tuple(r.referrers or ()),
        stored=True,
    )


@lru_cache(maxsize=4)
def _load(index_path: str, mtime: float) -> tuple[Entry, ...]:
    f = Path(index_path)
    return tuple(_from_index(e) for e in json.loads(f.read_text()).get("plugins", [])) if f.is_file() else ()


def _stored(db: Session | None, plugin_id: str | None = None) -> list[Entry]:
    def q(s: Session) -> list[Entry]:
        stmt = select(PluginArtifact)
        if plugin_id:
            stmt = stmt.where(PluginArtifact.plugin_id == plugin_id)
        return [from_row(r) for r in s.scalars(stmt)]

    if db is not None:
        return q(db)
    from .. import db as dbm

    with dbm.session_scope() as s:
        return q(s)


def entries(db: Session | None = None) -> list[Entry]:
    """Curated index entries plus stored artifacts. Pass the request's session when there is one."""
    idx = settings().registry_dir / "index.json"
    return [*_load(str(idx), idx.stat().st_mtime if idx.exists() else 0), *_stored(db)]


def versions(plugin_id: str, db: Session | None = None) -> list[Entry]:
    pid = canonical_id(plugin_id)
    idx = settings().registry_dir / "index.json"
    curated = [e for e in _load(str(idx), idx.stat().st_mtime if idx.exists() else 0) if e.id == pid]
    return sorted([*curated, *_stored(db, pid)], key=lambda e: semver.key(e.version))


def get(plugin_id: str, version: str | None = None, db: Session | None = None) -> Entry | None:
    vs = versions(plugin_id, db)
    if not vs:
        return None
    if version is None:
        return vs[-1]
    exact = [e for e in vs if e.version == version]
    if exact:
        return exact[0]
    best = semver.max_satisfying([e.version for e in vs], version)
    return next((e for e in vs if e.version == best), None)


def org_of(db: Session | None, workspace_id: str | None) -> str | None:
    """The organisation a workspace (project) belongs to, for the `organisation` tier."""
    if db is None or workspace_id is None:
        return None
    from ..models import ProjectRow

    return db.scalar(select(ProjectRow.org_id).where(ProjectRow.id == workspace_id))


def visible(db: Session | None, e: Entry, workspace_id: str | None) -> bool:
    return e.visible_to(workspace_id, org_of(db, workspace_id) if e.trust_tier == "organisation" else None)


def search(query: str | None = None, capability: str | None = None, media_type: str | None = None, workspace_id: str | None = None, db: Session | None = None) -> list[dict]:
    latest: dict[str, Entry] = {}
    org = org_of(db, workspace_id)
    for e in entries(db):
        if e.trust_tier == "builtin" or not e.visible_to(workspace_id, org):
            continue
        if e.id not in latest or semver.key(e.version) > semver.key(latest[e.id].version):
            latest[e.id] = e
    out = []
    q = (query or "").lower()
    for e in latest.values():
        s = e.summary()
        text = " ".join([e.id, s.get("name") or "", s.get("description") or "", *s["capabilities"]]).lower()
        if q and all(w not in text for w in q.split()):
            continue
        if capability and capability not in s["capabilities"]:
            continue
        if media_type and not any(t == media_type or (t.endswith("/*") and media_type.startswith(t[:-1])) for t in s["mediaTypes"]):
            continue
        out.append(s)
    return sorted(out, key=lambda s: s["id"])


def package_dir(e: Entry) -> Path | None:
    """plugins/<dir> for curated index entries; None for stored artifacts (use `load_files`)."""
    if e.path is None:
        return None
    p = Path(e.path)
    return p if p.is_absolute() else settings().registry_dir.parent / p


def load_files(e: Entry) -> dict[str, bytes]:
    """The package's files, verified on this load (todo10 Phase 3): stored artifacts from the
    manifest down plus signature; curated entries against their registry tree digest.
    Raises `oci.ArtifactRefused` with the reason."""
    from studio_signing import oci

    from . import digest, store

    if e.stored:
        return store.verify(manifest_digest=e.manifest_digest, artifact_digest=e.artifact_digest, signature=e.signature, manifest=e.manifest, attestation_digest=e.attestation_digest)
    d = package_dir(e)
    if d is None or not d.is_dir():
        raise oci.ArtifactRefused("package not found in the registry store")
    files = {p.relative_to(d).as_posix(): p.read_bytes() for p in digest.package_files(d)}
    got = digest.files_digest(files)
    if e.artifact_digest and got != e.artifact_digest:
        raise oci.ArtifactRefused(f"digest mismatch (registry {e.artifact_digest}, staged {got})")
    return files
