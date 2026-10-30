"""Registry catalog (docs/plugins.md §7.1): search and inspect plugin versions.

Sources: the curated `registry/index.json` (built by tools/build-registry.mjs from
plugins/*/plugin.yaml) plus the private store of generated artifacts (Phase 9, trust tier
`generated`). Studio built-ins (core, overlay2d, cornerstone, timeline) are listed as
`builtin`: always present, never installed, but dependencies can name them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..config import settings
from ..naming import canonical_id
from . import semver

TRUST_TIERS = ("builtin", "first-party", "vetted", "generated")


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

    def visible_to(self, workspace_id: str | None) -> bool:
        return self.workspace_id is None or workspace_id is None or self.workspace_id == workspace_id

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


@lru_cache(maxsize=4)
def _load(index_path: str, mtime: float, generated_path: str, gmtime: float) -> tuple[Entry, ...]:
    out: list[Entry] = []
    for p in (index_path, generated_path):
        f = Path(p)
        if f.is_file():
            out.extend(_from_index(e) for e in json.loads(f.read_text()).get("plugins", []))
    return tuple(out)


def entries() -> list[Entry]:
    idx = settings().registry_dir / "index.json"
    gen = settings().data_dir / "registry-generated.json"
    return list(_load(str(idx), idx.stat().st_mtime if idx.exists() else 0, str(gen), gen.stat().st_mtime if gen.exists() else 0))


def versions(plugin_id: str) -> list[Entry]:
    pid = canonical_id(plugin_id)
    return sorted((e for e in entries() if e.id == pid), key=lambda e: semver.key(e.version))


def get(plugin_id: str, version: str | None = None) -> Entry | None:
    vs = versions(plugin_id)
    if not vs:
        return None
    if version is None:
        return vs[-1]
    exact = [e for e in vs if e.version == version]
    if exact:
        return exact[0]
    best = semver.max_satisfying([e.version for e in vs], version)
    return next((e for e in vs if e.version == best), None)


def search(query: str | None = None, capability: str | None = None, media_type: str | None = None, workspace_id: str | None = None) -> list[dict]:
    latest: dict[str, Entry] = {}
    for e in entries():
        if e.trust_tier == "builtin" or not e.visible_to(workspace_id):
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
    """Where the staged package lives: plugins/<dir> for curated entries, the artifact store for generated."""
    if e.path is None:
        return None
    p = Path(e.path)
    return p if p.is_absolute() else settings().registry_dir.parent / p
