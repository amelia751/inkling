"""Live boot and live updates (todo11 Milestone 2, item 11, client parts), against the real API
and the agent service with a scripted model (tests/e2e/fixtures/live-boot-script.json).

The test starts the agent itself (scripted model, no sandbox, a temp data dir) on
<envPrefix>E2E_AGENT_PORT (default 8252), pointed at the API. Start the API and a frozen dev server
first (from the repo root; the API on SQLite in a temp dir):

    STUDIO_API_DATA_DIR=$(mktemp -d) uv run --package studio-api uvicorn studio_api.app:app --port 8251 &
    cd apps/web && STUDIO_API_URL=http://127.0.0.1:8251 STUDIO_E2E=1 \\
      STUDIO_AGENT_URL=http://127.0.0.1:8252 STUDIO_AGENT_TOKEN=e2e-agent-token \\
      pnpm exec vite --port 5251 --strictPort
    STUDIO_E2E_API_URL=http://127.0.0.1:8251 python3 ../../tests/e2e/live_boot_test.py --port 5251

Covers:
- "explain pneumothorax" in the Overview drawer boots nothing;
- "Create a chest X-ray Studio with five classification labels" typed in the Overview drawer (no
  Studio open) navigates to the new draft without a full page load, paints the Studio shell
  within 2 s of the navigation, shows the 5 labels and the boot card's `boot.ready` state;
- an environment PATCH with curl updates the open tab within 500 ms, with no reload;
- the New Studio button and `/studio <words>` boot from the preset table (no model turn);
- "Could we make…" gets an `offer_studio` card whose Create click boots the draft.
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

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
from harness import NAMING, launch, parse_args, src_url, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "live-boot-script.json"
TOKEN = "e2e-agent-token"
P = NAMING["envPrefix"]
AGENT_PORT = int(os.environ.get(f"{P}E2E_AGENT_PORT", "8252"))
KERNEL = os.environ.get(f"{P}E2E_API_URL", "http://127.0.0.1:8251")
PROJECT = "2d-xray"
AI = f"{NAMING['displayName']} AI"
STORE = src_url("apps/web/src/studio/stores/studio.ts")

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=30.0, every=0.1):
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


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
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
        "API_URL": KERNEL,
        "LOG_LEVEL": "warn",
    }
    env = {**os.environ, **{P + k: v for k, v in settings.items()}}
    proc = subprocess.Popen(["pnpm", "--filter", "@studio/agent", "start:dev"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if not wait(lambda: get_json(f"http://127.0.0.1:{AGENT_PORT}/health/live").get("ok"), timeout=60, every=0.25):
        proc.terminate()
        out = proc.stdout.read().decode() if proc.stdout else ""
        raise RuntimeError(f"agent service didn't start on {AGENT_PORT}:\n{out[-2000:]}")
    return proc


def open_drawer(page, port: int) -> None:
    page.goto(f"http://localhost:{port}/projects/{PROJECT}/overview")
    page.get_by_test_id("project-header").wait_for(timeout=30000)
    page.get_by_label(f"{AI} panel").wait_for(timeout=10000)
    if not page.get_by_test_id("agent-drawer").count():  # the open state is remembered per person
        page.get_by_label(f"{AI} panel").click()
    page.get_by_test_id("agent-drawer").wait_for(timeout=10000)
    consent = page.get_by_role("button", name="Turn on for this browser")
    consent.or_(page.get_by_label(f"Message {AI}")).first.wait_for(timeout=20000)
    if consent.count():
        consent.click()


def ask(page, text: str) -> None:
    box = page.get_by_label(f"Message {AI}").last
    box.fill(text)
    box.press("Enter")


def store(page, expr: str):
    return page.evaluate(f"async () => {{ const m = await import('{STORE}'); return ({expr})(m.useStudio.getState()); }}")


def boots_in_project() -> int:
    return len(get_json(f"{KERNEL}/api/v1/projects/{PROJECT}/overview")["tasks"])


def t_live_boot(browser, port: int) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        open_drawer(page, port)
        # A question boots nothing (D5).
        tasks_before = boots_in_project()
        ask(page, "Can you explain what pneumothorax means?")
        page.get_by_text("Pneumothorax is air in the pleural space").wait_for(timeout=20000)
        check("question: answered, nothing booted", page.get_by_test_id("boot-card").count() == 0 and boots_in_project() == tasks_before and "/overview" in page.url, page.url)

        # The marker survives an SPA navigation, not a page load.
        page.evaluate("() => { window.__noReload = 'kept' }")
        t_ask = time.time()
        ask(page, "Create a chest X-ray Studio with five classification labels")
        page.wait_for_url(f"**/projects/{PROJECT}/studio/tsk-*", timeout=20000)
        t_nav = time.time()
        page.get_by_test_id("studio-header").wait_for(timeout=10000)
        t_shell = time.time()
        check("boot: navigated without a full page load", page.evaluate("() => window.__noReload") == "kept", page.url)
        check("boot: Studio shell painted < 2 s after navigating", t_shell - t_nav < 2.0, f"{(t_shell - t_nav) * 1000:.0f} ms (ask → nav {(t_nav - t_ask) * 1000:.0f} ms)")
        task_id = page.url.rstrip("/").split("/")[-1].split("?")[0]
        classes = wait(lambda: (lambda c: c if len(c) == 5 else None)(store(page, "s => (s.env?.labels ?? []).flatMap(g => g.classes.map(c => c.id))")), timeout=20)
        check("boot: the 5 labels are in the Studio", classes == ["Normal", "Pneumonia", "Effusion", "Cardiomegaly", "Pneumothorax"], str(classes))
        tab = page.get_by_role("tab", name="Labels")
        (tab if tab.count() else page.get_by_text("Labels", exact=True)).first.click()
        page.get_by_text("Cardiomegaly").first.wait_for(timeout=10000)
        check("boot: the labels show on screen", page.get_by_text("Cardiomegaly").first.is_visible())
        ready = page.locator("[data-testid='boot-card'][data-state='ready'], [data-testid='boot-pill'][data-state='ready']").first
        ready.wait_for(timeout=20000)
        check("boot: boot.ready shown < 20 s", time.time() - t_ask < 20, f"{(time.time() - t_ask):.1f} s")
        card = page.get_by_test_id("boot-card").first
        if card.count():
            # todo29 D7: one line, "{name} · {n} items", then Open; Undo and Publish stay (on hover).
            check("boot card: one line with the item count", "items" in card.inner_text() and "Studio ready" not in card.inner_text(), card.inner_text()[:200])
            check("boot card: Undo · Publish", card.get_by_test_id("boot-undo").count() == 1 and card.get_by_test_id("boot-publish").count() == 1)
        task = get_json(f"{KERNEL}/api/v1/tasks/{task_id}")
        check("boot: the task is a draft", task.get("state") == "draft", str({k: task.get(k) for k in ("state", "bootId")}))

        # Live update: a PATCH from elsewhere lands in this tab within 500 ms, without a reload.
        page.evaluate(
            f"""async () => {{
              const m = await import('{STORE}');
              window.__patchedAt = 0;
              m.useStudio.subscribe((s) => {{
                const n = (s.env?.labels ?? []).flatMap((g) => g.classes).length;
                if (n === 6 && !window.__patchedAt) window.__patchedAt = Date.now();
              }});
            }}"""
        )
        rev = get_json(f"{KERNEL}/api/environments/{task_id}")["revision"]
        body = json.dumps({"revision": rev, "author": "curl", "patch": [{"op": "add", "path": "/labels/0/classes/-", "value": {"id": "Nodule"}}]})
        sent = time.time() * 1000
        out = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "PATCH", "-H", "Content-Type: application/json", "-d", body, f"{KERNEL}/api/environments/{task_id}"], capture_output=True, text=True)
        check("live: curl PATCH accepted", out.stdout.strip() == "200", out.stdout + out.stderr)
        landed = wait(lambda: page.evaluate("() => window.__patchedAt") or None, timeout=5, every=0.02)
        ms = (landed - sent) if landed else None
        check("live: the open tab updates < 500 ms", ms is not None and ms < 500, f"{ms:.0f} ms" if ms is not None else "never")
        check("live: no reload", page.evaluate("() => window.__noReload") == "kept")
        page.get_by_text("Nodule").first.wait_for(timeout=5000)
        check("live: the new class shows", page.get_by_text("Nodule").first.is_visible())

        # Publish from the card (person only).
        if card.count():
            card.get_by_test_id("boot-publish").click()
            wait(lambda: get_json(f"{KERNEL}/api/v1/tasks/{task_id}").get("state") == "published", timeout=10)
            check("boot card: Publish publishes the draft", get_json(f"{KERNEL}/api/v1/tasks/{task_id}").get("state") == "published")
        check("live boot: no page errors", not errors, str(errors[:3]))
    finally:
        ctx.close()


def t_person_boots(browser, port: int) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    try:
        # New Studio: the preset table picks image-2d; this tab opens the draft.
        page.goto(f"http://localhost:{port}/projects/{PROJECT}/overview")
        page.get_by_test_id("new-studio").click()
        page.get_by_test_id("new-studio-input").fill("chest x-ray")
        check("New Studio: preset from the table", "preset:image-2d" in page.get_by_test_id("new-studio-preset").inner_text())
        page.evaluate("() => { window.__noReload = 'kept' }")
        page.get_by_test_id("new-studio-create").click()
        page.wait_for_url(f"**/projects/{PROJECT}/studio/tsk-*", timeout=15000)
        check("New Studio: opens the draft without a reload", page.evaluate("() => window.__noReload") == "kept", page.url)
        page.get_by_test_id("boot-pill").wait_for(timeout=10000)
        check("New Studio: the top-bar pill", page.get_by_test_id("boot-pill").get_attribute("data-state") in ("running", "ready"))

        # /studio in the drawer: answered in the browser with a boot card.
        open_drawer(page, port)
        ask(page, "/studio ECG")
        page.wait_for_url(f"**/projects/{PROJECT}/studio/tsk-*", timeout=15000)
        task_id = page.url.rstrip("/").split("/")[-1]
        env = wait(lambda: get_json(f"{KERNEL}/api/environments/{task_id}").get("environment"), timeout=10)
        check("/studio: booted from the table", (env or {}).get("extends") == "preset:ecg", str(env)[:200])
        # "Could we…" gets an offer card; its Create click is the explicit intent (D5).
        open_drawer(page, port)
        ask(page, "Could we make a chest X-ray Studio?")
        page.get_by_test_id("studio-offer").last.wait_for(timeout=20000)
        check("offer: a Create X-ray Studio button, nothing booted yet", page.get_by_test_id("studio-offer-create").last.inner_text().strip() == "Create X-ray Studio" and "/overview" in page.url)
        page.get_by_test_id("studio-offer-create").last.click()
        page.wait_for_url(f"**/projects/{PROJECT}/studio/tsk-*", timeout=15000)
        task = get_json(f"{KERNEL}/api/v1/tasks/{page.url.rstrip('/').split('/')[-1]}")
        check("offer: the click boots a draft", task.get("state") == "draft" and task.get("title") == "X-ray Studio", str({k: task.get(k) for k in ("title", "state")}))
        check("person boots: no page errors", not errors, str(errors[:3]))
    finally:
        ctx.close()


def main() -> int:
    args = parse_args()
    try:
        get_json(f"{KERNEL}/healthz")
    except Exception as e:  # noqa: BLE001
        print(f"FAIL no API at {KERNEL} ({e}); see this file's docstring")
        return 1
    agent = start_agent(tempfile.mkdtemp(prefix="studio-live-boot-"))
    try:
        status = get_json(f"http://localhost:{args.port}/api/agent/status")
        if status.get("provider") != "scripted":
            print(f"FAIL the dev server proxies /api/agent elsewhere ({status}); start it with {P}AGENT_URL=http://127.0.0.1:{AGENT_PORT} {P}AGENT_TOKEN={TOKEN}")
            return 1
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            for fn in (t_live_boot, t_person_boots):
                try:
                    fn(browser, args.port)
                except Exception as e:  # noqa: BLE001 — report and keep going
                    check(f"{fn.__name__} crashed", False, repr(e)[:400])
            browser.close()
    finally:
        agent.terminate()
        agent.wait(timeout=20)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
