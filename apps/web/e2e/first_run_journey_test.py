"""todo15 Milestone 1 exit: the first-run journey as two brand-new people on one browser.

Scripted model, dev auth (`pnpm dev`'s mode; the Emulate sign-in is covered by auth_test.py). The
account menu's "Start as a new person" (todo14) stands in for "sign in as a new user":

1. new person → empty Home → type "Chest X-ray classification with five labels" → a Studio with
   the five labels, and no consent screen anywhere (D2: the first send is the acknowledgement);
2. drop 12 generated PNGs on Home with no text → the Studio opens, the dataset is in Datasets and
   the assistant replies in the chat (the empty-text drop message is sent);
3. switch to another new person on the same browser → empty Home, no conversations, no recents
   (D1: persisted client state is per person).

Needs the API with its worker; the test starts the agent service itself (scripted model,
tests/e2e/fixtures/journey-script.json, or <envPrefix>E2E_AGENT_SCRIPT) on <envPrefix>E2E_AGENT_PORT
(default 8316):

    INKLING_API_DATA_DIR=/tmp/first-run-e2e uv run --package studio-api uvicorn studio_api.app:app --port 8226 &
    uv run --package studio-worker studio-worker --kernel http://127.0.0.1:8226 &
    cd apps/web && INKLING_E2E=1 INKLING_API_URL=http://127.0.0.1:8226 INKLING_AGENT_URL=http://127.0.0.1:8316 \\
      INKLING_AGENT_TOKEN=e2e-agent-token pnpm exec vite --port 5216 --strictPort &
    INKLING_E2E_API_URL=http://127.0.0.1:8226 python3 e2e/first_run_journey_test.py --port 5216 [--shots DIR]
"""

from __future__ import annotations

import base64
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import NAMING, launch, parse_args, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
P = NAMING["envPrefix"]
AGENT_PORT = int(os.environ.get(f"{P}E2E_AGENT_PORT", "8316"))
KERNEL = os.environ.get(f"{P}E2E_API_URL", "http://127.0.0.1:8226")
SCRIPT = Path(os.environ.get(f"{P}E2E_AGENT_SCRIPT") or ROOT / "tests" / "e2e" / "fixtures" / "journey-script.json")
TOKEN = "e2e-agent-token"
AI = f"{NAMING['displayName']} AI"
LABELS = ("normal", "pneumonia", "effusion", "cardiomegaly", "pneumothorax")
# todo15 M2: <envPrefix>E2E_AGENT_MODEL=<provider:model> runs the agent on that real model instead
# of the script (by hand only, never in `pnpm test`; the provider key comes from the shell). A real
# model has to be told the label names, so the goal names them.
MODEL = os.environ.get(f"{P}E2E_AGENT_MODEL", "")
GOAL = f"Chest X-ray classification with five labels: {', '.join(LABELS)}" if MODEL else "Chest X-ray classification with five labels"
TIMES: dict[str, float] = {}
# Anything the old consent wall showed (todo15 gap 2): none of it may appear.
CONSENT = "[data-testid=agent-consent], [data-testid=assistant-consent], [data-testid=consent]"

results: list[tuple[str, bool, str]] = []
SHOTS: Path | None = None


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def shot(page, name: str) -> None:
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{name}.png"))


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


def png(seed: int) -> bytes:
    """A small grayscale PNG, different per seed (no real image bytes, ever)."""
    w, h = 24 + seed, 20
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3 + seed * 13) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def kernel(method: str, path: str, principal: str | None, body=None):
    """The API as the given dev person (X-Dev-Principal), the way the tab calls it."""
    headers = {"Content-Type": "application/json", **({"X-Dev-Principal": principal} if principal else {})}
    req = urllib.request.Request(f"{KERNEL}{path}", data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read()
            return r.status, json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]


def project_ids(principal: str) -> set[str]:
    status, out = kernel("GET", "/api/v1/projects", principal)
    return {p["id"] for p in out["projects"]} if status == 200 else set()


def start_agent(data_dir: str) -> subprocess.Popen:
    model = {"AGENT_MODEL": MODEL, "AGENT_MAX_TOOL_CALLS": "12", "AGENT_MAX_SPEND_USD": "0.5"} if MODEL else {"AGENT_MODEL": "scripted", "AGENT_SCRIPT": str(SCRIPT)}
    settings = {"ENV": "test", **model, "AGENT_SANDBOX": "off", "AGENT_PORT": str(AGENT_PORT), "AGENT_DATA_DIR": data_dir, "AGENT_TOKEN": TOKEN, "API_URL": KERNEL, "LOG_LEVEL": "warn"}
    env = {**os.environ, **{P + k: v for k, v in settings.items()}}
    proc = subprocess.Popen(["pnpm", "--filter", "@studio/agent", "start:dev"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def live():
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}/health/live", timeout=2) as r:
            return json.loads(r.read()).get("ok")

    if not wait(live, timeout=60):
        proc.terminate()
        raise RuntimeError(f"agent service didn't start on {AGENT_PORT}:\n{(proc.stdout.read().decode() if proc.stdout else '')[-2000:]}")
    return proc


DROP_JS = """
async ([selector, files]) => {
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  const el = document.querySelector(selector);
  el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
}
"""


def no_consent(page) -> bool:
    """No consent wall: no consent testid and no "Turn on for this browser" button."""
    return page.locator(CONSENT).count() == 0 and page.get_by_role("button", name="Turn on for this browser").count() == 0


def new_person(page, base: str) -> str:
    """Account menu → "Start as a new person": a fresh `user:dev-<id>` for this tab, on an empty Home."""
    page.goto(f"{base}/")
    page.get_by_test_id("user-menu").wait_for(timeout=30000)
    page.get_by_test_id("user-menu").click()
    page.get_by_test_id("dev-new-person").click()
    page.get_by_test_id("home-composer").wait_for(timeout=30000)
    principal = wait(lambda: page.evaluate("() => Object.entries(sessionStorage).find(([k]) => k.endsWith('-dev-principal'))?.[1] ?? null"), timeout=10)
    return principal or ""


def attest(page) -> None:
    dialog = page.get_by_test_id("attestation")
    try:
        dialog.wait_for(timeout=8000)
    except Exception:  # noqa: BLE001 — not asked
        return
    dialog.get_by_role("checkbox").click()
    page.get_by_test_id("attest-confirm").click()


def studio_task(page) -> str | None:
    m = re.search(r"/studio/([^/?#]+)", page.url)
    return m.group(1) if m else None


def empty_home(page, who: str) -> None:
    page.wait_for_load_state("networkidle")
    check(f"{who}: empty Home asks what you're working on", page.locator("[data-testid=home-composer] h2").first.inner_text() == "What are you working on?")
    check(f"{who}: no project cards", page.locator("[data-testid=project-card]").count() == 0)
    check(f"{who}: no Recent projects", page.get_by_text("Recent projects").count() == 0)
    headings = [t.strip() for t in page.locator("[data-testid=project-sidebar] h2").all_inner_texts()]
    check(f"{who}: sidebar has no Recent and no conversations", "Recent" not in headings and not any("onversation" in h for h in headings), str(headings))


def main() -> int:
    global SHOTS
    if "--shots" in sys.argv:
        i = sys.argv.index("--shots")
        SHOTS = Path(sys.argv[i + 1]).resolve()
        del sys.argv[i : i + 2]
    args = parse_args()
    base = f"http://localhost:{args.port}"
    agent_dir = tempfile.mkdtemp(prefix="first-run-agent-e2e-")
    agent = start_agent(agent_dir)
    try:
        status = json.loads(urllib.request.urlopen(f"{base}/api/agent/status", timeout=5).read())
        if (status.get("provider") == "scripted") == bool(MODEL):
            print(f"FAIL the dev server proxies /api/agent elsewhere ({status}); start it with {P}AGENT_URL=http://127.0.0.1:{AGENT_PORT} {P}AGENT_TOKEN={TOKEN}")
            return 1
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            ctx = browser.new_context(viewport={"width": 1440, "height": 900})
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            try:
                run(page, base)
            except Exception as e:  # noqa: BLE001 — report and finish
                shot(page, "journey-crash")
                check("journey ran to the end", False, repr(e)[:400])
            check("no page errors", not errors, "; ".join(errors)[:600])
            ctx.close()
            browser.close()
    finally:
        agent.terminate()
        agent.wait(timeout=20)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    if MODEL:
        print("TIMES " + json.dumps({k: round(v, 1) for k, v in TIMES.items()}))
        for f in sorted(Path(agent_dir).rglob("*.json")):
            rec = json.loads(f.read_text())
            if isinstance(rec, dict) and rec.get("usage"):
                print("RUN " + json.dumps({"status": rec.get("status"), "toolCalls": rec.get("toolCalls"), "usage": rec["usage"]}))
    return 1 if failed else 0


def run(page, base: str) -> None:
    # ---- 1. A new person types a task on an empty Home ----------------------------------------
    first = new_person(page, base)
    check("person 1: a fresh user:dev-<id>", first.startswith("user:dev-"), first)
    empty_home(page, "person 1")
    before = project_ids(first)
    box = page.get_by_test_id("goal")
    box.fill(GOAL)
    t0 = time.time()
    box.press("Enter")
    made = wait(lambda: [p for p in project_ids(first) if p not in before], timeout=30)
    check("J2: the send creates a project", bool(made), str(made))
    if not made:
        return
    try:
        page.wait_for_url("**/studio/**", timeout=45000)
    except Exception:  # noqa: BLE001
        shot(page, "j2-no-studio")
    task = studio_task(page)
    TIMES["J2 studio s"] = time.time() - t0
    check("J2: a Studio opens", bool(task), page.url)
    check("J2: no consent screen after the first send", no_consent(page))
    if task:
        env_of = lambda: json.dumps(kernel("GET", f"/api/environments/{task}", first)[1])  # noqa: E731
        wait(lambda: all(f'"{x}"' in env_of().lower() for x in LABELS), timeout=120 if MODEL else 60)
        TIMES["J2 labels s"] = time.time() - t0
        env = env_of()
        labels = [x for x in LABELS if f'"{x}"' in env.lower()]
        check("J2: the Studio has the five labels", len(labels) == 5, str(labels))
    log = page.get_by_test_id("agent-log")
    if log.count():
        check("J2: the assistant panel shows the conversation, not a consent wall", log.first.is_visible() and no_consent(page))
    shot(page, "j2-studio")

    # ---- 2. The same person drops 12 PNGs on Home, with no text --------------------------------
    before = project_ids(first)
    page.goto(f"{base}/")
    page.get_by_test_id("home-composer").wait_for(timeout=30000)
    files = [{"name": f"cxr_{i:02d}.png", "type": "image/png", "b64": base64.b64encode(png(i)).decode()} for i in range(12)]
    t1 = time.time()
    page.evaluate(DROP_JS, ["[data-testid=home-composer]", files])
    target = page.get_by_test_id("home-target-new")
    try:
        target.wait_for(timeout=2500)
        target.click()
    except Exception:  # noqa: BLE001 — Home asks only when it has projects
        pass
    attest(page)
    made = wait(lambda: [p for p in project_ids(first) if p not in before], timeout=30)
    check("J1: the drop creates a project", bool(made), str(made))
    if not made:
        return
    pid = made[0]
    try:
        page.wait_for_url("**/studio/**", timeout=60000)
    except Exception:  # noqa: BLE001
        shot(page, "j1-no-studio")
    task = studio_task(page)
    TIMES["J1 studio s"] = time.time() - t1
    check("J1: the Studio opens on the first ready image", bool(task), page.url)
    check("J1: no consent screen", no_consent(page))
    if task:
        status, t = kernel("GET", f"/api/v1/tasks/{task}", first)
        ds_id = t.get("datasetId") if status == 200 else None
        check("J1: the Studio has a dataset", bool(ds_id), str(t)[:200])
        summaries = kernel("GET", f"/api/v1/projects/{pid}/dataset-summaries", first)[1]
        check("J1: the dataset is in Datasets", bool(ds_id) and ds_id in json.dumps(summaries), json.dumps(summaries)[:200])
    # The empty-text drop message is sent: the drop card and an assistant reply in the chat.
    # Home opens the project with the drawer; open it only if it really isn't there (a click on an
    # open drawer's toggle would close it).
    if not wait(lambda: page.get_by_test_id("agent-log").count() > 0, timeout=10):
        page.get_by_label(f"{AI} panel").click()
    card = page.get_by_test_id("user-drop").get_by_test_id("drop-card")
    try:
        card.wait_for(timeout=30000)
        check("J1: the chat shows the drop card", card.get_by_test_id("drop-chip").count() == 12, str(card.get_by_test_id("drop-chip").count()))
    except Exception:  # noqa: BLE001
        check("J1: the chat shows the drop card", False)
    # A finished assistant turn carries its usage line (model · tokens) under the reply.
    reply = page.get_by_test_id("agent-log").get_by_test_id("agent-usage")
    check("J1: the assistant replies to the drop", bool(wait(lambda: reply.count() > 0, timeout=120 if MODEL else 45)), str(reply.count()))
    TIMES["J1 reply s"] = time.time() - t1
    check("J1: still no consent screen", no_consent(page))
    shot(page, "j1-studio")

    # ---- 3. Another new person on the same browser: nothing of person 1 ------------------------
    second = new_person(page, base)
    check("person 2: a different user:dev-<id>", second.startswith("user:dev-") and second != first, f"{first} → {second}")
    empty_home(page, "person 2")
    check("person 2: no projects from the api", not project_ids(second), str(project_ids(second)))
    titles = [p.get("title") for p in (kernel("GET", "/api/v1/projects", first)[1] or {}).get("projects", []) if p.get("title")]
    shown = page.locator("[data-testid=project-sidebar]").inner_text()
    check("person 2: none of person 1's projects or conversations in the sidebar", not any(t in shown for t in titles), f"{titles} in {shown[:300]!r}")
    try:
        page.get_by_label(f"{AI} panel").click(timeout=5000)
        page.wait_for_timeout(500)
    except Exception:  # noqa: BLE001 — Home without an assistant toggle: nothing to open
        pass
    check("person 2: the assistant has no conversation of person 1", page.get_by_test_id("drop-card").count() == 0 and page.get_by_text(GOAL).count() == 0)
    shot(page, "person2-home")


if __name__ == "__main__":
    sys.exit(main())
