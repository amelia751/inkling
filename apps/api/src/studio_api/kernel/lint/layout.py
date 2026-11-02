"""Layout rules: layout.misplaced, layout.forbidden-char, layout.too-deep, name.pattern,
name.phi-suspect.

Input: `{"path": "folder/sub/file.ext"}` or `{"paths": [...]}`, plus optional `"folders": [...]`
(paths that are folders: placement and the file-name pattern don't apply to them). File names
may carry PHI, so violations on them never echo the value (D6).
"""

from __future__ import annotations

import fnmatch
import re
from collections.abc import Mapping
from typing import Any

from ..privacy_names import path_findings
from . import Violation, violation

GLOB = re.compile(r"[*?\[]")


def _paths(data: Mapping[str, Any]) -> list[tuple[str, str]]:
    if isinstance(data.get("path"), str):
        return [("/path", data["path"])]
    return [(f"/paths/{i}", p) for i, p in enumerate(data.get("paths") or ()) if isinstance(p, str)]


def folder_matches(folder: str, pattern: str) -> bool:
    """`images/**` covers `images` itself and everything below it."""
    return fnmatch.fnmatchcase(folder, pattern) or fnmatch.fnmatchcase(folder + "/", pattern) or (pattern.endswith("/**") and folder == pattern[:-3])


def suggested_folder(patterns: list[str]) -> str | None:
    """The concrete folder a pattern names (`images/**` -> `images`), for the fix text."""
    for pat in patterns:
        parts: list[str] = []
        for seg in pat.split("/"):
            if GLOB.search(seg):
                break
            parts.append(seg)
        if parts:
            return "/".join(parts)
    return None


def check(data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    layout = rules.get("layout") or {}
    folders = list(layout.get("folderPatterns") or [])
    name_re = layout.get("fileNamePattern")
    forbidden = layout.get("forbiddenCharacters") or ""
    max_depth = layout.get("maxDepth")
    dirs = set(data.get("folders") or ())
    out: list[Violation] = []
    for ptr, p in _paths(data):
        folder, _, name = p.rpartition("/")
        is_dir = p in dirs
        bad = sorted({c for c in p if c in forbidden})
        if bad:
            out.append(violation("layout.forbidden-char", ptr, "The path contains forbidden characters.", allowed={"forbidden": bad}, phi=True))
        if folders and not is_dir and not any(folder_matches(folder, pat) for pat in folders):
            to = suggested_folder(folders)
            fix = f"Move it into '{to}/' (or another folder matching {', '.join(folders)})." if to else None
            out.append(violation("layout.misplaced", ptr, "The file is not under one of the project's folders.", allowed=folders, phi=True, **({"fix": fix} if fix else {}), extra={"suggestedFolder": to} if to else {}))
        if max_depth is not None and p.count("/") > int(max_depth):
            out.append(violation("layout.too-deep", ptr, f"The path is deeper than {max_depth} folders.", allowed={"maxDepth": max_depth}, phi=True))
        if name_re and not is_dir and not re.fullmatch(name_re, name):
            out.append(violation("name.pattern", ptr, "The file name does not match the project's pattern.", allowed={"pattern": name_re}, phi=True))
        reasons = path_findings(p)
        if reasons:
            # The reasons say what kind of value it looks like, never the value itself.
            out.append(violation("name.phi-suspect", ptr, "The path may identify a person: " + "; ".join(reasons) + ".", phi=True))
    return out
