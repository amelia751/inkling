"""todo13 journeys J1–J12 (§6), end to end, with the scripted model and synthetic fixtures.

The test starts the API (SQLite in a temp dir, schema by Alembic), the worker and the agent
service (scripted model, tests/e2e/fixtures/journey-script.json) itself, plus a second API with
every `API_FEATURE_*` off for J12. Start a frozen dev server pointed at them first:

    cd apps/web && STUDIO_E2E=1 STUDIO_API_URL=http://127.0.0.1:8271 \\
      STUDIO_AGENT_URL=http://127.0.0.1:8371 STUDIO_AGENT_TOKEN=e2e-agent-token \\
      pnpm exec vite --port 5271 --strictPort
    python3 ../../tests/e2e/journey_test.py --port 5271 [--only J1,J4] [--out DIR]

Ports: <envPrefix>E2E_API_PORT (8271), <envPrefix>E2E_AGENT_PORT (8371), <envPrefix>E2E_API_OFF_PORT
(8272). Fixtures come from tests/e2e/fixtures/mixed_drop.py (made fresh in a temp dir).

J11 runs first: the API starts on a database at Alembic head with every flag off, makes a
project the way the product did before todo13 (an upload, a dataset, a Studio), stops; the
database goes down to 0010 (before todo13) and back up through 0011/0012; then the API starts
again with the flags on and the rest of the journeys run on that upgraded database.

The uploader sends a big drop's first images as their own session (`priority: "first"`), so the
J8 steps are the first part's; the rest streams in after (todo13 M4 item 2).

Budgets gated here (§6): drop → drop card < 300 ms; drop → first file inspected < 3 s; J1 drop
→ first item interactive < 15 s (fast path); J4 second drop → plan card < 5 s after its first
group is classified. The attestation dialog is a person's click: the timings report it apart
and the gates leave it out. A timings table is printed at the end (and written to --out).
"""

from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "web" / "e2e"))
sys.path.insert(0, str(ROOT / "tests" / "e2e" / "fixtures"))
from harness import NAMING, launch, sync_playwright  # noqa: E402
from mixed_drop import png  # noqa: E402

P = NAMING["envPrefix"]
API_PORT = int(os.environ.get(f"{P}E2E_API_PORT", "8271"))
OFF_PORT = int(os.environ.get(f"{P}E2E_API_OFF_PORT", "8272"))
AGENT_PORT = int(os.environ.get(f"{P}E2E_AGENT_PORT", "8371"))
API = f"http://127.0.0.1:{API_PORT}"
WORKER = {"X-Worker-Token": "dev-only-worker-token"}
TOKEN = "e2e-agent-token"
AI = f"{NAMING['displayName']} AI"
SCRIPT = ROOT / "tests" / "e2e" / "fixtures" / "journey-script.json"
FLAGS = ("CHAT_DROPS", "AUTO_APPLY", "FAST_PATH", "DATASETS_TAB")

results: list[tuple[str, bool, str]] = []
timings: list[tuple[str, float | None, str, str]] = []  # (moment, ms, budget, note)


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)
    return ok


def timing(moment: str, ms: float | None, budget: str = "", note: str = "") -> None:
    timings.append((moment, ms, budget, note))
    print(f"TIME {moment}: {'—' if ms is None else f'{ms:,.0f} ms'} {budget} {note}".rstrip(), flush=True)


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


# ---- HTTP -------------------------------------------------------------------------------------


def call(method: str, path: str, body=None, headers: dict | None = None, raw: bytes | None = None, base: str = API):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {**({"Content-Type": "application/json"} if body is not None else {}), **(headers or {})}
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read()
            return r.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:400]


def ok(method: str, path: str, body=None, **kw):
    status, out = call(method, path, body, **kw)
    if status >= 300:
        raise RuntimeError(f"{method} {path} → {status}: {out}")
    return out


def upload(pid: str, files: dict[str, bytes], origin: dict | None = None) -> dict:
    """The import route as the browser uses it (one session), then wait for inspection."""
    import hashlib

    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    if origin:
        body["origin"] = origin
    s = ok("POST", f"/api/v1/projects/{pid}/imports", body)
    by_rel = dict(files)
    for f in s["files"]:
        if f.get("uploadUrl"):
            data = next(d for rel, d in by_rel.items() if rel.endswith(f["relPath"]))
            ok("PUT", f["uploadUrl"], raw=data, headers={"Content-Type": "application/octet-stream"})
    ok("POST", f"/api/v1/imports/{s['id']}/complete", {})
    done = wait(lambda: (lambda x: x if x["state"] not in ("uploading", "inspecting") else None)(ok("GET", f"/api/v1/imports/{s['id']}")), timeout=90, every=0.5)
    return done or s


def agent_token(pid: str) -> dict:
    out = ok("POST", "/api/v1/sessions", {"agent": "assistant", "profile": "assistant", "scopes": ["proposals.write"], "ttlSeconds": 600}, headers={"X-Workspace-Id": pid})
    return {"Authorization": f"Bearer {out['token']}"}


def project_ids() -> set[str]:
    return {p["id"] for p in ok("GET", "/api/v1/projects")["projects"]}


def task_items(task_id: str) -> list[str]:
    return sorted(a.get("nodeId") or a.get("id") for a in ok("GET", f"/api/v1/tasks/{task_id}/document")["assets"])


# ---- Processes --------------------------------------------------------------------------------


class Stack:
    def __init__(self, logs: Path):
        self.logs = logs
        self.procs: dict[str, subprocess.Popen] = {}

    def start(self, name: str, cmd: list[str], env: dict, cwd: Path = ROOT) -> subprocess.Popen:
        log = open(self.logs / f"{name}.log", "ab")
        p = subprocess.Popen(cmd, cwd=cwd, env={**os.environ, **env}, stdout=log, stderr=subprocess.STDOUT)
        self.procs[name] = p
        return p

    def stop(self, name: str) -> None:
        p = self.procs.pop(name, None)
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=20)
            except subprocess.TimeoutExpired:
                p.kill()

    def stop_all(self) -> None:
        for n in list(self.procs):
            self.stop(n)


def api_env(data_dir: Path, flags_on: bool) -> dict:
    return {
        f"{P}API_DATA_DIR": str(data_dir),
        f"{P}API_CREATE_TABLES": "0",
        **{f"{P}API_FEATURE_{f}": "true" if flags_on else "false" for f in FLAGS},
    }


def start_api(stack: Stack, name: str, port: int, env: dict) -> None:
    stack.start(name, ["uv", "run", "--package", "studio-api", "uvicorn", "studio_api.app:app", "--port", str(port)], env)
    if not wait(lambda: call("GET", "/healthz", base=f"http://127.0.0.1:{port}")[0] == 200, timeout=90, every=0.3):
        raise RuntimeError(f"the API didn't start on {port} (see {stack.logs / (name + '.log')})")


def start_worker(stack: Stack) -> None:
    stack.start("worker", ["uv", "run", "--package", "studio-worker", "studio-worker", "--kernel", API], {})


def start_agent(stack: Stack, data_dir: Path) -> None:
    settings = {"ENV": "test", "AGENT_MODEL": "scripted", "AGENT_SCRIPT": str(SCRIPT), "AGENT_SANDBOX": "off", "AGENT_PORT": str(AGENT_PORT), "AGENT_DATA_DIR": str(data_dir), "AGENT_TOKEN": TOKEN, "API_URL": API, "LOG_LEVEL": "warn"}
    stack.start("agent", ["pnpm", "--filter", "@studio/agent", "start:dev"], {P + k: v for k, v in settings.items()})

    def live():
        with urllib.request.urlopen(f"http://127.0.0.1:{AGENT_PORT}/health/live", timeout=2) as r:
            return json.loads(r.read()).get("ok")

    if not wait(live, timeout=90):
        raise RuntimeError(f"the agent didn't start on {AGENT_PORT}")


def alembic(data_dir: Path, *args: str) -> None:
    env = {**os.environ, f"{P}API_DATA_DIR": str(data_dir), f"{P}API_CREATE_TABLES": "0"}
    r = subprocess.run(["uv", "run", "--package", "studio-api", "alembic", *args], cwd=ROOT / "apps" / "api", env=env, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"alembic {' '.join(args)} failed:\n{r.stdout[-2000:]}\n{r.stderr[-2000:]}")


# ---- Project stream ---------------------------------------------------------------------------


class Events:
    """The project's SSE stream, read in a thread, with arrival times (time.time())."""

    def __init__(self, project_id: str):
        self.seen: list[tuple[float, str, dict]] = []
        self.stop = False
        threading.Thread(target=self._run, args=(project_id,), daemon=True).start()

    def _run(self, pid: str) -> None:
        try:
            with urllib.request.urlopen(f"{API}/api/v1/projects/{pid}/events", timeout=600) as r:
                kind = None
                for raw in r:
                    if self.stop:
                        return
                    line = raw.decode().strip()
                    if line.startswith("event:"):
                        kind = line[6:].strip()
                    elif line.startswith("data:") and kind:
                        try:
                            data = json.loads(line[5:].strip() or "null") or {}
                        except ValueError:
                            data = {}
                        self.seen.append((time.time(), kind, data))
        except Exception:  # noqa: BLE001 — the stream ends; the test reads what arrived
            pass

    def first(self, kind: str, pred=lambda d: True) -> tuple[float, dict] | None:
        return next(((t, d) for t, k, d in self.seen if k == kind and pred(d)), None)


# ---- Browser helpers --------------------------------------------------------------------------

DROP_JS = """
async ([selector, files, waitFor]) => {
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  const el = document.querySelector(selector);
  if (!el) throw new Error("no drop target " + selector);
  const before = waitFor ? document.querySelectorAll(waitFor).length : 0;
  const at = performance.now();
  for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  if (!waitFor) return { at, shown: null };
  // The drop card: the first frame it's in the document, measured in the page.
  const shown = await new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (document.querySelectorAll(waitFor).length > before) return resolve(performance.now() - at);
      if (performance.now() - t0 > 5000) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
  return { at, shown };
}
"""


def b64files(files: dict[str, bytes], mime: str | None = None) -> list[dict]:
    types = {".png": "image/png", ".dcm": "application/dicom", ".pdf": "application/pdf", ".zip": "application/zip", ".mp3": "audio/mpeg", ".csv": "text/csv"}
    return [{"name": n, "type": mime or types.get(Path(n).suffix, "application/octet-stream"), "b64": base64.b64encode(d).decode()} for n, d in files.items()]


def attest(page, timeout: int = 4000) -> None:
    dialog = page.get_by_test_id("attestation")
    try:
        dialog.wait_for(timeout=timeout)
    except Exception:  # noqa: BLE001 — already attested in this project
        return
    dialog.get_by_role("checkbox").click()
    page.get_by_test_id("attest-confirm").click()


def open_drawer(page) -> None:
    """The assistant drawer or the Studio's AI panel, open and turned on."""
    consent = page.get_by_role("button", name="Turn on for this browser")
    box = page.get_by_label(f"Message {AI}")
    try:
        # It may be opening already (Home and boots open it): don't toggle it shut.
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


def timeline_steps(page) -> dict[str, int]:
    t = page.evaluate("async () => (await import('/src/studio/lib/drop-timeline.ts')).dropTimeline()")
    return {s["step"]: s["ms"] for s in (t or {}).get("steps", [])}


def home_drop(page, port: int, files: dict[str, bytes]) -> tuple[str | None, float]:
    """Drop on Home: a new project (answer "Start a new project" when Home has some)."""
    before = project_ids()
    page.goto(f"http://localhost:{port}/?timeline=1")
    page.get_by_test_id("home-composer").wait_for(timeout=30000)
    t0 = time.time()
    page.evaluate(DROP_JS, ["[data-testid=home-drop]", b64files(files), None])
    target = page.get_by_test_id("home-target-new")
    try:
        target.wait_for(timeout=2000)
        target.click()
    except Exception:  # noqa: BLE001 — an empty Home asks nothing
        pass
    attest(page, 10000)
    made = wait(lambda: [p for p in project_ids() if p not in before], timeout=30)
    return (made[0] if made else None), t0


def studio_task(page) -> str | None:
    m = re.search(r"/studio/([^/?#]+)", page.url)
    return m.group(1) if m else None


# ---- Journeys ---------------------------------------------------------------------------------


class Suite:
    def __init__(self, browser, port: int, fixtures: Path, manifest: dict, data_dir: Path, agent_dir: Path, out: Path):
        self.browser = browser
        self.port = port
        self.fx = fixtures
        self.m = manifest
        self.data_dir = data_dir
        self.agent_dir = agent_dir
        self.out = out
        self.ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        self.page = self.ctx.new_page()
        self.errors: list[str] = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.j1: dict = {}
        self.j2: dict = {}
        self.legacy: dict = {}

    def url(self, path: str) -> str:
        return f"http://localhost:{self.port}{path}"

    def files(self, sub: str, names: list[str] | None = None) -> dict[str, bytes]:
        d = self.fx / sub
        return {p.name: p.read_bytes() for p in sorted(d.iterdir()) if p.is_file() and (names is None or p.name in names)}

    def shot(self, name: str) -> None:
        try:
            self.page.screenshot(path=str(self.out / f"journey-{name}.png"))
        except Exception:  # noqa: BLE001
            pass

    # J1 ----------------------------------------------------------------------------------------
    def j1_drop_on_home(self) -> None:
        page = self.page
        pid, t0 = home_drop(page, self.port, self.files("pngs"))
        check("J1: a drop on Home creates a project", bool(pid), str(pid))
        if not pid:
            return
        events = Events(pid)
        try:
            page.wait_for_url("**/studio/**", timeout=30000)
        except Exception:  # noqa: BLE001
            self.shot("j1-no-studio")
        task = studio_task(page)
        check("J1: the Studio opens on its own (fast path)", bool(task), page.url)
        if not task:
            return
        page.locator("[data-testid=file-row]").first.wait_for(timeout=30000)
        steps = wait(lambda: (lambda s: s if "first-interactive" in s else None)(timeline_steps(page)), timeout=30) or timeline_steps(page)
        self.shot("j1-studio")
        human = max(0, steps.get("attested", 0) - steps.get("upload-start", 0))
        fi = steps.get("first-interactive")
        timing("J1 drop → first item interactive (fast path)", fi, "< 15 s", f"incl. {human} ms attestation click")
        check("J1 budget: drop → first item interactive < 15 s (attestation click excluded)", fi is not None and fi - human < 15000, f"{fi} ms − {human} ms")
        insp = steps.get("server:source.node.inspected")
        timing("J1 drop → first file inspected", insp, "< 3 s", f"incl. {human} ms attestation click")
        check("J1 budget: drop → first file inspected < 3 s (attestation click excluded)", insp is not None and insp - human < 3000, f"{insp} ms − {human} ms")
        for a, b, label in (("attested", "first-file-uploaded", "upload of the first file"), ("upload-done", "server:source.node.inspected", "inspection (queue wait + inspect)"), ("server:source.node.inspected", "server:drop.planned", "classify + plan"), ("server:drop.planned", "server:boot.ready", "fast-path boot"), ("server:boot.ready", "studio:route-enter", "navigate to the Studio"), ("studio:route-enter", "studio:first-frame", "Studio first frame")):
            if a in steps and b in steps:
                timing(f"J1 step: {label}", steps[b] - steps[a], "", f"{a} → {b}")
        doc = wait(lambda: (lambda x: x if len(x) == 30 else None)(task_items(task)), timeout=60) or task_items(task)
        check("J1: the Studio has the 30 images", len(doc) == 30, str(len(doc)))
        t = ok("GET", f"/api/v1/tasks/{task}")
        ds = ok("GET", f"/api/v1/projects/{pid}/datasets/{t['datasetId']}")
        cols = ok("GET", f"/api/v1/projects/{pid}/datasets/{t['datasetId']}/collections")["collections"]
        check("J1: a draft dataset with one collection", ds.get("draft", ds.get("definition", {}).get("draft", True)) is not False and len(cols) == 1 and cols[0]["kind"] == "image", json.dumps([(c["name"], c["kind"], c.get("files")) for c in cols]))
        summaries = ok("GET", f"/api/v1/projects/{pid}/dataset-summaries")
        check("J1: Datasets lists it", t["datasetId"] in json.dumps(summaries), json.dumps(summaries)[:200])
        page.goto(self.url(f"/projects/{pid}/datasets"))
        try:
            page.get_by_text(ds["title"]).first.wait_for(timeout=20000)
            check("J1: the dataset shows in the Datasets tab", True)
        except Exception:  # noqa: BLE001
            self.shot("j1-datasets")
            check("J1: the dataset shows in the Datasets tab", False, ds["title"])
        events.stop = True
        self.j1 = {"pid": pid, "task": task, "dataset": t["datasetId"], "nodes": doc}

    # J2 ----------------------------------------------------------------------------------------
    def j2_type_on_home(self) -> None:
        page = self.page
        before = project_ids()
        page.goto(self.url("/?timeline=1"))
        page.get_by_test_id("home-composer").wait_for(timeout=30000)
        box = page.get_by_test_id("goal")
        box.fill("Chest X-ray classification with five labels")
        t_send = time.time()
        box.press("Enter")
        target = page.get_by_test_id("home-target-new")
        try:
            target.wait_for(timeout=2000)
            target.click()
        except Exception:  # noqa: BLE001
            pass
        made = wait(lambda: [p for p in project_ids() if p not in before], timeout=30)
        check("J2: a send on Home creates a project", bool(made), str(made))
        if not made:
            return
        pid = made[0]
        try:
            page.wait_for_url("**/studio/**", timeout=45000)
        except Exception:  # noqa: BLE001
            self.shot("j2-no-studio")
        task = studio_task(page)
        check("J2: the Studio opens at once (fast path, §3.5)", bool(task), page.url)
        if not task:
            return
        # The message goes on to the assistant beside the Studio, which adds the five labels.
        open_drawer(page)
        env_of = lambda: json.dumps(call("GET", f"/api/environments/{task}")[1])  # noqa: E731
        configured = wait(lambda: '"pneumothorax"' in env_of() and time.time(), timeout=45)
        steps = timeline_steps(page)
        timing("J2 send → Studio open (fast path)", steps.get("studio:route-enter"), "", "")
        timing("J2 send → Studio configured by the agent (scripted model)", (configured - t_send) * 1000 if configured else None, "< 60 s (real model)", "labels patched in")
        empty = page.get_by_test_id("studio-canvas-empty")
        try:
            empty.wait_for(timeout=30000)
            check("J2: the canvas asks for files", "Drop files here" in empty.inner_text(), empty.inner_text()[:120])
        except Exception:  # noqa: BLE001
            self.shot("j2-canvas")
            check("J2: the canvas asks for files", False)
        env = env_of()
        labels = [x for x in ("normal", "pneumonia", "effusion", "cardiomegaly", "pneumothorax") if f'"{x}"' in env]
        check("J2: the Studio has the five labels", len(labels) == 5, str(labels))
        t = ok("GET", f"/api/v1/tasks/{task}")
        cols = ok("GET", f"/api/v1/projects/{pid}/datasets/{t['datasetId']}/collections")["collections"]
        check("J2: an empty collection", len(cols) == 1 and not cols[0].get("files"), json.dumps([(c["kind"], c.get("files")) for c in cols]))
        self.shot("j2-studio")
        self.j2 = {"pid": pid, "task": task}

    # J3 ----------------------------------------------------------------------------------------
    def j3_drop_on_canvas(self) -> None:
        if not self.j2:
            return check("J3: needs J2's Studio", False)
        page = self.page
        page.evaluate("() => { window.__noReload = 'kept' }")
        url = page.url
        files = {f"canvas_{i:03d}.png": png(500 + i) for i in range(30)}
        page.evaluate(DROP_JS, ["[data-testid=studio-canvas-empty]", b64files(files), None])
        attest(page)
        first = wait(lambda: page.locator("[data-testid=file-row]").count() > 0, timeout=30)
        check("J3: items appear live", bool(first))
        n = wait(lambda: (lambda x: x if len(x) == 30 else None)(task_items(self.j2["task"])), timeout=60) or task_items(self.j2["task"])
        check("J3: all 30 join the Studio", len(n) == 30, str(len(n)))
        check("J3: no reload", page.evaluate("() => window.__noReload") == "kept" and page.url == url, page.url)
        self.shot("j3-canvas")

    # J4 ----------------------------------------------------------------------------------------
    def j4_ct_into_xray_studio(self) -> None:
        if not self.j1:
            return check("J4: needs J1's Studio", False)
        page = self.page
        pid, task = self.j1["pid"], self.j1["task"]
        events = Events(pid)
        page.goto(self.url(f"/projects/{pid}/studio/{task}"))
        page.locator("[data-testid=file-row]").first.wait_for(timeout=30000)
        open_drawer(page)
        page.evaluate("() => { window.__noReload = 'kept' }")
        url = page.url
        items_before = task_items(task)
        time.sleep(1.0)  # the stream is open
        page.evaluate(DROP_JS, ["[data-testid=studio-canvas-drop]", b64files({f"ct/{n}": d for n, d in self.files("ct").items()}), None])
        attest(page)
        cls = wait(lambda: events.first("drop.classified", lambda d: any(g.get("kind", "").startswith("dicom") for g in d.get("groups") or [])), timeout=60)
        if not cls:
            self.shot("j4-no-classified")
            return check("J4: the CT drop is classified", False)
        drop_id = cls[1]["dropId"]
        card = page.locator(f'[data-testid="plan-card"][data-drop-id="{drop_id}"]')
        shown = wait(lambda: card.count() > 0 and time.time(), timeout=20, every=0.05)
        ms = (shown - cls[0]) * 1000 if shown else None
        timing("J4 second drop → plan card (after first group classified)", ms, "< 5 s")
        check("J4 budget: plan card < 5 s after the group is classified", ms is not None and ms < 5000, f"{ms}")
        plan = ok("GET", f"/api/v1/drops/{drop_id}/plan")
        acts = plan["plan"]["actions"]
        check("J4: the card offers a CT collection in this dataset", any(a["type"] == "new_collection" and a.get("datasetId") == self.j1["dataset"] for a in acts), json.dumps([(a["type"], a.get("name")) for a in acts]))
        applied = wait(lambda: (lambda s: s if s["state"] == "applied" else None)(ok("GET", f"/api/v1/drops/{drop_id}/plan")), timeout=30)
        check("J4: applied automatically (a draft dataset)", bool(applied), (applied or plan)["state"])
        try:
            card.get_by_test_id("plan-undo").wait_for(timeout=10000)
            check("J4: the card offers Undo", "Undo" in card.get_by_test_id("plan-undo").inner_text())
        except Exception:  # noqa: BLE001
            check("J4: the card offers Undo", False, card.inner_text()[:200] if card.count() else "no card")
        try:
            page.get_by_test_id("collection-switcher").wait_for(timeout=15000)
            page.get_by_test_id("collection-switcher").click()
            opts = page.get_by_test_id("collection-option")
            opts.first.wait_for(timeout=5000)
            check("J4: the switcher shows two collections", opts.count() == 2, " | ".join(opts.all_inner_texts()))
            self.shot("j4-switcher")
            page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001
            self.shot("j4-no-switcher")
            check("J4: the switcher shows two collections", False)
        check("J4: the X-ray Studio didn't reload or change", page.evaluate("() => window.__noReload") == "kept" and page.url == url and task_items(task) == items_before, page.url)
        events.stop = True

    # J5 ----------------------------------------------------------------------------------------
    def j5_mixed(self) -> None:
        if not self.j1:
            return check("J5: needs J1's project", False)
        page = self.page
        pid, task = self.j1["pid"], self.j1["task"]
        events = Events(pid)
        page.goto(self.url(f"/projects/{pid}/studio/{task}"))
        page.locator("[data-testid=file-row]").first.wait_for(timeout=30000)
        open_drawer(page)
        time.sleep(1.0)
        res = page.evaluate(DROP_JS, ["[data-testid=agent-log]", b64files(self.files("mixed")), "[data-testid=drop-card]"])
        shown = res.get("shown")
        timing("drop → drop card visible (chat composer)", shown, "< 300 ms")
        check("budget: drop → drop card < 300 ms", shown is not None and shown < 300, f"{shown}")
        attest(page)
        page.get_by_label("Send").click()
        cls = wait(lambda: events.first("drop.planned", lambda d: any(a["type"] == "keep_reference" for a in (d.get("plan") or {}).get("actions") or [])), timeout=60)
        if not cls:
            self.shot("j5-no-plan")
            return check("J5: the mixed drop is planned", False)
        drop_id = cls[1]["dropId"]
        acts = cls[1]["plan"]["actions"]
        types = {a["type"] for a in acts}
        check("J5: the PDF is kept as reference", "keep_reference" in types, str(sorted(types)))
        check("J5: the MP3 is kept, can't use yet", "keep_unsupported" in types, str(sorted(types)))
        check("J5: the ZIP is unpacked", "unpack" in types or bool(events.first("drop.planned", lambda d: d.get("dropId", "").startswith(drop_id + "-u"))), str(sorted(types)))
        card = page.locator(f'[data-testid="plan-card"][data-drop-id="{drop_id}"]')
        try:
            card.wait_for(timeout=15000)
            text = card.inner_text()
            check("J5: the CSV is asked as a labels table", card.get_by_test_id("plan-question-yes").count() >= 1 and "labels" in text.lower(), text[:300])
            card.get_by_test_id("plan-find-plugin").first.click()
            card.get_by_test_id("plan-no-plugin").or_(card.get_by_test_id("plan-plugin-results")).first.wait_for(timeout=10000)
            check("J5: \"Find a plugin\" for the MP3 answers", True, card.inner_text()[-200:])
            card.screenshot(path=str(self.out / "journey-j5-card.png"))
            # The person answers (yes, it's the labels table) and applies: the ZIP is unpacked.
            card.get_by_test_id("plan-question-yes").first.click()
            apply = card.get_by_test_id("plan-apply")
            if wait(lambda: apply.count() > 0 and apply.first.is_enabled(), timeout=10):
                apply.first.click()
            wait(lambda: ok("GET", f"/api/v1/drops/{drop_id}/plan")["state"] == "applied", timeout=30)
        except Exception as e:  # noqa: BLE001
            self.shot("j5-card")
            check("J5: the card asks about the CSV and offers Find a plugin", False, repr(e)[:200])
        # The ZIP's contents: a child drop, its PNGs added to the X-ray collection.
        child = wait(lambda: events.first("drop.applied", lambda d: str(d.get("dropId", "")).startswith(drop_id + "-u")) or events.first("drop.planned", lambda d: str(d.get("dropId", "")).startswith(drop_id + "-u")), timeout=60)
        check("J5: the ZIP's contents become a child drop", bool(child), json.dumps(child[1])[:300] if child else "")
        if child:
            cp = ok("GET", f"/api/v1/drops/{child[1]['dropId']}/plan")
            check("J5: the ZIP's PNGs are added to the X-ray collection", any(a["type"] in ("add_to_collection",) for a in cp["plan"]["actions"]), json.dumps([(a["type"], a.get("count")) for a in cp["plan"]["actions"]]))
        events.stop = True

    # J6 ----------------------------------------------------------------------------------------
    def j6_same_again(self) -> None:
        if not self.j1:
            return check("J6: needs J1's project", False)
        page = self.page
        pid, task = self.j1["pid"], self.j1["task"]
        puts: list[str] = []
        page.on("request", lambda r: puts.append(r.url) if r.method == "PUT" and "/uploads/" in r.url else None)
        before = task_items(task)
        drops_before = {d["id"] for d in ok("GET", f"/api/v1/projects/{pid}/drops")["drops"]}
        open_drawer(page)
        page.evaluate(DROP_JS, ["[data-testid=agent-log]", b64files(self.files("pngs")), None])
        attest(page)
        page.get_by_label("Send").click()
        d = wait(lambda: [x for x in ok("GET", f"/api/v1/projects/{pid}/drops")["drops"] if x["id"] not in drops_before and len(x["files"]) == 30 and all(f["state"] in ("ready", "kept", "linked", "duplicate") or f.get("duplicate") for f in x["files"])], timeout=60)
        last = [x for x in ok("GET", f"/api/v1/projects/{pid}/drops")["drops"] if x["id"] not in drops_before]
        check("J6: no new uploads (no bytes sent)", not puts, f"{len(puts)} PUTs")
        chips = page.get_by_test_id("user-drop").last.get_by_test_id("drop-chip")
        text = " ".join(chips.all_inner_texts()[:3]) if chips.count() else ""
        card_text = page.get_by_test_id("user-drop").last.inner_text() if page.get_by_test_id("user-drop").count() else ""
        check("J6: the card says Already in Sources", "Already in Sources" in card_text or "Already in Sources" in text, card_text[:200])
        time.sleep(2)
        check("J6: no duplicate items", task_items(task) == before, f"{len(before)} → {len(task_items(task))}")
        _ = d, last

    # J7, J9 ------------------------------------------------------------------------------------
    def j7_identifier_name(self) -> None:
        if not self.j1:
            return check("J7: needs J1's project", False)
        page = self.page
        pid = self.j1["pid"]
        page.goto(self.url(f"/projects/{pid}/overview"))
        page.get_by_test_id("project-header").wait_for(timeout=30000)
        open_drawer(page)
        drops_before = {d["id"] for d in ok("GET", f"/api/v1/projects/{pid}/drops")["drops"]}
        page.evaluate(DROP_JS, ["[data-testid=agent-log]", b64files(self.files("identifier")), None])
        attest(page)
        page.get_by_label("Send").click()
        d = wait(lambda: [x for x in ok("GET", f"/api/v1/projects/{pid}/drops")["drops"] if x["id"] not in drops_before and x["files"] and x["files"][0].get("nodeId")], timeout=60)
        if not d:
            return check("J7: the drop lands", False)
        drop = d[0]
        try:
            page.get_by_text("Got your files.").last.wait_for(timeout=30000)
        except Exception:  # noqa: BLE001
            pass
        agent_view = wait(lambda: (lambda s: s if s[0] == 200 and s[1]["files"] and s[1]["files"][0].get("agentName") else None)(call("GET", f"/api/v1/drops/{drop['id']}", headers=agent_token(pid))), timeout=30)
        body = json.dumps(agent_view[1]) if agent_view else ""
        check("J7: the agent sees a screened name", bool(agent_view) and "Smith" not in body and re.search(r"(dicom|image|file)-\d{4}\.dcm", body) is not None, body[:200])
        time.sleep(1)
        stored = "".join(p.read_text(errors="replace") for p in self.agent_dir.rglob("*") if p.is_file())
        check("J7: the agent's transcript has no unscreened name", "Smith" not in stored and len(stored) > 0, f"{len(stored)} bytes")
        self.j7 = {"drop": drop}
        # J9: remove the file from the chat: still in Files, Shared files updated.
        node = drop["files"][0]["nodeId"]
        card = page.get_by_test_id("user-drop").last.get_by_test_id("drop-card")
        chip = card.locator(f"[data-testid=drop-chip][data-node-id='{node}']")
        try:
            chip.hover()
            chip.get_by_test_id("drop-chip-remove").click()
            wait(lambda: chip.get_attribute("data-state") == "removed", timeout=10)
        except Exception as e:  # noqa: BLE001
            check("J9: remove from the chat", False, repr(e)[:200])
            return
        detail = ok("GET", f"/api/v1/source-nodes/{node}")
        check("J9: removed from the chat, still in Sources", chip.get_attribute("data-state") == "removed" and detail["trash"] is None, str(detail.get("trash")))
        page.get_by_label("Assistant options").click()
        page.get_by_test_id("agent-shared-files").click()
        page.get_by_test_id("chat-files").or_(page.get_by_test_id("chat-files-empty")).first.wait_for(timeout=10000)
        listed = page.locator(f"[data-testid=chat-files] [data-node-id='{node}']")
        check("J9: Shared files no longer lists it", listed.count() == 0 or listed.first.get_attribute("data-state") == "removed", str(listed.count()))
        self.shot("j9-shared-files")
        page.get_by_test_id("agent-back-to-chat").click()

    # J8 ----------------------------------------------------------------------------------------
    def j8_two_thousand(self) -> None:
        page = self.page
        files = {f"small_{i:04d}.png": png(10_000 + i, 12, 8) for i in range(2000)}
        pid, t0 = home_drop(page, self.port, files)
        check("J8: a drop of 2,000 images makes a project", bool(pid))
        if not pid:
            return
        try:
            page.wait_for_url("**/studio/**", timeout=90000)
            page.locator("[data-testid=file-row]").first.wait_for(timeout=60000)
        except Exception:  # noqa: BLE001
            self.shot("j8-no-studio")
        steps = wait(lambda: (lambda s: s if "first-interactive" in s else None)(timeline_steps(page)), timeout=60) or timeline_steps(page)
        human = max(0, steps.get("attested", 0) - steps.get("upload-start", 0))
        fi = steps.get("first-interactive")
        timing("J8 2,000 images: drop → first item interactive", fi, "< 15 s", f"incl. {human} ms attestation click")
        for a, b, label in (("attested", "hashed", "hash the first part"), ("hashed", "import-created", "register the first part"), ("import-created", "upload-done", "upload the first part"), ("upload-done", "server:source.node.inspected", "inspect the first part"), ("server:source.node.inspected", "server:boot.ready", "classify, plan, boot"), ("server:boot.ready", "first-interactive", "Studio first frame")):
            if a in steps and b in steps:
                timing(f"J8 step: {label}", steps[b] - steps[a], "", f"{a} → {b}")
        check("J8 budget: first item interactive < 15 s (attestation click excluded)", fi is not None and fi - human < 15000, f"{fi} ms − {human} ms")
        task = studio_task(page)
        if task:
            n = wait(lambda: (lambda x: x if len(x) == 2000 else None)(task_items(task)), timeout=180, every=2) or task_items(task)
            check("J8: the rest stream in (all 2,000 items)", len(n) == 2000, str(len(n)))
            timing("J8 drop → all 2,000 items in the Studio", (time.time() - t0) * 1000, "tracked", "background ingest")

    # J10 ---------------------------------------------------------------------------------------
    def j10_viewer(self) -> None:
        if not self.j1:
            return check("J10: needs J1's project", False)
        pid = self.j1["pid"]
        with sqlite3.connect(self.data_dir / "api.db") as db:
            org = db.execute("select org_id from projects where id = ?", (pid,)).fetchone()[0]
            db.execute("insert or ignore into organization_members (org_id, principal, role) values (?, 'user:e2e-viewer', 'viewer')", (org,))
        ctx = self.browser.new_context(viewport={"width": 1440, "height": 900}, extra_http_headers={"X-Dev-Principal": "user:e2e-viewer"})
        page = ctx.new_page()
        try:
            page.goto(self.url(f"/projects/{pid}/overview"))
            page.get_by_test_id("project-header").wait_for(timeout=30000)
            open_drawer(page)
            attach = page.get_by_test_id("agent-attach")
            attach.wait_for(timeout=10000)
            check("J10: a viewer's attach is disabled with the hint", attach.is_disabled() and attach.get_attribute("aria-label") == "Ask a contributor to add files", str(attach.get_attribute("aria-label")))
        except Exception as e:  # noqa: BLE001
            check("J10: a viewer's attach is disabled with the hint", False, repr(e)[:200])
        finally:
            ctx.close()
        h = {"X-Dev-Principal": "user:e2e-viewer"}
        s1, _ = call("POST", f"/api/v1/projects/{pid}/imports", {"attested": True, "files": [{"clientFileId": "f0", "relPath": "a.png", "size": 1, "sha256": "0" * 64}]}, headers=h)
        s2, _ = call("POST", f"/api/v1/projects/{pid}/drops", {"origin": "chat", "conversationId": "conv-viewer"}, headers=h)
        check("J10: a forced import (and drop) answers 403", s1 == 403 and s2 == 403, f"{s1} {s2}")

    # J11 ---------------------------------------------------------------------------------------
    def j11_after(self) -> None:
        L = self.legacy
        if not L:
            return check("J11: the pre-todo13 project was made", False)
        cols = ok("GET", f"/api/v1/projects/{L['pid']}/datasets/{L['dataset']}/collections")["collections"]
        check("J11: its dataset shows collections", len(cols) >= 1 and cols[0]["kind"] == "image", json.dumps([(c["kind"], c.get("files"), c.get("taskIds")) for c in cols]))
        after = task_items(L["task"])
        check("J11: its Studio has the same items", after == L["items"], f"{len(L['items'])} → {len(after)}")
        t = ok("GET", f"/api/v1/tasks/{L['task']}")
        check("J11: its task points at the collection", bool(t.get("collectionId")) and t["collectionId"] in {c["id"] for c in cols}, str(t.get("collectionId")))
        ok("POST", "/api/v1/worker/scheduled/files.screen_names", {"budgetS": 10}, headers=WORKER)
        hdr = agent_token(L["pid"])
        root = ok("GET", f"/api/v1/projects/{L['pid']}/fs", headers=hdr)["rootNodeId"]
        texts = [json.dumps(ok("GET", f"/api/v1/projects/{L['pid']}/fs/children?node={root}", headers=hdr))]
        for it in json.loads(texts[0]).get("items", []):
            if it.get("isDir") or it.get("kind") == "folder":
                texts.append(json.dumps(ok("GET", f"/api/v1/projects/{L['pid']}/fs/children?node={it['id']}", headers=hdr)))
        blob = " ".join(texts)
        check("J11: the agent sees screened names", "Doe" not in blob and "Jane" not in blob and "cxr_legacy" in blob, blob[:300])
        page = self.page
        page.goto(self.url(f"/projects/{L['pid']}/studio/{L['task']}"))
        try:
            page.locator("[data-testid=file-row]").first.wait_for(timeout=30000)
            check("J11: its Studio opens", True)
        except Exception:  # noqa: BLE001
            self.shot("j11-studio")
            check("J11: its Studio opens", False, page.url)

    # J12 ---------------------------------------------------------------------------------------
    def j12_flags_off(self, off_base: str) -> None:
        status, feats = call("GET", "/api/v1/features", base=off_base)
        check("J12: every flag reads off", status == 200 and feats == {"chatDrops": False, "autoApply": False, "fastPath": False, "datasetsTab": False}, str(feats))
        _, proj = call("POST", "/api/v1/projects", {"title": "Flags off"}, base=off_base)
        pid = proj["id"]
        routes = [
            ("POST", f"/api/v1/projects/{pid}/drops", {"origin": "chat", "conversationId": "conv-1"}),
            ("GET", f"/api/v1/projects/{pid}/drops", None),
            ("GET", "/api/v1/drops/drp-x", None),
            ("GET", "/api/v1/drops/drp-x/plan", None),
            ("POST", "/api/v1/drops/drp-x/apply", {}),
            ("POST", "/api/v1/drops/drp-x/undo", {}),
            ("GET", "/api/v1/datasets/ds-x/structure", None),
            ("GET", f"/api/v1/projects/{pid}/datasets/ds-x/collections", None),
            ("GET", f"/api/v1/projects/{pid}/dataset-summaries", None),
            ("GET", f"/api/v1/projects/{pid}/dataset-attention", None),
            ("POST", "/api/v1/telemetry/timeline", {"origin": "home", "steps": {"gesture": 0}}),
        ]
        answered = [(m, p_, s) for m, p_, b in routes for s in [call(m, p_, b, base=off_base)[0]] if s != 404]
        check("J12: no todo13 route answers", not answered, str(answered))
        # The UI as before: the web app reads the flags once; answer them all off.
        if not self.j1:
            return
        ctx = self.browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        page.route("**/api/v1/features", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(feats)))
        try:
            page.goto(self.url(f"/projects/{self.j1['pid']}/overview"))
            page.get_by_test_id("project-header").wait_for(timeout=30000)
            nav = page.get_by_role("navigation").first.inner_text() if page.get_by_role("navigation").count() else page.inner_text("body")
            check("J12: no Datasets in the sidebar", "Datasets" not in nav, nav[:200])
            open_drawer(page)
            check("J12: the composer has no attach", page.get_by_test_id("agent-attach").count() == 0)
        except Exception as e:  # noqa: BLE001
            check("J12: the UI is as before", False, repr(e)[:200])
        finally:
            ctx.close()


# ---- J11 setup: a project made before todo13 -----------------------------------------------


def make_legacy(stack: Stack, data_dir: Path) -> dict:
    """At head with every flag off (the product as before todo13): an upload, a dataset, a Studio."""
    start_api(stack, "api-legacy", API_PORT, api_env(data_dir, flags_on=False))
    start_worker(stack)
    pid = ok("POST", "/api/v1/projects", {"title": "Made before todo13"})["id"]
    files = {f"legacy/cxr_legacy_{i}.png": png(900 + i) for i in range(3)}
    files["legacy/Doe_Jane_1970-01-01.png"] = png(950)
    imp = upload(pid, files)
    nodes = [f["nodeId"] for f in ok("GET", f"/api/v1/worker/inspect/imports/{imp['id']}", headers=WORKER)["files"] if f.get("nodeId")]
    ds = ok("POST", f"/api/v1/projects/{pid}/datasets", {"title": "Legacy X-rays", "nodeIds": nodes, "task": {"title": "Legacy Studio", "preset": "preset:image-2d"}})
    task = ok("GET", f"/api/v1/projects/{pid}/datasets/{ds['id']}/tasks")["tasks"][0]["id"]
    items = task_items(task)
    stack.stop("worker")
    stack.stop("api-legacy")
    return {"pid": pid, "dataset": ds["id"], "task": task, "items": items}


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="chromium")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated journeys, e.g. J1,J4 (J11 setup always runs)")
    ap.add_argument("--out", default=str(ROOT / "apps" / "web" / "e2e" / ".artifacts"))
    a = ap.parse_args()
    only = {x.strip().upper() for x in a.only.split(",") if x.strip()}
    want = lambda j: not only or j in only  # noqa: E731
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="journeys-"))
    data_dir, agent_dir, off_dir, fixtures = tmp / "api", tmp / "agent", tmp / "api-off", tmp / "fixtures"
    for d in (data_dir, agent_dir, off_dir):
        d.mkdir()
    logs = tmp / "logs"
    logs.mkdir()
    print(f"journeys: data and logs in {tmp}", flush=True)
    r = subprocess.run(["uv", "run", "--package", "studio-worker", "python", str(ROOT / "tests" / "e2e" / "fixtures" / "mixed_drop.py"), str(fixtures)], cwd=ROOT, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-2000:])
        return 1
    manifest = json.loads(r.stdout.strip().splitlines()[-1])

    stack = Stack(logs)
    try:
        # J11: before todo13 → 0010 → 0011/0012.
        alembic(data_dir, "upgrade", "head")
        legacy = make_legacy(stack, data_dir)
        alembic(data_dir, "downgrade", "0010")
        alembic(data_dir, "upgrade", "head")
        check("J11: the database goes down to 0010 and up through 0011/0012", True)
        start_api(stack, "api", API_PORT, api_env(data_dir, flags_on=True))
        start_worker(stack)
        start_agent(stack, agent_dir)
        if want("J12"):
            start_api(stack, "api-off", OFF_PORT, {f"{P}API_DATA_DIR": str(off_dir), **{f"{P}API_FEATURE_{f}": "false" for f in FLAGS}})
        status = json.loads(urllib.request.urlopen(f"http://localhost:{a.port}/api/agent/status", timeout=10).read())
        if status.get("provider") != "scripted":
            print(f"FAIL the dev server proxies /api/agent elsewhere ({status}); start it with {P}AGENT_URL=http://127.0.0.1:{AGENT_PORT} {P}AGENT_TOKEN={TOKEN}")
            return 1
        with sync_playwright() as pw:
            browser = launch(pw, a.browser, a.headed)
            s = Suite(browser, a.port, fixtures, manifest, data_dir, agent_dir, out)
            s.legacy = legacy
            plan = [("J11", s.j11_after), ("J1", s.j1_drop_on_home), ("J2", s.j2_type_on_home), ("J3", s.j3_drop_on_canvas), ("J4", s.j4_ct_into_xray_studio), ("J5", s.j5_mixed), ("J6", s.j6_same_again), ("J7", s.j7_identifier_name), ("J10", s.j10_viewer), ("J8", s.j8_two_thousand)]
            for j, fn in plan:
                if not want(j) and not (j == "J1" and only & {"J4", "J5", "J6", "J7", "J10", "J12"}) and not (j == "J2" and "J3" in only):
                    continue
                print(f"---- {j}", flush=True)
                try:
                    fn()
                except Exception as e:  # noqa: BLE001 — report and keep going
                    s.shot(f"{j.lower()}-crash")
                    check(f"{j} crashed", False, repr(e)[:400])
            if want("J12"):
                print("---- J12", flush=True)
                try:
                    s.j12_flags_off(f"http://127.0.0.1:{OFF_PORT}")
                except Exception as e:  # noqa: BLE001
                    check("J12 crashed", False, repr(e)[:400])
            check("no page errors", not s.errors, "; ".join(s.errors[:3]))
            browser.close()
    finally:
        stack.stop_all()

    lines = ["| Moment | Measured | Budget | Note |", "|---|---|---|---|"] + [f"| {m} | {'—' if ms is None else f'{ms:,.0f} ms'} | {b} | {n} |" for m, ms, b, n in timings]
    (out / "journey-timings.md").write_text("\n".join(lines) + "\n")
    print("\n" + "\n".join(lines))
    failed = [x for x in results if not x[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    for name, _, detail in failed:
        print(f"  FAIL {name} — {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
