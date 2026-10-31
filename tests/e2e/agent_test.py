"""Inkling AI against the real agent service (apps/agent) with a scripted model (todo1 §8.4).

The test starts the agent service itself (INKLING_AGENT_MODEL=scripted, INKLING_AGENT_SANDBOX=off, a temp data
dir) on --agent-port, replaying tests/e2e/fixtures/agent-script.json. Start the dev server pointed at it:

    INKLING_E2E=1 INKLING_AGENT_URL=http://127.0.0.1:8299 INKLING_AGENT_TOKEN=e2e-agent-token \\
      pnpm exec vite --port 5299 --strictPort
    python3 ../../tests/e2e/agent_test.py --port 5299   # from apps/web

Covers the client-tool round trip (patch_environment applied as one undoable step and saved as an
agent edit), the approval card, a card tool, and reattaching to a run after a reload.

todo6 Phase 6 (the assistant outside the Studio) needs the kernel too, so its project tools have
routes to read and its 403 is the real one. Start the API and point both the dev server and the
agent at it (the test passes <envPrefix>API_URL on to the agent it starts):

    (cd apps/api && uv run uvicorn studio_api.app:app --port 8216) &
    INKLING_API_URL=http://127.0.0.1:8216 INKLING_E2E=1 INKLING_AGENT_URL=http://127.0.0.1:8206 \
      INKLING_AGENT_TOKEN=e2e-agent-token pnpm exec vite --port 5206 --strictPort
    INKLING_E2E_AGENT_PORT=8206 INKLING_E2E_API_URL=http://127.0.0.1:8216 \
      python3 ../../tests/e2e/agent_test.py --port 5206   # from apps/web

Without a reachable kernel the project-assistant run is skipped (reported, not failed).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

# The browser harness lives with the web-only tests (apps/web/e2e).
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
from harness import NAMING, launch, open_studio, parse_args, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "agent-script.json"
TOKEN = "e2e-agent-token"
P = NAMING["envPrefix"]
AGENT_PORT = int(os.environ.get(f"{P}E2E_AGENT_PORT", "8299"))
KERNEL = os.environ.get(f"{P}E2E_API_URL")

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=30.0, every=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001 — keep polling
            pass
        time.sleep(every)
    return last


def get_json(url: str, token: str | None = None):
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def start_agent(data_dir: str) -> subprocess.Popen:
    settings = {
        "ENV": "test",
        "AGENT_MODEL": "scripted",
        "AGENT_SCRIPT": str(FIXTURE),
        "AGENT_SANDBOX": "off",
        "AGENT_PORT": str(AGENT_PORT),
        "AGENT_DATA_DIR": data_dir,
        "AGENT_TOKEN": TOKEN,
        "LOG_LEVEL": "warn",
    }
    env = {**os.environ, **{P + k: v for k, v in settings.items()}}
    proc = subprocess.Popen(["pnpm", "--filter", "@studio/agent", "start:dev"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if not wait(lambda: get_json(f"http://127.0.0.1:{AGENT_PORT}/health/live").get("ok"), timeout=60):
        proc.terminate()
        out = proc.stdout.read().decode() if proc.stdout else ""
        raise RuntimeError(f"agent service didn't start on {AGENT_PORT}:\n{out[-2000:]}")
    return proc


def open_panel(browser, port: int, saved: list[dict]):
    st = open_studio(browser, port, "pathology-wsi", fixture_annotations=[])
    page = st.page

    def envs(route):
        if route.request.method == "PUT":
            doc = json.loads(route.request.post_data or "{}")
            saved.append(doc)
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"revision": len(saved), "environment": doc.get("environment")}))
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"revision": 0, "environment": None}))

    page.route("**/api/environments/**", envs)
    page.reload()
    page.wait_for_selector("[data-testid='wsi-viewer']", timeout=30000)
    page.get_by_label("Inkling AI panel").click()
    consent = page.get_by_role("button", name="Turn on for this browser")
    consent.or_(page.get_by_label("Message Inkling AI")).first.wait_for(timeout=20000)
    if consent.count():
        consent.click()
    return st


def ask(page, text: str) -> None:
    box = page.get_by_label("Message Inkling AI")
    box.fill(text)
    box.press("Enter")


def t_environment_edit(browser, port):
    saved: list[dict] = []
    st = open_panel(browser, port, saved)
    page = st.page
    try:
        ask(page, "Add a mitosis class")
        page.wait_for_selector("[data-testid='agent-change']", timeout=20000)
        page.get_by_text("Added a mitosis class.").wait_for(timeout=10000)
        classes = st.store("s => s.env.labels[0].classes.map(c => c.id)")
        check("environment: patch applied to the running environment", classes[-1] == "mitosis", str(classes))
        check("environment: saved as an agent edit", bool(saved) and saved[-1].get("author") == "agent:replay", str(saved and saved[-1].get("author")))
        steps = page.locator("[data-testid='agent-log'] li").all_inner_texts()
        check("environment: tool steps shown", any("Read environment" in s for s in steps) and any("Edited environment" in s for s in steps), str(steps))
        page.get_by_test_id("agent-change").get_by_role("button", name="Undo").click()
        undone = wait(lambda: "mitosis" not in st.store("s => s.env.labels[0].classes.map(c => c.id)"))
        check("environment: Undo reverts and saves as the expert", bool(undone) and saved[-1].get("author") == "local-expert", str([d.get("author") for d in saved]))
        check("environment: usage line shown", page.get_by_test_id("agent-usage").count() >= 1)
        check("environment: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        page.context.close()


def t_approval_and_reattach(browser, port):
    saved: list[dict] = []
    st = open_panel(browser, port, saved)
    page = st.page
    try:
        ask(page, "Toggle the class names")
        card = page.get_by_test_id("agent-approval")
        card.wait_for(timeout=20000)
        check("approval: card shows the command", "toggleClassNames" in card.inner_text(), card.inner_text()[:120])
        # Reload mid-run: the panel reattaches to the run and replays the pending approval.
        page.reload()
        page.wait_for_selector("[data-testid='wsi-viewer']", timeout=30000)
        if not page.get_by_label("Message Inkling AI").count():
            page.get_by_label("Inkling AI panel").click()
        card = page.get_by_test_id("agent-approval")
        card.wait_for(timeout=20000)
        check("reattach: pending approval survives a reload", card.get_by_role("button", name="Approve").count() == 1)
        card.get_by_role("button", name="Approve").click()
        page.get_by_text("The command ran.").wait_for(timeout=20000)
        check("approval: approved state shown", "Approved" in card.inner_text(), card.inner_text()[-60:])
        steps = page.locator("[data-testid='agent-log'] li").all_inner_texts()
        check("approval: the command ran in the Studio after approval", any(s.startswith("Ran command") for s in steps), str(steps))
        check("approval: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        page.context.close()


def t_card(browser, port):
    saved: list[dict] = []
    st = open_panel(browser, port, saved)
    page = st.page
    try:
        ask(page, "Find unannotated slides")
        page.get_by_text("Here is the slide still to do.").wait_for(timeout=20000)
        check("card: item list card rendered", page.get_by_role("heading", name="Unannotated slides").count() == 1)
        check("card: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        page.context.close()


def kernel_json(path: str):
    req = urllib.request.Request(f"{KERNEL}/api/v1{path}", headers={"X-Workspace-Id": "2d-xray"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def t_project_assistant(browser, port):
    """todo6 Phase 6: ask on Sources, answer from list_sources, keep the thread on Overview,
    propose (approved), and the agent's confirm attempt refused by the API with 403."""
    if not KERNEL:
        print(f"SKIP project assistant: set {P}E2E_API_URL to a running kernel", flush=True)
        return
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    try:
        page.goto(f"http://localhost:{port}/projects/2d-xray/sources")
        page.get_by_test_id("sources-page").wait_for(timeout=30000)
        page.get_by_label(f"{NAMING['displayName']} AI panel").click()
        drawer = page.get_by_test_id("agent-drawer")
        drawer.wait_for(timeout=10000)
        check("drawer: opens at 340px in the project shell", 330 <= drawer.bounding_box()["width"] <= 350, str(drawer.bounding_box()))
        consent = page.get_by_role("button", name="Turn on for this browser")
        consent.or_(page.get_by_label("Message Inkling AI")).first.wait_for(timeout=20000)
        if consent.count():
            consent.click()
        chip = page.get_by_test_id("agent-context")
        # The Sources page shares the folder it shows (a single source opens on its root folder).
        check("context chip: Data", chip.inner_text().strip().startswith("Data"), chip.inner_text())
        ask(page, "What did I import?")
        page.get_by_text("You imported one source with 20 images").wait_for(timeout=20000)
        steps = page.locator("[data-testid='agent-log'] li").all_inner_texts()
        check("sources: answered from list_sources", any(s.startswith("Listed sources") and "20 files" in s for s in steps), str(steps))
        loc = page.get_by_test_id("agent-location").get_by_role("button")
        check("open_location: a button, the agent didn't navigate", "Open Data › 2d-xray" in loc.inner_text() and "/sources" in page.url and "/nod-" not in page.url, loc.inner_text() + " " + page.url)
        page.get_by_role("navigation", name="Project").get_by_role("link", name="Overview").click()
        page.wait_for_url("**/overview", timeout=10000)
        page.get_by_text("You imported one source with 20 images").wait_for(timeout=10000)
        check("overview: the thread survives the section change", page.get_by_test_id("agent-log").get_by_text("What did I import?").count() == 1)
        wait(lambda: page.get_by_test_id("agent-context").inner_text().strip() == "Overview", timeout=10)
        check("context chip: Overview", page.get_by_test_id("agent-context").inner_text().strip() == "Overview", page.get_by_test_id("agent-context").inner_text())
        # Removing the chip stops sharing the section; the "+" chip brings it back.
        page.get_by_label("Don't share this context").click()
        check("context chip: removable", page.get_by_test_id("agent-context").get_attribute("data-dismissed") == "true")
        page.get_by_test_id("agent-context").click()
        before = {p["id"] for p in kernel_json("/projects/2d-xray/proposals?status=proposed")["proposals"]}
        ask(page, "Propose a link between the folders and confirm it")
        card = page.get_by_test_id("agent-approval").last
        card.wait_for(timeout=20000)
        check("propose: behind an approval card", "proposal" in card.inner_text().lower(), card.inner_text()[:160])
        card.get_by_role("button", name="Approve").click()
        page.get_by_text("The API refused to let me confirm it (403)").wait_for(timeout=20000)
        steps = page.locator("[data-testid='agent-log'] li").all_inner_texts()
        check("confirm: refused by the API with 403 and shown", any("Refused by the API (403)" in s for s in steps), str(steps[-4:]))
        made = [p for p in kernel_json("/projects/2d-xray/proposals?status=proposed")["proposals"] if p["id"] not in before]
        check("propose: one proposal, still proposed, by agent:<run>", len(made) == 1 and made[0]["createdBy"].startswith("agent:run_"), str(made))
        check("propose: the card links to Explore", page.get_by_test_id("agent-proposal-link").count() >= 1)
        page.get_by_test_id("agent-location").last.get_by_role("button").click()
        page.wait_for_url("**/explore/relationships", timeout=10000)
        check("open_location: the person's click opens Explore", "/explore/relationships" in page.url, page.url)
        check("project assistant: no console errors", not errors, str(errors[:3]))
    finally:
        ctx.close()


def main() -> int:
    args = parse_args()
    data_dir = tempfile.mkdtemp(prefix="inkling-agent-e2e-")
    if KERNEL:
        os.environ[f"{P}API_URL"] = KERNEL  # the agent the test starts calls this API
    agent = start_agent(data_dir)
    try:
        status = get_json(f"http://localhost:{args.port}/api/agent/status")
        if status.get("provider") != "scripted":
            print(f"FAIL the dev server proxies /api/agent elsewhere ({status}); start it with {P}AGENT_URL=http://127.0.0.1:{AGENT_PORT} {P}AGENT_TOKEN={TOKEN}")
            return 1
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            for fn in (t_environment_edit, t_approval_and_reattach, t_card, t_project_assistant):
                try:
                    fn(browser, args.port)
                except Exception as e:  # noqa: BLE001 — report and keep going
                    check(f"{fn.__name__} crashed", False, repr(e)[:300])
            browser.close()
    finally:
        agent.terminate()
        agent.wait(timeout=20)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
