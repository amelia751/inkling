"""Project navigation (todo6 Phase 2): the old URLs redirect, the sidebar collapses to a rail
(and the Studio's rail hides with the same command), and the breadcrumb's switchers work.

Seed mode (the Vite seed server's read-only project API):
    python3 e2e/navigation_test.py --port 5199
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


REDIRECTS = {
    "/datasets/2d-xray": "/projects/2d-xray/studio/2d-xray",
    "/datasets/2d-xray/review": "/projects/2d-xray/review",
    "/datasets/2d-xray/export": "/projects/2d-xray/datasets/2d-xray/publish",
    "/datasets/2d-xray/plugins": "/projects/2d-xray/settings/plugins",
    "/datasets/2d-xray/versions": "/projects/2d-xray/datasets/2d-xray/versions",
    "/projects/2d-xray": "/projects/2d-xray/overview",
}

SECTIONS = ["Overview", "Data", "Studio", "Review", "Activity", "Settings"]


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        for old, new in REDIRECTS.items():
            page.goto(base + old)
            page.wait_for_url(f"**{new}", timeout=15000)
            check(f"redirect {old}", page.url.endswith(new), page.url)

        # Every section is reachable from the project sidebar.
        page.goto(f"{base}/projects/2d-xray/overview")
        page.wait_for_selector("[data-testid=project-sidebar]")
        nav = page.locator("[data-testid=project-sidebar]")
        for label in SECTIONS:
            check(f"sidebar has {label}", nav.get_by_role("link", name=label, exact=True).count() == 1)
        nav.get_by_role("link", name="Data", exact=True).click()
        page.wait_for_url("**/projects/2d-xray/files")
        check("sidebar navigates", page.url.endswith("/files"))
        # The URL changes before the router's transition renders the new page: wait for it.
        crumb = page.locator("[data-testid=breadcrumb] [aria-current=page]", has_text="Data")
        crumb.wait_for(timeout=5000)
        check("breadcrumb names the section", crumb.inner_text() == "Data")

        # The toggle command collapses the sidebar to a 48px rail with labelled icons.
        page.mouse.click(700, 500)
        page.keyboard.press("ControlOrMeta+b")
        rail = page.locator("[data-testid=project-rail]")
        rail.wait_for(timeout=5000)
        width = rail.bounding_box()["width"]
        check("toggle collapses to a rail", round(width) == 48, f"{width}px")
        check("rail marks the active section", rail.locator("[aria-current=page]").get_attribute("aria-label") == "Data")
        rail.get_by_role("link", name="Review").hover()
        page.wait_for_timeout(1200)
        check("rail icons have tooltips", page.get_by_role("tooltip").filter(has_text="Review").count() >= 1)
        page.keyboard.press("ControlOrMeta+b")
        page.wait_for_selector("[data-testid=project-sidebar]", timeout=5000)
        check("toggle expands it again", page.locator("[data-testid=project-sidebar]").count() == 1)

        # Breadcrumb switchers: workspace (one personal org) and project (same section).
        page.locator("[data-testid=workspace-switcher]").click()
        check("workspace switcher lists the personal workspace", page.get_by_role("menuitem", name="Personal").count() == 1)
        page.keyboard.press("Escape")
        page.locator("[data-testid=project-switcher]").click()
        page.locator("[data-testid=switch-project-ecg-waveform]").click()
        page.wait_for_url("**/projects/ecg-waveform/files")
        check("project switcher keeps the section", page.url.endswith("/projects/ecg-waveform/files"))
        # Create project from anywhere: the switcher's "New project" opens it as a dialog.
        page.locator("[data-testid=project-switcher]").click()
        page.locator("[data-testid=switcher-new-project]").click()
        dialog = page.locator("[data-testid=new-project-dialog]")
        dialog.wait_for(timeout=5000)
        check("New project opens as a dialog", dialog.locator("[data-testid=project-title-input]").count() == 1 and page.url.endswith("/files"))
        dialog.get_by_role("button", name="Cancel").click()
        dialog.wait_for(state="detached", timeout=5000)

        # The Studio: the project nav is a rail, the top bar has the breadcrumb, and the same
        # command hides the rail to give the canvas the space.
        page.goto(f"{base}/projects/2d-xray/studio/2d-xray")
        page.wait_for_selector("main[aria-label='Viewer']", timeout=30000)
        check("Studio shows the rail", page.locator("[data-testid=project-rail]").count() == 1)
        check("Studio top bar has the breadcrumb", page.locator("header [data-testid=project-switcher]").count() == 1)
        viewer_before = page.locator("main[aria-label='Viewer']").bounding_box()["width"]
        page.mouse.click(700, 500)
        page.keyboard.press("ControlOrMeta+b")
        page.wait_for_timeout(400)
        viewer_after = page.locator("main[aria-label='Viewer']").bounding_box()["width"]
        check("command hides the Studio rail", page.locator("[data-testid=project-rail]").count() == 0 and viewer_after > viewer_before, f"{viewer_before} → {viewer_after}")
        page.keyboard.press("ControlOrMeta+b")
        page.wait_for_selector("[data-testid=project-rail]", timeout=5000)

        # "Studio" in the nav opens the project's only task.
        page.goto(f"{base}/projects/2d-xray/overview")
        page.locator("[data-testid=project-sidebar]").get_by_role("link", name="Studio", exact=True).click()
        page.wait_for_url("**/projects/2d-xray/studio/2d-xray", timeout=15000)
        check("Studio entry opens the task", page.url.endswith("/studio/2d-xray"))

        check("no page errors", not errors, "; ".join(errors[:3]))
        ctx.close()

        # Phones: a drawer for navigation; the Studio still opens, with a notice.
        phone = browser.new_context(viewport={"width": 390, "height": 844})
        p = phone.new_page()
        p.goto(f"{base}/projects/2d-xray/overview")
        p.locator("[data-testid=nav-toggle]").click()
        check("phone nav is a drawer", p.get_by_role("dialog").get_by_role("link", name="Data").count() == 1)
        p.goto(f"{base}/projects/2d-xray/studio/2d-xray")
        p.wait_for_selector("[data-testid=small-screen-notice]", timeout=30000)
        check("phone Studio says a larger screen works best", "larger screen" in p.locator("[data-testid=small-screen-notice]").inner_text())
        phone.close()
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
