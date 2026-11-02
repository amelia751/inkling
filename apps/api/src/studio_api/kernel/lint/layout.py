"""Layout rules: layout.misplaced, layout.forbidden-char, layout.too-deep, name.pattern.

Input: `{"path": "folder/sub/file.ext"}` or `{"paths": [...]}`. File names may carry PHI, so
violations on them never echo the value (D6).
"""

from __future__ import annotations

import fnmatch
import re
from collections.abc import Mapping
from typing import Any

from . import Violation, violation


def _paths(data: Mapping[str, Any]) -> list[tuple[str, str]]:
    if isinstance(data.get("path"), str):
        return [("/path", data["path"])]
    return [(f"/paths/{i}", p) for i, p in enumerate(data.get("paths") or ()) if isinstance(p, str)]


def check(data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    layout = rules.get("layout") or {}
    if not layout:
        return []
    folders = layout.get("folderPatterns") or []
    name_re = layout.get("fileNamePattern")
    forbidden = layout.get("forbiddenCharacters") or ""
    max_depth = layout.get("maxDepth")
    out: list[Violation] = []
    for ptr, p in _paths(data):
        folder, _, name = p.rpartition("/")
        bad = sorted({c for c in p if c in forbidden})
        if bad:
            out.append(violation("layout.forbidden-char", ptr, "The path contains forbidden characters.", allowed={"forbidden": bad}, phi=True))
        if folders and not any(fnmatch.fnmatchcase(folder, pat) for pat in folders):
            out.append(violation("layout.misplaced", ptr, "The file is not under one of the project's folders.", allowed=list(folders), phi=True))
        if max_depth is not None and p.count("/") > int(max_depth):
            out.append(violation("layout.too-deep", ptr, f"The path is deeper than {max_depth} folders.", allowed={"maxDepth": max_depth}, phi=True))
        if name_re and not re.fullmatch(name_re, name):
            out.append(violation("name.pattern", ptr, "The file name does not match the project's pattern.", allowed={"pattern": name_re}, phi=True))
    return out
