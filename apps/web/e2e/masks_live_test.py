"""Masks land live (todo25 W5): a segmentation batch over 12 chest X-rays, with the mock provider.

    STUDIO_E2E=1 pnpm exec vite --port 5341 --strictPort      # in apps/web
    python3 e2e/masks_live_test.py --port 5341

The Studio is open on 12 images; a job per image finishes one after another (the mock provider's
"lungs" recipe: a "right lung" and a "left lung" mask, `ai-suggested`, review pending). Each job
commits to the Studio's annotation document and the kernel announces it on the project stream
(`annotations.committed`); the test plays both halves: the annotations GET answers with what has
been committed so far, and the event goes through the page's project-event bus, the same path
the SSE stream takes. Then, with no reload: the masks appear, the item list marks the images
with suggestions waiting, the Masks panel shows "right lung" / "left lung", two images are
accepted (key, button), one rejected (key), and the COCO export holds only the accepted masks.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from PIL import Image  # noqa: E402

from harness import NAMING, REPO, launch, open_studio, parse_args, sync_playwright  # noqa: E402

DATASET = "2d-xray"
N = 12
EVENTS = "/src/studio/lib/use-project-events.ts"
COCO = f"{NAMING['namespace']}.image2d.exporters.coco"
# The `lungs` recipe's relative boxes (todo25 D2): right half and left half of the thorax.
BOXES = {"right lung": (0.15, 0.13, 0.48, 0.85), "left lung": (0.52, 0.13, 0.85, 0.85)}


def items() -> list[str]:
    manifest = json.loads((REPO / "seed-data" / "manifest.json").read_text())
    project = next(p for p in manifest["projects"] if p["id"] == DATASET)
    return [a["path"] for a in project["assets"]][:N]


def box_mask(w: int, h: int, rel: tuple[float, float, float, float]) -> dict:
    """A row-major RLE mask (counts alternate background / foreground) filling a relative box."""
    x0, y0, x1, y1 = int(rel[0] * w), int(rel[1] * h), int(rel[2] * w), int(rel[3] * h)
    counts, at = [], 0
    for y in range(y0, y1):
        start = y * w + x0
        counts += [start - at, x1 - x0]
        at = start + (x1 - x0)
    counts.append(w * h - at)
    return {"type": "mask", "dims": [w, h], "counts": counts, "voxels": (x1 - x0) * (y1 - y0)}


def job_result(item_id: str, n: int) -> list[dict]:
    w, h = Image.open(REPO / "seed-data" / item_id).size
    return [
        {
            "id": f"job-{n}-{label.split()[0]}",
            "itemId": item_id,
            "label": label,
            "geometry": box_mask(w, h, rel),
            "provenance": "ai-suggested",
            "author": "plugin:studio.segmentation@0.1.0",
            "createdAt": "2026-11-04T00:00:00Z",
            "attributes": {"provider": "mock", "model": "mock-sam", "recipe": "lungs", "confidence": 0.87, "review_status": "pending"},
        }
        for label, rel in BOXES.items()
    ]


def workspace_with_segmentation(port: int) -> dict:
    """The dev workspace's active plugins plus `studio.segmentation` (preinstalled in new projects, todo25 W3)."""
    with urllib.request.urlopen(f"http://localhost:{port}/api/v1/workspaces/{DATASET}/state") as r:
        state = json.load(r)
    plugin = (REPO / "plugins" / "segmentation" / "plugin.yaml").read_text()
    version = next(line.split(":", 1)[1].strip().strip('"') for line in plugin.splitlines() if line.startswith("version:"))
    state["plugins"].append({"pluginId": f"{NAMING['namespace']}.segmentation", "version": version, "state": "ACTIVATED"})
    return state


PAGES: list = []


def wait_for(fn, what: str, timeout: float = 20) -> None:
    """Poll `fn`; waits through Playwright (not time.sleep) so route handlers (saves) keep running."""
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return
        PAGES[0].wait_for_timeout(200) if PAGES else time.sleep(0.2)
    raise AssertionError(f"timed out: {what}")


def main() -> int:
    args = parse_args()
    ids = items()
    committed: list[dict] = []  # the server's document: grows as jobs finish
    failures: list[str] = []

    def check(ok: bool, what: str) -> None:
        print(("PASS " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        st = open_studio(browser, args.port, DATASET, fixture_annotations=committed, workspace_state=workspace_with_segmentation(args.port))
        page = st.page
        PAGES.append(page)
        wait_for(lambda: st.store("s => s.projectId") == DATASET, "Studio loaded", 90)
        check(st.store("s => s.annotations.length") == 0, "the Studio opens with no masks")

        # One job per image; each commits two masks and the kernel announces it.
        for n, item_id in enumerate(ids):
            committed.extend(job_result(item_id, n))
            page.evaluate(f"async () => (await import('{EVENTS}')).emitProjectEvent('annotations.committed', {{ jobId: 'job-{n}' }}, {json.dumps(DATASET)})")
            time.sleep(0.05)
        wait_for(lambda: st.store("s => s.annotations.filter(a => a.geometry.type === 'mask').length") == 2 * N, "24 masks in the open Studio")
        check(True, f"{N} jobs: {2 * N} masks landed without a reload")
        check(st.store("s => s.dirty") is False, "landed masks don't make the Studio dirty (already saved)")
        check(page.url.endswith(f"/studio/{DATASET}"), "no navigation happened")

        wait_for(lambda: page.locator('[data-testid="item-suggestions-pending"]').count() >= N, "item list marks images with suggestions waiting")
        check(page.locator('[data-testid="item-suggestions-pending"]').count() == N, f"item list: {N} images with suggestions waiting")

        def open_item(i: int) -> None:
            st.act(f"s => s.setItemIndex({i})")
            wait_for(lambda: page.locator('[data-testid="mask-row"]').count() == 2 and page.locator('[data-testid="mask-review"]').is_visible(), f"Masks panel for image {i}")

        def reviews(i: int) -> list[str]:
            return st.store(f"s => s.annotations.filter(a => a.itemId === {json.dumps(ids[i])}).map(a => a.attributes.review_status)")

        def press(key: str) -> None:
            page.keyboard.press(key)

        open_item(0)
        labels = sorted(page.locator('[data-testid="mask-label"]').all_inner_texts())
        check(labels == ["left lung", "right lung"], f"Masks panel shows the labels: {labels}")
        press("Shift+A")
        wait_for(lambda: reviews(0) == ["accepted", "accepted"], "image 1 accepted with shift+a")
        check(True, "image 1: both masks accepted with the key")

        open_item(1)
        page.get_by_test_id("mask-accept-item").click()
        wait_for(lambda: reviews(1) == ["accepted", "accepted"], "image 2 accepted with the button")
        check(True, "image 2: both masks accepted with Accept")

        open_item(2)
        press("Shift+X")
        wait_for(lambda: reviews(2) == ["rejected", "rejected"], "image 3 rejected with shift+x")
        hidden = st.store(f"s => s.annotations.filter(a => a.itemId === {json.dumps(ids[2])}).every(a => a.hidden)")
        check(hidden, "image 3: both masks rejected with the key and hidden, not deleted")

        wait_for(lambda: page.locator('[data-testid="item-suggestions-pending"]').count() == N - 3, "item list updates")
        check(True, f"item list: {N - 3} images still have suggestions waiting")

        b64 = page.evaluate(
            f"""async () => {{
              const {{ registry }} = await import('/src/extension-host/registry.ts');
              const {{ projectItems }} = await import('/src/studio/lib/items.ts');
              const api = await import('/src/studio/lib/api.ts');
              const s = (await import('/src/studio/stores/studio.ts')).useStudio.getState();
              const project = (await api.fetchProjects()).find(p => p.id === s.projectId);
              const exporter = await registry.loadImpl({json.dumps(COCO)});
              const blob = await exporter.build({{ project, items: projectItems(project), annotations: s.annotations }});
              return await blob.text();
            }}"""
        )
        coco = json.loads(b64)
        cats = {c["id"]: c["name"] for c in coco["categories"]}
        anns = [a for a in coco["annotations"] if isinstance(a.get("segmentation"), dict)]
        exported = sorted(a[f"{NAMING['resourcePrefix']}_id"] for a in anns)
        want = sorted(a["id"] for a in committed if a["itemId"] in ids[:2])
        check(exported == want, f"COCO export holds only the 4 accepted masks: {exported}")
        check(sorted(cats[a["category_id"]] for a in anns) == ["left lung", "left lung", "right lung", "right lung"], "COCO categories are the mask labels")

        # Reviews are saved (autosave PUTs carry the review state, never a deletion).
        wait_for(lambda: bool(st.saves) and len(st.saves[-1]["annotations"]) == 2 * N, "review saved", 30)
        saved = {a["id"]: a["attributes"]["review_status"] for a in st.saves[-1]["annotations"]}
        check(sorted(saved.values()).count("accepted") == 4 and sorted(saved.values()).count("rejected") == 2, "the save carries 4 accepted and 2 rejected, nothing deleted")

        errors = [e for e in st.errors if "favicon" not in e]
        check(not errors, f"no page errors: {errors[:3]}")
        browser.close()

    print(f"\n{'FAILED' if failures else 'OK'}: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
