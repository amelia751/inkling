"""Dataset rules: dataset.metadata-missing, dataset.name-taken, dataset.mixed-modality.

Input: `{"dataset": {"name": str, "metadata": {...}, "modalities": [...]}, "existingNames": [...]}`.
`existingNames` is filled by the operation (an injectable lookup) before validation. Dataset names
may carry PHI, so they are never echoed.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping
from typing import Any

from . import Violation, violation


def _k(s: str) -> str:
    return unicodedata.normalize("NFC", s).strip().casefold()


def check(data: Mapping[str, Any], rules: Mapping[str, Any]) -> list[Violation]:
    ds = data.get("dataset")
    if not isinstance(ds, Mapping):
        return []
    conf = rules.get("datasets") or {}
    out: list[Violation] = []
    meta = ds.get("metadata") or {}
    missing = [k for k in conf.get("requiredMetadata") or () if meta.get(k) in (None, "", [])]
    for k in missing:
        out.append(violation("dataset.metadata-missing", f"/dataset/metadata/{k}", f"The dataset needs '{k}'.", allowed={"required": list(conf["requiredMetadata"])}))
    name = ds.get("name")
    if conf.get("uniqueNames", True) and isinstance(name, str):
        if _k(name) in {_k(n) for n in data.get("existingNames") or ()}:
            out.append(violation("dataset.name-taken", "/dataset/name", "A dataset with this name already exists in the project.", phi=True))
    mods = sorted(set(ds.get("modalities") or ()))
    if conf.get("oneModalityPerDataset", conf.get("oneModality")) and len(mods) > 1:
        out.append(violation("dataset.mixed-modality", "/dataset/modalities", "The dataset holds more than one modality.", value=mods))
    return out
