"""Inkling AI against the real agent service (apps/agent) with a scripted model (todo1 §8.4).

The test starts the agent service itself (AGENT_MODEL=scripted, AGENT_SANDBOX=off, a temp data
dir) on --agent-port, replaying e2e/fixtures/agent-script.json. Start the dev server pointed at it:

    INKLING_E2E=1 INKLING_AGENT_URL=http://127.0.0.1:8299 INTERNAL_AGENT_SERVICE_TOKEN=e2e-agent-token \\
      pnpm exec vite --port 5299 --strictPort
    python3 e2e/agent_test.py --port 5299

Covers the client-tool round trip (patch_environment applied as one undoable step and saved as an
agent edit), the approval card, a card tool, and reattaching to a run after a reload.
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

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, open_studio, parse_args, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).parent / "fixtures" / "agent-script.json"
TOKEN = "e2e-agent-token"
AGENT_PORT = int(os.environ.get("INKLING_E2E_AGENT_PORT", "8299"))

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
    env = {
        **os.environ,
        "APP_ENV": "test",
        "AGENT_MODEL": "scripted",
        "AGENT_SCRIPT": str(FIXTURE),
        "AGENT_SANDBOX": "off",
        "AGENT_PORT": str(AGENT_PORT),
        "AGENT_DATA_DIR": data_dir,
        "INTERNAL_AGENT_SERVICE_TOKEN": TOKEN,
        "LOG_LEVEL": "warn",
    }
    proc = subprocess.Popen(["pnpm", "--filter", "@inkling/agent", "start"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
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


def main() -> int:
    args = parse_args()
    data_dir = tempfile.mkdtemp(prefix="inkling-agent-e2e-")
    agent = start_agent(data_dir)
    try:
        status = get_json(f"http://localhost:{args.port}/api/agent/status")
        if status.get("provider") != "scripted":
            print(f"FAIL the dev server proxies /api/agent elsewhere ({status}); start it with INKLING_AGENT_URL=http://127.0.0.1:{AGENT_PORT} INTERNAL_AGENT_SERVICE_TOKEN={TOKEN}")
            return 1
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            for fn in (t_environment_edit, t_approval_and_reattach, t_card):
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
