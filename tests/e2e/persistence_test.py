"""Everything a signed-in person makes is saved on the server (todo/todo22.md §3 Acceptance).

Against WorkOS Emulate with the api, the agent and Vite in `workos` mode (tests/e2e/auth/stack.py,
the agent on the scripted model with tests/e2e/fixtures/persistence-script.json: no real model):

  1. A (member@example.com, Acme) signs in, makes a project, drops synthetic files, opens two
     chats (one in the browser, whose run draws a card; one over HTTP), renames one, changes the
     Studio layout and a preference, annotates an item, then signs out.
  2. A fresh browser context (empty storage) signs in as A and sees all of it, cards included.
  3. B (admin@example.com, signed into Globex) sees none of it.
  4. The api and the agent restart (same database and agent store); A still sees all of it.

    python3 tests/e2e/persistence_test.py                    # starts and stops its own stack
    python3 tests/e2e/persistence_test.py --headed --keep    # watch it; leave logs in place

Ports: <envPrefix>E2E_AUTH_PORT_BASE (default here 8207): Emulate, api +1, Vite +2, agent +3.

Checks are tagged by what they depend on. Untagged ones hold on `main` today; `[W3]` needs
server-side person prefs (`layout:<project>:<task>` keys, the theme read from `/v1/me/prefs`),
`[W4]` needs the browser-made thread parts recorded as `ui_part` run events and the session
fields `notes`/`profile`/`last_opened_at`. `--strict-pending` makes those failures count; by
default they print as PENDING and don't fail the run, so the test can land before W3/W4 do.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAMING = json.loads((ROOT / "schemas" / "naming.json").read_text())
P = NAMING["envPrefix"]
os.environ.setdefault(f"{P}E2E_AUTH_PORT_BASE", "8207")
sys.path.insert(0, str(ROOT / "tests" / "e2e" / "auth"))
sys.path.insert(0, str(ROOT / "tests" / "e2e" / "fixtures"))
sys.path.insert(0, str(ROOT / "apps" / "web" / "e2e"))
from mixed_drop import png  # noqa: E402
from stack import GLOBEX, USERS, AuthStack, playwright_cookie  # noqa: E402

SCRIPT = ROOT / "tests" / "e2e" / "fixtures" / "persistence-script.json"
AI = f"{NAMING['displayName']} AI"
PROJECT_TITLE = "Persistence e2e"
RENAMED = "Renamed persistence chat"
CARD_TITLE = "Persistence notes"  # the draft_document card the scripted run draws
THEME = "dark"
LAYOUT = {"version": 1, "panels": {"left": 22, "right": 31}, "e2e": "persistence"}
FILES = {"persist/scan-a.png": png(101), "persist/scan-b.png": png(102), "persist/notes.csv": b"id,label\n1,a\n2,b\n"}

results: list[tuple[str, str, bool, str]] = []  # (group, name, ok, detail)


def check(name: str, ok: bool, detail: str = "", group: str = "") -> bool:
    results.append((group, name, ok, detail))
    tag = "PASS" if ok else ("PENDING" if group else "FAIL")
    print(f"{tag} {f'[{group}] ' if group else ''}{name}" + (f" — {detail}" if detail and not ok else ""), flush=True)
    return ok


def call(base: str, method: str, path: str, cookie: str | None, body: object | None = None, raw: bytes | None = None, headers: dict | None = None) -> tuple[int, object]:
    h = {"X-Requested-With": "fetch", **(headers or {})}
    if cookie:
        h["Cookie"] = cookie
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    url = path if path.startswith("http") else base + path
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
            try:
                return r.status, json.loads(text) if text else None
            except ValueError:
                return r.status, text.decode(errors="replace")
    except urllib.error.HTTPError as e:
        text = e.read()
        try:
            return e.code, json.loads(text) if text else None
        except ValueError:
            return e.code, text.decode(errors="replace")[:400]


def wait(fn, timeout: float = 30.0, every: float = 0.5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = fn()
        except Exception:  # noqa: BLE001 — not yet
            v = None
        if v:
            return v
        time.sleep(every)
    return None


class Person:
    """One signed-in person talking to the stack over HTTP (through Vite, as the browser does)."""

    def __init__(self, st: AuthStack, cookie: str):
        self.st, self.cookie = st, cookie

    def __call__(self, method: str, path: str, body: object | None = None, **kw) -> tuple[int, object]:
        return call(self.st.base, method, path, self.cookie, body, **kw)

    def ok(self, method: str, path: str, body: object | None = None, **kw):
        status, out = self(method, path, body, **kw)
        if status >= 300:
            raise RuntimeError(f"{method} {path} → {status}: {out}")
        return out


# ---- Step 1: A makes things ----------------------------------------------------------------------


def upload(a: Person, pid: str, files: dict[str, bytes]) -> dict:
    """The import route as the browser drives it (attested), then wait for inspection."""
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = a.ok("POST", f"/api/v1/projects/{pid}/imports", body)
    for f in s["files"]:
        if f.get("uploadUrl"):
            data = next(d for rel, d in files.items() if rel.endswith(f["relPath"]))
            url = f["uploadUrl"] if f["uploadUrl"].startswith("http") else a.st.base + f["uploadUrl"]
            a.ok("PUT", url, raw=data, headers={"Content-Type": "application/octet-stream"})
    a.ok("POST", f"/api/v1/imports/{s['id']}/complete", {})
    return wait(lambda: (lambda x: x if x["state"] not in ("uploading", "inspecting") else None)(a.ok("GET", f"/api/v1/imports/{s['id']}")), timeout=90) or s


def file_nodes(a: Person, pid: str) -> dict[str, str]:
    """Every file under the project's Files tree, name → node id (breadth-first over fs/children)."""
    out: dict[str, str] = {}
    queue: list[str | None] = [None]
    while queue and len(out) < 500:
        node = queue.pop(0)
        status, page = a("GET", f"/api/v1/projects/{pid}/fs/children" + (f"?node={node}" if node else ""))
        if status != 200 or not isinstance(page, dict):
            continue
        for n in page.get("items", []):
            if n.get("kind") == "folder":
                queue.append(n["id"])
            else:
                out[n["name"]] = n["id"]
    return out


def file_names(a: Person, pid: str) -> set[str]:
    return set(file_nodes(a, pid))


def open_drawer(page) -> None:
    """The assistant drawer, open and turned on (as tests/e2e/journey_test.py)."""
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
            except Exception:  # noqa: BLE001 — animating
                pass
        page.wait_for_timeout(250)
    box.first.wait_for(timeout=1000)


def show_chat_list(page) -> None:
    """The chat list: the rail when the panel is wide, else the switcher's menu."""
    items = page.get_by_test_id("agent-chat-item")
    if items.count() and items.first.is_visible():
        return
    rail = page.get_by_test_id("agent-chat-rail-toggle")
    if rail.count() and rail.first.is_visible() and rail.first.get_attribute("aria-pressed") != "true":
        rail.first.click()
        page.wait_for_timeout(300)
    if not (items.count() and items.first.is_visible()):
        page.get_by_test_id("agent-chat-switcher").first.click()
    items.first.wait_for(timeout=10000)


def step1(st: AuthStack, browser, out: Path, headed: bool) -> dict:
    cookie = st.sign_in(*USERS["member"])
    a = Person(st, cookie)
    made = a.ok("POST", "/api/v1/projects", {"title": PROJECT_TITLE})
    pid = made["id"]
    # A project without a dataset has no task yet; the legacy routes then scope to the project id.
    task = made.get("defaultTaskId") or a.ok("GET", f"/api/v1/projects/{pid}").get("defaultTaskId") or pid
    check("1: A makes a project", bool(pid), str(made)[:200])

    imp = upload(a, pid, FILES)
    names = wait(lambda: (lambda n: n if {"scan-a.png", "scan-b.png"} <= n else None)(file_names(a, pid)), timeout=60) or file_names(a, pid)
    check("1: A drops synthetic files into the project", {"scan-a.png", "scan-b.png"} <= names, f"import {imp.get('state')}, drops list {sorted(names)}")

    # Chat 1 in the browser: the scripted run calls draft_document, the browser draws the card.
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_cookies([playwright_cookie(cookie, st.origin)])
    page = ctx.new_page()
    page.goto(f"{st.origin}/projects/{pid}/overview")
    chat1 = None
    try:
        open_drawer(page)
        box = page.get_by_label(f"Message {AI}").first
        box.fill("persistence card please")
        box.press("Enter")
        page.get_by_text(CARD_TITLE).first.wait_for(timeout=45000)
        check("1: chat 1 (browser) shows the card the run drew", True)
    except Exception as e:  # noqa: BLE001
        page.screenshot(path=str(out / "step1-chat1.png"))
        check("1: chat 1 (browser) shows the card the run drew", False, f"{type(e).__name__}: {str(e)[:200]}")
    sessions = wait(lambda: a.ok("GET", f"/api/agent/sessions?projectId={pid}")["sessions"], timeout=20) or []
    chat1 = sessions[0]["id"] if sessions else None
    check("1: chat 1 is a server session", bool(chat1), str(sessions)[:200])

    # Chat 2 over HTTP, answered by the scripted model, then renamed.
    status, created = a("POST", "/api/agent/sessions", {"projectId": pid, "profile": "assistant"})
    chat2 = created.get("sessionId") if isinstance(created, dict) else None
    check("1: A opens a second chat", status == 201 and bool(chat2), f"{status} {created}")
    if chat2:
        a.ok("POST", f"/api/agent/sessions/{chat2}/messages", {"text": "second chat hello"})
        answered = wait(lambda: any("Second chat answered" in json.dumps(m) for m in a.ok("GET", f"/api/agent/sessions/{chat2}/thread")["messages"]), timeout=45)
        check("1: the second chat's run answers (scripted model)", bool(answered))
        status, renamed = a("PATCH", f"/api/agent/sessions/{chat2}", {"title": RENAMED})
        check("1: A renames the second chat", status == 200, f"{status} {renamed}")

    # Studio layout and a preference, as person prefs on the server.
    status, body = a("PUT", "/api/v1/me/prefs/theme", {"value": THEME})
    check("1: A sets a preference (theme)", status == 200, f"{status} {body}")
    status, body = a("PUT", f"/api/v1/me/prefs/layout:{pid}:{task}", {"value": LAYOUT})
    check("1: A saves the Studio layout as layout:<project>:<task>", status == 200, f"{status} {body}", group="W3")

    # Annotate an item (the Studio's autosave route).
    item = file_nodes(a, pid).get("scan-a.png") or "scan-a.png"
    ann = {"id": "ann-persist-1", "itemId": item, "label": "finding", "provenance": "human-created", "author": "user:e2e", "createdAt": "2026-11-03T00:00:00Z", "geometry": {"type": "box", "x": 2, "y": 2, "w": 8, "h": 6}}
    status, doc = a("GET", f"/api/annotations/{task}")
    doc = doc if status == 200 and isinstance(doc, dict) else {}
    status, saved = a("PUT", f"/api/annotations/{task}", {"revision": doc.get("revision", 0), "annotations": [*doc.get("annotations", []), ann]})
    check("1: A annotates an item", status == 200, f"{status} {str(saved)[:300]}")

    # Sign out: the session cookie is cleared and stops working.
    status, body = a("POST", "/api/auth/logout")
    check("1: A signs out", status == 200, f"{status} {body}")
    ctx.close()
    return {"pid": pid, "task": task, "chat1": chat1, "chat2": chat2, "ann": ann["id"]}


# ---- Steps 2 and 4: a fresh browser sees all of it -----------------------------------------------


def sees_everything(st: AuthStack, browser, made: dict, label: str, out: Path) -> None:
    cookie = st.sign_in(*USERS["member"])
    a = Person(st, cookie)
    pid, task = made["pid"], made["task"]

    projects = a.ok("GET", "/api/v1/projects")["projects"]
    check(f"{label}: A's project is listed", any(p["id"] == pid for p in projects))
    names = file_names(a, pid)
    check(f"{label}: the dropped files are there", {"scan-a.png", "scan-b.png"} <= names, str(sorted(names)))

    sessions = a.ok("GET", f"/api/agent/sessions?projectId={pid}")["sessions"]
    ids = {s["id"]: s for s in sessions}
    check(f"{label}: both chats are listed", {made["chat1"], made["chat2"]} <= set(ids), str(list(ids)))
    check(f"{label}: the renamed chat keeps its title", (ids.get(made["chat2"]) or {}).get("title") == RENAMED, str(ids.get(made["chat2"]))[:200])
    if made["chat1"]:
        thread = a.ok("GET", f"/api/agent/sessions/{made['chat1']}/thread")
        text = json.dumps(thread)
        check(f"{label}: chat 1's thread is on the server", "persistence card" in text, text[:200])
        check(f"{label}: chat 1's thread carries the card part (ui_part)", '"card"' in text and CARD_TITLE in text, text[:300], group="W4")
    s1 = ids.get(made["chat1"]) or {}
    check(f"{label}: sessions carry last_opened_at", any(k in s1 for k in ("lastOpenedAt", "last_opened_at")), str(s1)[:200], group="W4")

    prefs = a.ok("GET", "/api/v1/me/prefs")["prefs"]
    check(f"{label}: the preference is on the server", prefs.get("theme") == THEME, str(prefs)[:200])
    check(f"{label}: the Studio layout is on the server", prefs.get(f"layout:{pid}:{task}") == LAYOUT, str(list(prefs))[:200], group="W3")

    status, doc = a("GET", f"/api/annotations/{task}")
    doc = doc if isinstance(doc, dict) else {}
    check(f"{label}: the annotation is there", any(x.get("id") == made["ann"] for x in doc.get("annotations", [])), f"revision {doc.get('revision')}")

    # The browser, with empty storage: nothing comes from a local cache.
    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
    ctx.add_cookies([playwright_cookie(cookie, st.origin)])
    page = ctx.new_page()
    try:
        page.goto(f"{st.origin}/")
        page.get_by_text(PROJECT_TITLE).first.wait_for(timeout=30000)
        check(f"{label}: Home shows the project (fresh browser)", True)
    except Exception as e:  # noqa: BLE001
        page.screenshot(path=str(out / f"{label}-home.png"))
        check(f"{label}: Home shows the project (fresh browser)", False, f"{type(e).__name__}: {str(e)[:200]}")
    is_dark = page.evaluate("() => document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark'")
    check(f"{label}: the theme follows the person to a fresh browser", bool(is_dark), group="W3")
    try:
        page.goto(f"{st.origin}/projects/{pid}/overview")
        open_drawer(page)
        show_chat_list(page)
        page.get_by_test_id("agent-chat-item").filter(has_text=RENAMED).first.wait_for(timeout=20000)
        check(f"{label}: the chat list shows the renamed chat (fresh browser)", True)
    except Exception as e:  # noqa: BLE001
        page.screenshot(path=str(out / f"{label}-chats.png"))
        check(f"{label}: the chat list shows the renamed chat (fresh browser)", False, f"{type(e).__name__}: {str(e)[:200]}")
    try:
        # Chat 1 is the one that isn't renamed (its title comes from its first message).
        show_chat_list(page)
        page.get_by_test_id("agent-chat-item").filter(has_text="Persistence card").first.click()
        page.get_by_text("Drafting the notes.").first.wait_for(timeout=20000)
        check(f"{label}: chat 1's thread opens (fresh browser)", True)
        page.get_by_text(CARD_TITLE).first.wait_for(timeout=10000)
        check(f"{label}: chat 1 shows its card (fresh browser)", True, group="W4")
    except Exception as e:  # noqa: BLE001
        page.screenshot(path=str(out / f"{label}-card.png"))
        check(f"{label}: chat 1 shows its card (fresh browser)", False, f"{type(e).__name__}: {str(e)[:200]}", group="W4")
    ctx.close()


# ---- Step 3: B, in another organization, sees none of it -----------------------------------------


def b_sees_nothing(st: AuthStack, browser, made: dict, out: Path) -> None:
    cookie = st.sign_in(*USERS["admin"], organization=GLOBEX)
    b = Person(st, cookie)
    pid, task = made["pid"], made["task"]
    projects = b.ok("GET", "/api/v1/projects")["projects"]
    check("3: B doesn't list A's project", all(p["id"] != pid for p in projects))
    status, _ = b("GET", f"/api/v1/projects/{pid}")
    check("3: B can't open A's project (404)", status == 404, f"got {status}")
    status, _ = b("GET", f"/api/v1/projects/{pid}/drops")
    check("3: B can't list A's drops", status in (403, 404), f"got {status}")
    status, _ = b("GET", f"/api/annotations/{task}")
    check("3: B can't read A's annotations", status in (403, 404), f"got {status}")
    sessions = b.ok("GET", "/api/agent/sessions")["sessions"]
    check("3: B doesn't list A's chats", not ({s["id"] for s in sessions} & {made["chat1"], made["chat2"]}))
    for key in ("chat1", "chat2"):
        if made[key]:
            status, _ = b("GET", f"/api/agent/sessions/{made[key]}/thread")
            check(f"3: B can't open A's {key} thread (404)", status == 404, f"got {status}")
    prefs = b.ok("GET", "/api/v1/me/prefs")["prefs"]
    check("3: B doesn't get A's preferences", f"layout:{pid}:{task}" not in prefs and prefs.get("theme") != THEME, str(prefs)[:200])
    ctx = browser.new_context()
    ctx.add_cookies([playwright_cookie(cookie, st.origin)])
    page = ctx.new_page()
    page.goto(f"{st.origin}/")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    check("3: B's Home doesn't show A's project", page.get_by_text(PROJECT_TITLE).count() == 0)
    if page.get_by_text(PROJECT_TITLE).count():
        page.screenshot(path=str(out / "step3-home.png"))
    ctx.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--browser", default="chromium")
    ap.add_argument("--keep", action="store_true", help="print the log folder and leave it")
    ap.add_argument("--strict-pending", action="store_true", help="count [W3]/[W4] failures as failures")
    args = ap.parse_args()

    from harness import launch, sync_playwright

    with AuthStack(agent=True, agent_script=SCRIPT, worker=True) as st:
        out = st.tmp / "shots"
        out.mkdir(exist_ok=True)
        try:
            with sync_playwright() as pw:
                browser = launch(pw, args.browser, args.headed)
                made = step1(st, browser, out, args.headed)
                sees_everything(st, browser, made, "2", out)
                b_sees_nothing(st, browser, made, out)
                st.restart("api", "agent")
                sees_everything(st, browser, made, "4", out)
                browser.close()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            check("the run finished", False, "see the traceback; logs in " + str(st.tmp))
        if args.keep or any(not ok for _, _, ok, _ in results):
            print(f"logs and screenshots in {st.tmp}", flush=True)

    hard = [r for r in results if not r[2] and (not r[0] or args.strict_pending)]
    pending = [r for r in results if not r[2] and r[0] and not args.strict_pending]
    print(f"\n{sum(1 for r in results if r[2])}/{len(results)} passed; {len(pending)} pending ({', '.join(sorted({r[0] for r in pending})) or 'none'}); {len(hard)} failed")
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
