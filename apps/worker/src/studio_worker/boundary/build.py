"""`build_plugin`: rebuild the agent's plugin from its source, inside our boundary (todo10 §6.1 step 6).

Only *source* crosses back from the build sandbox. Here we keep the source files (by extension
and content: text, not binary), drop anything that looks built (wheels, `dist/`, `.pyc`,
shared objects) or isn't source, syntax-check the Python without running it, and write a
canonical tarball: sorted entries, zero mtimes and owners, fixed modes, so the same source
always gives the same bytes. Its digest (the registry's file-tree digest) is signed with the
platform key through `studio_signing`. That bundle is the one the kernel registers; whatever
the sandbox built is at most compared against it.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import posixpath
import sys
import tarfile

BUILDER = "canonical-source-v1"
SOURCE_EXT = {".py", ".pyi", ".yaml", ".yml", ".json", ".toml", ".lock", ".md", ".txt", ".cfg", ".ini", ".csv", ".typed"}
SOURCE_NAMES = {"LICENSE", "LICENCE", "NOTICE", "README", "uv.lock", "py.typed", ".python-version"}
BUILD_DIRS = {"fixtures", "dist", "build", "__pycache__", ".venv", "node_modules", ".pytest_cache", ".ruff_cache", ".data", ".schemas", ".mypy_cache"}
BUILD_EXT = {".whl", ".pyc", ".pyo", ".so", ".dylib", ".dll", ".egg", ".tar", ".tgz", ".gz", ".zip", ".o", ".a"}
EXCLUDE_DIGEST = {"node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".data"}
MAX_FILE = 1024 * 1024
MAX_FILES = 400


def unpack(data: bytes) -> dict[str, bytes]:
    """Regular files with safe relative paths; links, devices and traversal are refused."""
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
        for m in tf.getmembers():
            name = m.name[2:] if m.name.startswith("./") else m.name
            if m.isdir() or not name or name == ".":
                continue
            parts = name.split("/")
            if not m.isreg() or name.startswith("/") or ".." in parts or "" in parts:
                raise ValueError("unsafe archive member")
            f = tf.extractfile(m)
            files[name] = f.read(MAX_FILE + 1) if f else b""
            if len(files) > MAX_FILES * 4:
                raise ValueError("too many files")
    return files


def files_digest(files: dict[str, bytes]) -> str:
    """Same algorithm as the kernel's `plugins/digest.py` and tools/build-registry.mjs."""
    h = hashlib.sha256()
    for rel in sorted(files):
        if any(p in EXCLUDE_DIGEST for p in rel.split("/")):
            continue
        h.update(f"{rel}\0{hashlib.sha256(files[rel]).hexdigest()}\n".encode())
    return f"sha256:{h.hexdigest()}"


def _reason(path: str, data: bytes) -> str | None:
    parts = path.split("/")
    base = parts[-1]
    ext = posixpath.splitext(base)[1].lower()
    if any(p in BUILD_DIRS or p.endswith(".egg-info") or p.endswith(".dist-info") for p in parts[:-1]) or ext in BUILD_EXT:
        return "build-output"
    if len(data) > MAX_FILE:
        return "too-large"
    if b"\x00" in data:
        return "binary"
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return "binary"
    if ext not in SOURCE_EXT and base not in SOURCE_NAMES:
        return "not-source"
    return None


def canonical_tar(files: dict[str, bytes]) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tf:
        for rel in sorted(files):
            info = tarfile.TarInfo(rel)
            info.size, info.mtime, info.mode, info.uid, info.gid, info.uname, info.gname = len(files[rel]), 0, 0o644, 0, 0, "", ""
            tf.addfile(info, io.BytesIO(files[rel]))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0, compresslevel=9) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def rebuild(source: bytes) -> tuple[dict[str, bytes], list[dict], list[str]]:
    """(kept files, dropped [{path, reason}], errors about the agent's own source)."""
    files = unpack(source)
    kept, dropped, errors = {}, [], []
    for path, data in sorted(files.items()):
        why = _reason(path, data)
        if why:
            dropped.append({"path": path if _safe(path) else "unnamed", "reason": why})
            continue
        if path.endswith(".py"):
            try:
                compile(data, path, "exec", dont_inherit=True)  # parse only; never executed
            except SyntaxError as e:
                errors.append(f"{path}: syntax error at line {e.lineno}")
        kept[path] = data
    if "plugin.yaml" not in kept:
        errors.append("the source has no plugin.yaml at its root")
    if len(kept) > MAX_FILES:
        errors.append(f"more than {MAX_FILES} source files")
    return kept, dropped[:100], errors


def _safe(p: str) -> bool:
    import re

    return bool(re.fullmatch(r"(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*", p)) and len(p) <= 200


def toolchain() -> dict:
    v = sys.version_info
    return {"python": f"{v.major}.{v.minor}.{v.micro}", "builder": BUILDER}
