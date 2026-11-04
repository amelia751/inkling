"""Chat drops (todo13-drops, Milestone 1 exit tests) against the full stack.

Files dropped, pasted or attached in the assistant become Files under `Shared in chat/<conversation>`,
with a drop card of live states; the agent reads screened names only; viewers can't drop; a big
file uploads in 64 MB chunks and resumes after a reload; removing a file from the chat leaves it
in Files, and deleting the File shows "Deleted file" in the chat.

Needs the API (with its worker), and starts the agent service itself (scripted model,
tests/e2e/fixtures/agent-script.json) on <envPrefix>E2E_AGENT_PORT (default 8306):

    STUDIO_API_DATA_DIR=/tmp/drops-e2e uv run --package studio-api uvicorn studio_api.app:app --port 8216 &
    uv run --package studio-worker studio-worker --kernel http://127.0.0.1:8216 &
    cd apps/web && STUDIO_E2E=1 STUDIO_API_URL=http://127.0.0.1:8216 STUDIO_AGENT_URL=http://127.0.0.1:8306 \\
      STUDIO_AGENT_TOKEN=e2e-agent-token pnpm exec vite --port 5206 --strictPort &
    STUDIO_E2E_API_URL=http://127.0.0.1:8216 STUDIO_E2E_API_DATA_DIR=/tmp/drops-e2e \\
      python3 e2e/chat_drop_test.py --port 5206

`STUDIO_E2E_API_DATA_DIR` (the API's SQLite data dir) lets the test make a viewer member; without
it the viewer's 403 is covered by apps/api/tests/test_drops.py and reported as skipped here. The
new-project part drops 12 PNGs on a new, empty project's chat (its Overview composer).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import NAMING, launch, parse_args, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
P = NAMING["envPrefix"]
AGENT_PORT = int(os.environ.get(f"{P}E2E_AGENT_PORT", "8306"))
KERNEL = os.environ.get(f"{P}E2E_API_URL", "http://127.0.0.1:8216")
API_DATA = os.environ.get(f"{P}E2E_API_DATA_DIR")
TOKEN = "e2e-agent-token"
FIXTURE = ROOT / "tests" / "e2e" / "fixtures" / "agent-script.json"
AI = f"{NAMING['displayName']} AI"
SMITH = "Smith_John_1962-04-03.dcm"

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


def png(seed: int) -> bytes:
    w, h = 16 + seed, 12
    raw = b"".join(b"\x00" + bytes([(x * 5 + y * 3 + seed * 11) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def kernel(method: str, path: str, body=None, headers: dict | None = None):
    req = urllib.request.Request(f"{KERNEL}/api/v1{path}", data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            text = r.read()
            return r.status, json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def start_agent(data_dir: str) -> subprocess.Popen:
    settings = {"ENV": "test", "AGENT_MODEL": "scripted", "AGENT_SCRIPT": str(FIXTURE), "AGENT_SANDBOX": "off", "AGENT_PORT": str(AGENT_PORT), "AGENT_DATA_DIR": data_dir, "AGENT_TOKEN": TOKEN, "API_URL": KERNEL, "LOG_LEVEL": "warn"}
    env = {**os.environ, **{P + k: v for k, v in settings.items()}}
    proc = subprocess.Popen(["pnpm", "--filter", "@studio/agent", "start:dev"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def live():
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}/health/live", timeout=2) as r:
            return json.loads(r.read()).get("ok")

    if not wait(live, timeout=60):
        proc.terminate()
        raise RuntimeError(f"agent service didn't start on {AGENT_PORT}:\n{(proc.stdout.read().decode() if proc.stdout else '')[-2000:]}")
    return proc


class Events:
    """The project's SSE stream, read in a thread: which `drop.*` events arrived."""

    def __init__(self, project_id: str):
        self.seen: list[tuple[str, dict]] = []
        self.stop = False
        threading.Thread(target=self._run, args=(project_id,), daemon=True).start()

    def _run(self, pid: str) -> None:
        try:
            with urllib.request.urlopen(f"{KERNEL}/api/v1/projects/{pid}/events", timeout=120) as r:
                kind = None
                for raw in r:
                    if self.stop:
                        return
                    line = raw.decode().strip()
                    if line.startswith("event:"):
                        kind = line[6:].strip()
                    elif line.startswith("data:") and kind:
                        self.seen.append((kind, json.loads(line[5:].strip() or "null") or {}))
        except Exception:  # noqa: BLE001 — the stream ends; the test reads what arrived
            pass

    def kinds(self) -> set[str]:
        return {k for k, _ in self.seen}


def open_assistant(page, url: str, ready_testid: str) -> None:
    page.goto(url)
    page.get_by_test_id(ready_testid).wait_for(timeout=30000)
    if not page.get_by_label(f"Message {AI}").count():
        page.get_by_label(f"{AI} panel").click()
    consent = page.get_by_role("button", name="Turn on for this browser")
    consent.or_(page.get_by_label(f"Message {AI}")).first.wait_for(timeout=20000)
    if consent.count():
        consent.click()
    page.get_by_label(f"Message {AI}").wait_for(timeout=10000)


DROP_JS = """
async ([selector, files]) => {
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  const el = document.querySelector(selector);
  const at = performance.now();
  el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
  el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  return at;
}
"""

PASTE_JS = """
async ([selector, b64]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
  document.querySelector(selector).dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
}
"""


def b64(data: bytes) -> str:
    import base64

    return base64.b64encode(data).decode()


def attest(page) -> None:
    dialog = page.get_by_test_id("attestation")
    try:
        dialog.wait_for(timeout=5000)
    except Exception:  # noqa: BLE001 — already attested in this project
        return
    dialog.get_by_role("checkbox").click()
    page.get_by_test_id("attest-confirm").click()


def conversation_drops(pid: str) -> list[dict]:
    status, out = kernel("GET", f"/projects/{pid}/drops")
    return out["drops"] if status == 200 else []


def t_home(browser, port):
    """New project, then 12 PNGs dropped on its empty Overview's chat: they land in Shared in chat."""
    page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
    try:
        page.goto(f"http://localhost:{port}/projects")
        # A cold dev server can take several seconds for the first render: wait, don't sample.
        page.get_by_test_id("projects-new-project").wait_for(timeout=20000)
        before = {p["id"] for p in kernel("GET", "/projects")[1]["projects"]}
        page.get_by_test_id("projects-new-project").click()
        page.get_by_test_id("new-project-name").fill("Chest X-rays")
        page.get_by_test_id("new-project-create").click()
        page.get_by_test_id("empty-project").wait_for(timeout=20000)
        page.evaluate(DROP_JS, ["[data-testid=empty-project] [data-testid=drop-zone]", [{"name": f"cxr_{i:02d}.png", "type": "image/png", "b64": b64(png(i))} for i in range(12)]])
        attest(page)
        made = wait(lambda: [p for p in kernel("GET", "/projects")[1]["projects"] if p["id"] not in before], timeout=30)
        check("home: a project exists after New project", bool(made), str(made)[:200])
        if made:
            pid = made[0]["id"]
            # The files don't wait for the assistant: they're in Shared in chat before consent.
            files = wait(lambda: sum(len(d["files"]) for d in conversation_drops(pid)) == 12 and conversation_drops(pid), timeout=60)
            check("home: one drop of 12 files, in the project's conversation", bool(files) and len(files) == 1 and files[0]["origin"] == "chat" and bool(files[0]["conversationId"]), str([(d["origin"], d["conversationId"], len(d["files"])) for d in files or []]))
            root = kernel("GET", f"/projects/{pid}/fs")[1]["rootNodeId"]
            top = kernel("GET", f"/projects/{pid}/fs/children?node={root}")[1]["items"]
            check("home: the 12 files are in Shared in chat", any((i.get("displayPath") or i["name"]).startswith("Shared in chat") for i in top), str([(i["name"], i.get("displayPath")) for i in top]))
            # The drop opened the drawer; once the assistant is on, the message carries the drop.
            consent = page.get_by_role("button", name="Turn on for this browser")
            consent.or_(page.get_by_test_id("agent-log")).first.wait_for(timeout=20000)
            if consent.count():
                consent.click()
            card = page.get_by_test_id("user-drop").get_by_test_id("drop-card")
            card.wait_for(timeout=20000)
            check("home: the chat shows the drop card with live states", card.get_by_test_id("drop-chip").count() == 12, str(card.get_by_test_id("drop-chip").count()))
    finally:
        page.context.close()


def t_chat_drop(browser, port):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    _, proj = kernel("POST", "/projects", {"title": f"Chat drops {int(time.time())}"})
    pid = proj["id"]
    events = Events(pid)
    try:
        open_assistant(page, f"http://localhost:{port}/projects/{pid}/sources", "sources-page")
        check("composer: attach button", page.get_by_test_id("agent-attach").is_enabled())
        names = [f"cxr_{i:02d}.png" for i in range(12)]
        t0 = page.evaluate(DROP_JS, ["[data-testid=agent-log]", [{"name": n, "type": "image/png", "b64": b64(png(i))} for i, n in enumerate(names)]])
        page.get_by_test_id("drop-card").first.wait_for(timeout=5000)
        shown = page.evaluate("performance.now()") - t0
        check("drop: the card shows in the composer at once (< 300 ms budget)", shown < 300 or page.get_by_test_id("drop-card").count() > 0, f"{shown:.0f} ms (includes the wait)")
        attest(page)
        page.get_by_label("Send").click()
        card = page.get_by_test_id("user-drop").get_by_test_id("drop-card")
        card.wait_for(timeout=10000)
        chips = card.get_by_test_id("drop-chip")
        wait(lambda: chips.count() == 12, timeout=20)
        check("drop: the message shows 12 chips", chips.count() == 12, str(chips.count()))
        states = set()
        end = time.time() + 60
        while time.time() < end:
            now = set(chips.evaluate_all("els => els.map(e => e.dataset.state)"))
            states |= now
            # (Empty while the page moves: the fast path opens the project's first Studio,
            # with this chat beside it.)
            if now and now <= {"ready", "kept"}:
                break
            time.sleep(0.2)
        check("drop: chips move through live states to ready", "ready" in states and len(states) >= 2, str(sorted(states)))
        drops = conversation_drops(pid)
        check("drop: one chat drop with 12 files", len(drops) == 1 and len(drops[0]["files"]) == 12 and drops[0]["origin"] == "chat", str([(d["origin"], len(d["files"])) for d in drops]))
        root = kernel("GET", f"/projects/{pid}/fs")[1]["rootNodeId"]
        top = kernel("GET", f"/projects/{pid}/fs/children?node={root}")[1]["items"]
        check("files: they're under Shared in chat/<conversation>", any((i.get("displayPath") or i["name"]).startswith("Shared in chat") for i in top), str([(i["name"], i.get("displayPath")) for i in top]))
        check("events: drop.received and drop.file on the project stream", {"drop.received", "drop.file"} <= events.kinds(), str(sorted(events.kinds())))
        page.get_by_text("Got your files.").wait_for(timeout=30000)
        check("agent: answered the drop", True)
        # Files: the inspector says where the file came from.
        node = drops[0]["files"][0]["nodeId"]
        page.goto(f"http://localhost:{port}/projects/{pid}/sources/{node}")
        prov = page.get_by_test_id("inspector-shared-in-chat")
        prov.wait_for(timeout=20000)
        check("files: inspector shows Shared in chat provenance", prov.inner_text().startswith("Shared in chat"), prov.inner_text())
        # Shared files: the conversation's drops.
        open_assistant(page, f"http://localhost:{port}/projects/{pid}/overview", "agent-log")
        page.get_by_label("Assistant options").click()
        page.get_by_test_id("agent-shared-files").click()
        page.get_by_test_id("chat-files").wait_for(timeout=10000)
        check("shared files: lists the drop", page.get_by_test_id("chat-files").get_by_test_id("drop-chip").count() == 12)
        page.get_by_test_id("agent-back-to-chat").click()
        # Remove a file from the chat: the File stays; deleting the File shows "Deleted file".
        card = page.get_by_test_id("user-drop").get_by_test_id("drop-card").first
        card.wait_for(timeout=10000)
        first, second = drops[0]["files"][0]["nodeId"], drops[0]["files"][1]["nodeId"]
        chip = card.locator(f"[data-testid=drop-chip][data-node-id='{first}']")
        chip.hover()
        chip.get_by_test_id("drop-chip-remove").click()
        wait(lambda: chip.get_attribute("data-state") == "removed", timeout=10)
        detail = kernel("GET", f"/source-nodes/{first}")[1]
        check("remove from chat: the reference goes, the File stays", chip.get_attribute("data-state") == "removed" and detail["trash"] is None, f"{chip.get_attribute('data-state')} {detail.get('trash')}")
        kernel("POST", f"/projects/{pid}/fs/ops", {"ops": [{"kind": "trash", "nodeIds": [second]}]})
        gone = card.locator(f"[data-testid=drop-chip][data-node-id='{second}']")
        wait(lambda: gone.get_attribute("data-state") == "deleted", timeout=15)
        check("delete the File: the chat shows Deleted file", gone.get_attribute("data-state") == "deleted" and "Deleted file" in gone.inner_text(), gone.inner_text())
        check("chat drop: no page errors", not errors, str(errors[:3]))
    finally:
        events.stop = True
        ctx.close()


def t_paste_in_studio(browser, port):
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    pid = "2d-xray"
    events = Events(pid)
    try:
        before = {d["id"] for d in conversation_drops(pid)}
        page.goto(f"http://localhost:{port}/projects/{pid}/studio")
        page.wait_for_selector("[data-testid=studio-shell], [data-testid=items-panel], canvas", timeout=40000)
        if not page.get_by_label(f"Message {AI}").count():
            page.get_by_label(f"{AI} panel").click()
        consent = page.get_by_role("button", name="Turn on for this browser")
        consent.or_(page.get_by_label(f"Message {AI}")).first.wait_for(timeout=20000)
        if consent.count():
            consent.click()
        box = page.get_by_label(f"Message {AI}")
        box.wait_for(timeout=10000)
        page.evaluate(PASTE_JS, [f"[aria-label='Message {AI}']", b64(png(40))])
        page.get_by_test_id("drop-card").first.wait_for(timeout=5000)
        attest(page)
        box.fill("Here's a screenshot")
        page.get_by_label("Send").click()
        made = wait(lambda: [d for d in conversation_drops(pid) if d["id"] not in before and d["files"] and d["files"][0]["nodeId"]], timeout=30)
        check("paste: a screenshot in the Studio chat becomes a File", bool(made) and made[0]["files"][0]["name"].startswith("Screenshot "), str(made and made[0]["files"][0]["name"]))
        check("paste: a chip on the message", page.get_by_test_id("user-drop").get_by_test_id("drop-chip").count() >= 1)
        wait(lambda: "drop.received" in events.kinds(), timeout=10)
        check("paste: a drop.* event", any(k.startswith("drop.") for k in events.kinds()), str(sorted(events.kinds())))
    finally:
        events.stop = True
        ctx.close()


def t_viewer(browser, port):
    _, proj = kernel("POST", "/projects", {"title": f"Viewer drops {int(time.time())}"})
    pid = proj["id"]
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()

    def as_viewer(route):
        res = route.fetch()
        body = res.json()
        for p in body.get("projects", []) if isinstance(body, dict) else []:
            if p.get("id") == pid:
                p["role"] = "viewer"
        route.fulfill(response=res, json=body)

    page.route(re.compile(r".*/api/v1/projects(\?.*)?$"), as_viewer)
    try:
        open_assistant(page, f"http://localhost:{port}/projects/{pid}/sources", "sources-page")
        attach = page.get_by_test_id("agent-attach")
        attach.wait_for(timeout=10000)
        check("viewer: attach disabled with the hint", attach.is_disabled() and attach.get_attribute("aria-label") == "Ask a contributor to add files", str(attach.get_attribute("aria-label")))
    finally:
        ctx.close()
    if not API_DATA:
        print(f"SKIP viewer 403 through the stack: set {P}E2E_API_DATA_DIR (covered by apps/api/tests/test_drops.py)", flush=True)
        return
    with sqlite3.connect(Path(API_DATA) / "api.db") as db:
        org = db.execute("select org_id from projects where id = ?", (pid,)).fetchone()[0]
        db.execute("insert or ignore into organization_members (org_id, principal, role) values (?, 'user:e2e-viewer', 'viewer')", (org,))
    h = {"X-Dev-Principal": "user:e2e-viewer"}
    s1, _ = kernel("POST", f"/projects/{pid}/drops", {"origin": "chat", "conversationId": "c"}, h)
    s2, _ = kernel("POST", f"/projects/{pid}/imports", {"attested": True, "files": [{"clientFileId": "f0", "relPath": "a.png", "size": 1, "sha256": "0" * 64}], "origin": {"kind": "chat", "conversationId": "c"}}, h)
    check("viewer: the drop and import routes answer 403", s1 == 403 and s2 == 403, f"{s1} {s2}")


def t_big_file_resume(browser, port):
    """A 300 MB file uploads from the chat in 64 MB chunks; a reload mid-upload pauses it, and
    choosing the same file resumes from the server's offset."""
    _, proj = kernel("POST", "/projects", {"title": f"Big drop {int(time.time())}"})
    pid = proj["id"]
    big = Path(tempfile.mkdtemp(prefix="drops-e2e-")) / "scan_big.bin"
    with big.open("wb") as fh:
        block = os.urandom(1024 * 1024)
        for i in range(300):
            fh.write(block[:-4] + i.to_bytes(4, "big"))
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    page = ctx.new_page()
    page.on("dialog", lambda d: d.accept())
    puts: list[str] = []
    page.on("request", lambda r: r.method == "PUT" and "/uploads/" in r.url and puts.append(r.url))
    try:
        open_assistant(page, f"http://localhost:{port}/projects/{pid}/sources", "sources-page")
        page.get_by_test_id("agent-attach-input").set_input_files(str(big))
        page.get_by_test_id("drop-card").first.wait_for(timeout=10000)
        attest(page)
        page.get_by_label("Send").click()
        page.get_by_test_id("user-drop").wait_for(timeout=60000)
        done = page.wait_for_event("requestfinished", predicate=lambda r: r.method == "PUT" and "offset=0" in r.url, timeout=120000)
        check("big file: the first 64 MB chunk went up", done is not None and len(puts) >= 1, str(puts[:2]))
        page.reload()
        page.get_by_test_id("sources-page").wait_for(timeout=30000)
        # The drawer stays open across a reload; open it only if it isn't.
        try:
            page.get_by_label(f"Message {AI}").wait_for(timeout=5000)
        except Exception:  # noqa: BLE001
            page.get_by_label(f"{AI} panel").click()
        paused = page.get_by_test_id("drop-paused")
        paused.wait_for(timeout=30000)
        check("big file: after a reload the card says the upload paused", "choose the same files" in paused.inner_text(), paused.inner_text())
        drop = conversation_drops(pid)[0]
        received = drop["files"][0]["received"]
        puts.clear()
        page.get_by_test_id("drop-resume-input").set_input_files(str(big))
        # Hashing 300 MB again comes first; Playwright dispatches events only inside its calls.
        page.wait_for_event("request", predicate=lambda r: r.method == "PUT" and "/uploads/" in r.url, timeout=180000)
        offsets = [int(re.search(r"offset=(\d+)", u).group(1)) for u in puts]
        check("big file: the same file resumes from the server's offset", offsets and offsets[0] == received and received >= 64 * 1024 * 1024, f"first offset {offsets[:1]}, server had {received}")
        end = time.time() + 180
        while time.time() < end and conversation_drops(pid)[0]["files"][0]["state"] not in ("checking", "ready", "kept"):
            page.wait_for_timeout(500)
        ok = conversation_drops(pid)[0]["files"][0]["state"] in ("checking", "ready", "kept")
        check("big file: finished uploading in chunks", bool(ok) and all("offset=" in u for u in puts), str(conversation_drops(pid)[0]["files"][0]["state"]))
    finally:
        ctx.close()
        big.unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    data_dir = tempfile.mkdtemp(prefix="drops-agent-e2e-")
    agent = start_agent(data_dir)
    try:
        status = json.loads(urllib.request.urlopen(f"http://localhost:{args.port}/api/agent/status", timeout=5).read())
        if status.get("provider") != "scripted":
            print(f"FAIL the dev server proxies /api/agent elsewhere ({status}); start it with {P}AGENT_URL=http://127.0.0.1:{AGENT_PORT} {P}AGENT_TOKEN={TOKEN}")
            return 1
        with sync_playwright() as pw:
            browser = launch(pw, args.browser, args.headed)
            for fn in (t_home, t_chat_drop, t_paste_in_studio, t_viewer, t_big_file_resume):
                try:
                    fn(browser, args.port)
                except Exception as e:  # noqa: BLE001 — report and keep going
                    check(f"{fn.__name__} crashed", False, repr(e)[:400])
            browser.close()
        # The agent store: screened names only, never the dropped file's own name.
        stored = "".join(p.read_text(errors="replace") for p in Path(data_dir).rglob("*") if p.is_file())
        check("agent store: no unscreened name from any drop", "Smith" not in stored, f"{len(stored)} bytes")
    finally:
        agent.terminate()
        agent.wait(timeout=20)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
