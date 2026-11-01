"""Datasets, todo13 Milestone 3 (docs/datasets.md §14 Phase 1, §15), in seed mode.

- The landing page reads one summary per dataset, not a profile per card (§15 criterion 11),
  says what each dataset holds at a stated level (criterion 2) and lists what needs attention
  (here: the sample's inferred collection to confirm), linking to Structure.
- With no datasets it shows the §3.1 empty state (`datasets-empty`, old `no-datasets` too) with
  Drop files, Ask the assistant and Create dataset; Ask opens the assistant.
- A dataset's Add data opens the assistant scoped to the dataset.
- Structure: Confirm suggested collections; the seed server can't store a structure and says so.
- History without versioning shows the working draft's changes in words.
- Viewers see "View only" and no write actions; no access and server errors show their states.
- Keyboard (criterion 18): the dataset's sections are reachable and openable from the keyboard.
- Opened datasets come back under "Continue working".

    python3 e2e/datasets_landing_test.py --port 5199 [--out DIR]   # screenshots in DIR/datasets/
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


def fulfill(route, body, status: int = 200) -> None:
    route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    shots = Path(args.out) / "datasets"
    shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        errors: list[str] = []

        def fresh(width: int = 1440, height: int = 900):
            ctx = browser.new_context(viewport={"width": width, "height": height})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            return ctx, page

        # ---- Landing: one summaries request, attention, card ----
        ctx, page = fresh()
        requests: list[str] = []
        page.on("request", lambda r: requests.append(r.url))
        page.goto(f"{base}/projects/{P}/datasets")
        card = page.locator(f"[data-testid=dataset-card][data-dataset-id='{P}']")
        card.get_by_test_id("dataset-content").wait_for(timeout=20000)
        check("the landing reads summaries, not a profile per card", any("/dataset-summaries" in u for u in requests) and not any(u.endswith("/profile") for u in requests), str([u for u in requests if "/api/v1/" in u]))
        check("the card names what it holds, at a stated level", "images" in card.get_by_test_id("dataset-content").inner_text())
        check("the card says how much structure is still suggested", "to confirm" in card.get_by_test_id("dataset-structure-line").inner_text(), card.get_by_test_id("dataset-structure-line").inner_text())
        att = page.get_by_test_id("datasets-attention")
        att.wait_for(timeout=10000)
        item = att.locator("[data-testid=attention-item][data-kind=suggestion]").first
        check("Needs attention lists the collection to confirm", "to confirm" in item.inner_text(), item.inner_text())
        page.screenshot(path=str(shots / "landing.png"), full_page=True)
        item.click()
        page.wait_for_url(f"**/datasets/{P}/structure", timeout=10000)
        check("the attention row opens the dataset's Structure", True)

        # ---- Structure: confirm (the seed server can't store a structure) ----
        confirm = page.get_by_test_id("confirm-all-collections")
        confirm.wait_for(timeout=10000)
        page.screenshot(path=str(shots / "structure.png"), full_page=True)
        confirm.click()
        toast = page.get_by_text("needs the dataset structure service").first
        toast.wait_for(timeout=5000)
        check("confirming without a structure service says why, nothing silently changes", page.locator("[data-testid=structure-collection] [data-testid=suggested]").count() >= 1)

        # ---- Keyboard: the dataset's sections (criterion 18) ----
        tabs = page.get_by_test_id("dataset-tabs").get_by_role("link")
        tabs.first.focus()
        for _ in range(4):
            page.keyboard.press("Tab")
        focused = page.evaluate("() => document.activeElement && document.activeElement.textContent")
        page.keyboard.press("Enter")
        page.wait_for_url(f"**/datasets/{P}/quality", timeout=5000)
        check("Tab reaches Quality and Enter opens it", focused.startswith("Quality"), str(focused))
        page.get_by_test_id("quality-clean").wait_for(timeout=10000)
        page.screenshot(path=str(shots / "quality.png"), full_page=True)

        # ---- History without versioning ----
        page.get_by_test_id("dataset-tabs").get_by_role("link", name="History").click()
        page.get_by_test_id("history-activity").wait_for(timeout=10000)
        check("History says only the working draft exists without versioning", page.get_by_test_id("history-versioning-off").count() == 1)
        page.locator("[data-testid=history-entry]").first.wait_for(timeout=10000)
        check("History lists changes in words", "added the sample" in page.locator("[data-testid=history-entry]").first.inner_text())
        page.screenshot(path=str(shots / "history.png"), full_page=True)

        # ---- Add data: the assistant, scoped to the dataset ----
        page.get_by_test_id("dataset-tabs").get_by_role("link", name="Overview").click()
        page.get_by_test_id("dataset-overview").wait_for(timeout=10000)
        page.get_by_test_id("dataset-add-data").click()
        drawer = page.get_by_test_id("agent-drawer")
        drawer.wait_for(timeout=5000)
        state = page.evaluate(
            """async () => {
                const ctx = await import('/src/studio/lib/agent/providers.ts');
                const add = await import('/src/studio/core/datasets/add-data.ts');
                return { label: ctx.useAgentContextStore.getState().provider?.label, scope: add.useComposerScope.getState().scope };
            }"""
        )
        check("Add data opens the assistant with this dataset as its context", state["label"] == "Datasets › Chest X-ray · Pneumonia", str(state["label"]))
        check("the composer's scope is the dataset (a drop skips 'which dataset')", (state["scope"] or {}).get("datasetId") == P and state["scope"]["intent"] == "drop", str(state["scope"]))
        page.screenshot(path=str(shots / "add-data.png"), full_page=True)
        page.get_by_test_id("assistant-toggle").click()

        # ---- Continue working: the dataset just opened ----
        page.goto(f"{base}/projects/{P}/datasets")
        recent = page.locator(f"[data-testid=recent-dataset][data-dataset-id='{P}']")
        resume = page.get_by_test_id("datasets-continue")
        page.wait_for_timeout(1500)
        check("an opened dataset comes back under Continue working", recent.count() == 1 or resume.count() == 1)
        ctx.close()

        # ---- Empty: no datasets (§3.1) ----
        ctx, page = fresh()
        page.route(f"**/api/v1/projects/{P}/datasets", lambda r: fulfill(r, {"datasets": []}))
        page.goto(f"{base}/projects/{P}/datasets")
        empty = page.get_by_test_id("datasets-empty")
        empty.wait_for(timeout=20000)
        check("no datasets: the empty state, under both test ids", page.get_by_test_id("no-datasets").count() == 1)
        check("the empty state says what will appear", "once you add data" in empty.inner_text())
        check("it offers Drop files, Ask the assistant and Create dataset", all(page.get_by_test_id(t).count() == 1 for t in ("composer-add-files", "composer-ask", "datasets-empty-create")))
        page.screenshot(path=str(shots / "empty.png"), full_page=True)
        page.get_by_test_id("composer-ask").click()
        page.get_by_test_id("agent-drawer").wait_for(timeout=5000)
        check("Ask the assistant opens the assistant", True)
        ctx.close()

        # ---- Viewer: read-only (§12.2) ----
        ctx, page = fresh()

        def as_viewer(route):
            resp = route.fetch()
            body = resp.json()
            for p in body.get("projects", []):
                p["role"] = "viewer"
            fulfill(route, body)

        page.route("**/api/v1/projects?*", as_viewer)
        page.route("**/api/v1/projects", as_viewer)
        page.goto(f"{base}/projects/{P}/datasets/{P}")
        page.get_by_test_id("dataset-header").wait_for(timeout=20000)
        page.get_by_test_id("read-only").wait_for(timeout=10000)
        check("a viewer sees View only", True)
        check("a viewer has no Add data, Propose change or Publish", all(page.get_by_test_id(t).count() == 0 for t in ("dataset-add-data", "propose-change", "dataset-publish")))
        page.screenshot(path=str(shots / "viewer.png"), full_page=True)
        page.goto(f"{base}/projects/{P}/datasets/{P}/structure")
        page.locator("[data-testid=structure-collection]").first.wait_for(timeout=10000)
        check("a viewer can't confirm structure", page.get_by_test_id("confirm-all-collections").count() == 0)
        page.locator("[data-testid=structure-collection]").first.click()
        page.get_by_test_id("dataset-inspector").wait_for(timeout=5000)
        check("a viewer can still inspect a collection", page.get_by_test_id("confirm-collection").count() == 0)
        page.goto(f"{base}/projects/{P}/datasets")
        page.locator("[data-testid=dataset-card]").first.wait_for(timeout=10000)
        check("a viewer can't create a dataset", page.get_by_test_id("new-dataset").count() == 0)
        ctx.close()

        # ---- No access and server errors (§12.1) ----
        ctx, page = fresh()
        page.route(f"**/api/v1/projects/{P}/datasets/{P}/profile", lambda r: fulfill(r, {"detail": "forbidden"}, 403))
        page.goto(f"{base}/projects/{P}/datasets/{P}/fields")
        err = page.locator("[data-testid=error-view]").first
        err.wait_for(timeout=20000)
        check("no access to a dataset's profile says No access", err.get_attribute("data-error") == "access-denied", err.get_attribute("data-error") or "")
        page.screenshot(path=str(shots / "no-access.png"), full_page=True)
        ctx.close()

        ctx, page = fresh()
        page.route(f"**/api/v1/projects/{P}/dataset-summaries", lambda r: fulfill(r, {"detail": "boom"}, 500))
        page.goto(f"{base}/projects/{P}/datasets")
        card = page.locator(f"[data-testid=dataset-card][data-dataset-id='{P}']")
        card.get_by_test_id("dataset-content").wait_for(timeout=20000)
        check("summaries failing falls back to each dataset's profile", True)
        ctx.close()

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    print(f"screenshots: {shots}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
