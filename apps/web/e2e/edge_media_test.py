"""todo18 W2 edge media e2e (skeleton; not run in CI yet).

Uploads local sample files from ~/Downloads/spurby-sample-data (never committed, never sent to
the model) through the kernel's import API and checks what a person sees in the Studio:

* .avi → item shows "Converting video", then plays an H.264 MP4 derivative (P0-2);
* .svs → "Preparing slide (n %)", then the DZI viewer with µm/px (P0-3);
* WFDB .hea + .dat pair → one record; lone .dat → "Needs its pair" (D5);
* BraTS folder → four sequences + reference seg, not five grey sequences;
* ACDC folder with Info.cfg → ED/ES frames in the cine viewer.

Usage: python3 e2e/edge_media_test.py --port 5199
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SAMPLES = Path.home() / "Downloads" / "spurby-sample-data"
CASES = [
    ("video-avi", "*.avi", "Converting video"),
    ("slide-svs", "*.svs", "Preparing slide"),
    ("wfdb-lone-dat", "*.dat", "Needs its pair"),
    ("brats", "*_seg.nii.gz", "seg"),
    ("acdc", "Info.cfg", "ED"),
]


def find(pattern: str) -> Path | None:
    return next(iter(sorted(SAMPLES.rglob(pattern))), None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5199)
    args = ap.parse_args()
    if not SAMPLES.is_dir():
        print(f"skip: {SAMPLES} not found")
        return 0
    from playwright.sync_api import sync_playwright  # noqa: F401 — TODO: drive the Studio

    base = f"http://127.0.0.1:{args.port}"
    for name, pattern, expect in CASES:
        src = find(pattern)
        if not src:
            print(f"skip {name}: no {pattern}")
            continue
        # TODO(todo18 W2): POST {base}/api/v1/projects/<p>/imports with src, wait for the drop,
        # open the item in the Studio, assert `expect` text is visible, then the ready state.
        print(f"todo {name}: {src.name} → expect {expect!r} at {base}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
