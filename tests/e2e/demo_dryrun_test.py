"""Demo dry run on a deployed stack (todo24 W8, todo25 W6): the demo's beats, timed against their
budgets, on staging or any running stack.

Beats that spend real money run only with <envPrefix>E2E_SPEND=1. Today that is the segmentation
beat (todo25 §3, 3b–3c): in a ready chest X-ray Studio (todo24 beat 1), type "Segment the lungs on
these"; all 12 images must have masks within 30 s of Send (Meta's SAM 3.1, about $0.03 per run);
then the masks on two images are accepted.

    STUDIO_E2E_DEMO_URL=https://staging.example \\
    STUDIO_E2E_DEMO_PROJECT=<project id> STUDIO_E2E_DEMO_STUDIO=<studio path, e.g. /p/<id>/studio/<id>> \\
    STUDIO_E2E_DEMO_TOKEN=<a person token for the api> \\
    [STUDIO_E2E_DEMO_STORAGE=<playwright storage state with a signed-in session>] \\
    STUDIO_E2E_SPEND=1 python3 tests/e2e/demo_dryrun_test.py [--headed]

Without STUDIO_E2E_SPEND=1 the segmentation beat is reported as skipped and nothing is sent to
Meta. The masks are counted through the kernel's annotation API (provenance `ai-suggested`,
labels "right lung" / "left lung"), not by reading pixels.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
from harness import NAMING, sync_playwright  # noqa: E402

P = NAMING["envPrefix"]
AI = f"{NAMING['displayName']} AI"
BASE = os.environ.get(f"{P}E2E_DEMO_URL", "").rstrip("/")
PROJECT = os.environ.get(f"{P}E2E_DEMO_PROJECT", "")
STUDIO = os.environ.get(f"{P}E2E_DEMO_STUDIO", "")
TOKEN = os.environ.get(f"{P}E2E_DEMO_TOKEN", "")
STORAGE = os.environ.get(f"{P}E2E_DEMO_STORAGE") or None
SPEND = os.environ.get(f"{P}E2E_SPEND") == "1"

SEGMENT_PROMPT = "Segment the lungs on these"
SEGMENT_IMAGES = 12
SEGMENT_BUDGET_S = 30.0
LUNG_LABELS = {"right lung", "left lung"}

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)
    return ok


def skip(name: str, why: str) -> None:
    print(f"SKIP {name} — {why}", flush=True)


def timing(moment: str, seconds: float | None, budget: float) -> None:
    shown = "n/a" if seconds is None else f"{seconds:.1f} s"
    print(f"TIME {moment}: {shown} (budget {budget:.0f} s)", flush=True)


def call(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}", "X-Workspace-Id": PROJECT, **({"Content-Type": "application/json"} if body is not None else {})}
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read()
        return json.loads(text) if text else None


def lung_masks() -> dict[str, list[dict]]:
    """AI-suggested lung masks by item id."""
    anns = call("GET", "/api/v1/annotations?limit=5000")["annotations"]
    by_item: dict[str, list[dict]] = {}
    for a in anns:
        if a.get("provenance") == "ai-suggested" and a.get("label") in LUNG_LABELS and (a.get("geometry") or {}).get("type") == "mask":
            by_item.setdefault(str(a.get("itemId")), []).append(a)
    return by_item


def open_assistant(page) -> None:
    consent = page.get_by_role("button", name="Turn on for this browser")
    box = page.get_by_label(f"Message {AI}")
    try:
        consent.or_(box).first.wait_for(timeout=4000)
    except Exception:  # noqa: BLE001 — closed: open it
        page.get_by_label(f"{AI} panel").click()
    end = time.time() + 30
    while time.time() < end:
        if box.count() and box.first.is_visible():
            return
        if consent.count() and consent.first.is_visible():
            try:
                consent.first.click(timeout=3000)
            except Exception:  # noqa: BLE001 — animating: try again
                pass
        page.wait_for_timeout(250)
    box.first.wait_for(timeout=1000)


def beat_segment(page) -> None:
    """todo25 §3 3b–3c: 12 images get lung masks in ≤ 30 s from Send; accept two images' masks."""
    before = {k: len(v) for k, v in lung_masks().items()}
    page.goto(BASE + STUDIO)
    open_assistant(page)
    box = page.get_by_label(f"Message {AI}")
    box.fill(SEGMENT_PROMPT)
    sent = time.time()
    box.press("Enter")

    # todo25 §5: the chat states the batch (images, Meta's SAM 3.1, cost) and runs it; no approval card.
    done_at = None
    masks: dict[str, list[dict]] = {}
    while time.time() - sent < SEGMENT_BUDGET_S * 3:
        masks = {k: v for k, v in lung_masks().items() if len(v) > before.get(k, 0)}
        if len(masks) >= SEGMENT_IMAGES:
            done_at = time.time() - sent
            break
        time.sleep(0.5)
    timing("Send → 12 images with lung masks", done_at, SEGMENT_BUDGET_S)
    check(f"segment: {SEGMENT_IMAGES} images have masks", len(masks) >= SEGMENT_IMAGES, f"{len(masks)} images")
    check(f"segment: within {SEGMENT_BUDGET_S:.0f} s", done_at is not None and done_at <= SEGMENT_BUDGET_S, f"{done_at:.1f} s" if done_at else "timed out")
    check("segment: no approval card on screen", page.get_by_test_id("agent-approval").count() == 0)
    labels = {a["label"] for v in masks.values() for a in v}
    check("segment: masks are labelled right lung and left lung", labels == LUNG_LABELS, str(sorted(labels)))
    check("segment: every mask is a pending suggestion from meta.sam", all((a.get("attributes") or {}).get("review_status") == "pending" and (a.get("attributes") or {}).get("provider") == "meta.sam" for v in masks.values() for a in v))

    # The chat ends with the job summary and points to the Masks panel; no raw error on screen.
    log = page.get_by_test_id("agent-log")
    try:
        page.wait_for_function("() => /Masks panel/.test(document.querySelector('[data-testid=agent-log]')?.innerText || '')", timeout=30000)
    except Exception:  # noqa: BLE001 — reported below
        pass
    text = log.inner_text() if log.count() else ""
    check("segment: the chat summarizes the run and links to the Masks panel", "Masks panel" in text and "$" in text, text[-200:])
    check("segment: no raw error in the chat", "Traceback" not in text and "Error:" not in text)

    # 3c: accept the masks on two images (the person's own review call, as the panel makes it).
    for item in sorted(masks)[:2]:
        for a in masks[item]:
            call("POST", f"/api/v1/annotations/{a['id']}/review", {"status": "accepted"})
    accepted = [a for item in sorted(masks)[:2] for a in lung_masks().get(item, []) if (a.get("attributes") or {}).get("review_status") == "accepted"]
    check("segment: masks on two images accepted", len(accepted) >= 4, f"{len(accepted)} masks")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    missing = [n for n, v in (("DEMO_URL", BASE), ("DEMO_PROJECT", PROJECT), ("DEMO_STUDIO", STUDIO), ("DEMO_TOKEN", TOKEN)) if not v]
    if missing:
        print("set " + ", ".join(f"{P}E2E_{m}" for m in missing), file=sys.stderr)
        return 2
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(storage_state=STORAGE, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        try:
            if SPEND:
                beat_segment(page)
            else:
                skip("segment the lungs (todo25 §3)", f"spends real money (about $0.03); set {P}E2E_SPEND=1")
        finally:
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
