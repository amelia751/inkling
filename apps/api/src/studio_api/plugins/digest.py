"""Deterministic package digests (same algorithm as scripts/build-registry.mjs).

sha256 over the sorted list of `<posix path>\\0<sha256 of file>\\n` for every file in the
package, excluding caches and local environments. A file-tree digest rather than a tarball
hash, so tar metadata (mtimes, owners) can't change it.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

EXCLUDE_DIRS = {"node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".data"}


def package_files(root: Path) -> list[Path]:
    out = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        if any(part in EXCLUDE_DIRS for part in rel.parts) or not p.is_file():
            continue
        out.append(p)
    return sorted(out, key=lambda p: p.relative_to(root).as_posix())


def tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in package_files(root):
        h.update(f"{p.relative_to(root).as_posix()}\0{hashlib.sha256(p.read_bytes()).hexdigest()}\n".encode())
    return f"sha256:{h.hexdigest()}"


def files_digest(files: dict[str, bytes]) -> str:
    """The same digest over an in-memory package (artifact tarballs)."""
    h = hashlib.sha256()
    for rel in sorted(files):
        if any(part in EXCLUDE_DIRS for part in rel.split("/")):
            continue
        h.update(f"{rel}\0{hashlib.sha256(files[rel]).hexdigest()}\n".encode())
    return f"sha256:{h.hexdigest()}"
