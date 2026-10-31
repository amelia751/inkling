"""Shared pieces of the todo7 Files e2e tests (files_edit, files_move, files_trash, files_versions).

Each test makes its own scratch project through the kernel, uploads a small folder through the
Folder… picker (the same walk as a drop), and drives the Files page. Drags use synthetic
`DragEvent`s with a real `DataTransfer` (the page's drag controller reads only those), because
Playwright's emulated native drag is flaky across rows that re-render.

    INKLING_API_URL=http://127.0.0.1:8000 INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 ../../tests/e2e/files_edit_test.py --port 5199   # from apps/web
"""

from __future__ import annotations

import base64
import os
import sqlite3
import struct
import sys
import tempfile
import time
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))

from harness import launch, parse_args, sync_playwright  # noqa: E402,F401

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail and not ok else ""), flush=True)
    return bool(ok)


def skip(name: str, why: str) -> None:
    print(f"SKIP {name} — {why}", flush=True)


def summary() -> int:
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


def wait(fn, timeout: float = 20.0, every: float = 0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001
            pass
        time.sleep(every)
    return last


def png(w: int, h: int, seed: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3 + seed) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def make_folder(files: dict[str, bytes | str], name: str = "study") -> Path:
    """`{"scans/alpha.png": b"...", "notes.csv": "a,b"}` → a temp folder `<name>/…`."""
    root = Path(tempfile.mkdtemp(prefix="files-e2e-")) / name
    for rel, data in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            p.write_text(data)
        else:
            p.write_bytes(data)
    return root


def api(page, path: str, method: str = "GET", body: dict | None = None):
    return page.evaluate(
        "async ([path, method, body]) => { const r = await fetch('/api/v1' + path, { method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }",
        [path, method, body],
    )


def kernel_ok(page, base: str) -> bool:
    page.goto(base + "/")
    return api(page, "/projects")["status"] == 200 and page.evaluate("async () => (await fetch('/api/v1/health')).ok")


def new_project(page, base: str, title: str, folder: Path, *, inspected: bool = True) -> tuple[str, str]:
    """A scratch project with `folder` uploaded; returns (project id, the folder's node id).
    `inspected=False` returns once the bytes are in (the worker may still be inspecting)."""
    pid = api(page, "/projects", "POST", {"title": title})["json"]["id"]
    page.goto(f"{base}/projects/{pid}/files")
    page.wait_for_selector("[data-testid=drop-zone]", timeout=20000)
    page.locator("[data-testid=pick-folder]").first.set_input_files(str(folder))
    dlg = page.locator("[data-testid=attestation]")
    if wait(lambda: dlg.is_visible(), 5, 0.2):
        dlg.get_by_role("checkbox").click()
        page.get_by_test_id("attest-confirm").click()
    done = wait(lambda: (lambda i: i and i[0]["state"] in ("ready", "needs_review", "imported", *(() if inspected else ("inspecting",))) and i[0])(api(page, f"/projects/{pid}/imports")["json"]["imports"]), 90 if inspected else 240)
    if not done:
        raise RuntimeError("the upload didn't finish")
    root = children(page, pid)
    top = next(n for n in root if n["name"] == folder.name)
    return pid, top["id"]


def children(page, pid: str, node: str | None = None) -> list[dict]:
    q = f"?node={node}" if node else ""
    return api(page, f"/projects/{pid}/fs/children{q}")["json"]["items"]


def names(page, pid: str, node: str | None = None) -> list[str]:
    return [n["name"] for n in children(page, pid, node)]


def child(page, pid: str, parent: str, name: str) -> dict | None:
    return next((n for n in children(page, pid, parent) if n["name"] == name), None)


def open_folder(page, base: str, pid: str, node: str) -> None:
    page.goto(f"{base}/projects/{pid}/files/{node}")
    page.wait_for_selector("[data-testid=sources-listing]", timeout=20000)
    page.wait_for_function("!document.querySelector('[data-testid=sources-listing]')?.getAttribute('aria-busy')", timeout=20000)
    page.wait_for_timeout(500)


def list_view(page) -> None:
    if page.locator("[data-testid=sources-listing][data-view=grid]").count():
        page.get_by_role("radio", name="List view").click()
        page.wait_for_selector("[data-testid=sources-listing][data-view=list]", timeout=5000)


def grid_view(page) -> None:
    if page.locator("[data-testid=sources-listing][data-view=list]").count():
        page.get_by_role("radio", name="Grid view").click()
        page.wait_for_selector("[data-testid=sources-listing][data-view=grid]", timeout=5000)


def row(page, name: str):
    return page.locator("[data-testid=listing-row], [data-testid=listing-tile]").filter(has_text=name).first


def row_names(page) -> list[str]:
    return page.locator("[data-testid=listing-row] [data-testid=row-name]").all_inner_texts()


def toasts(page) -> list[str]:
    return [t.replace("\n", " | ") for t in page.locator("[data-sonner-toast]").all_inner_texts()]


def toast_with(page, text: str, timeout: float = 10.0) -> str | None:
    return wait(lambda: next((t for t in toasts(page) if text in t), None), timeout)


_DRAG = """async ([srcSels, dstSel, alt]) => {
  const dt = new DataTransfer();
  const src = document.querySelector(srcSels);
  if (!src) return 'no source';
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 250));
  const dst = document.querySelector(dstSel);
  if (!dst) return 'no target';
  const r = dst.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + Math.min(30, r.width / 2), clientY: r.top + r.height / 2, altKey: alt };
  dst.dispatchEvent(new DragEvent('dragenter', o));
  dst.dispatchEvent(new DragEvent('dragover', o));
  await new Promise((r) => setTimeout(r, 250));
  const reason = document.querySelector('[data-testid=drag-chip-reason]')?.textContent ?? '';
  dst.dispatchEvent(new DragEvent('drop', o));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return reason;
}"""


def drag(page, src_selector: str, dst_selector: str, alt: bool = False) -> str:
    """Drag the first element matching `src_selector` onto `dst_selector`; returns the refusal shown, if any."""
    return page.evaluate(_DRAG, [src_selector, dst_selector, alt])


def sel_row(name: str) -> str:
    """A CSS selector for a listing row or tile by its node id is better; this finds it by name via an attribute set by `mark`."""
    return f"[data-e2e-mark='{name}']"


def mark(page, name: str, scope: str = "[data-testid=listing-row], [data-testid=listing-tile], [role=treeitem], [data-testid=path-segment], [data-testid=path-root]") -> None:
    """Tag the element showing `name` with `data-e2e-mark` so `drag` can find it by CSS."""
    page.evaluate(
        "([name, scope]) => { for (const e of document.querySelectorAll(scope)) { const own = e.querySelector('[data-testid=row-name]') ?? e; if (own.textContent.trim().split('\\n')[0].startsWith(name)) { e.setAttribute('data-e2e-mark', name); return true; } } return false; }",
        [name, scope],
    )


def fetch_bytes(page, path: str, method: str = "GET", body: dict | None = None) -> tuple[int, bytes]:
    r = page.evaluate(
        "async ([path, method, body]) => { const r = await fetch('/api/v1' + path, { method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined }); const b = new Uint8Array(await r.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return [r.status, btoa(s)]; }",
        [path, method, body],
    )
    return r[0], base64.b64decode(r[1])


def add_member(pid: str, principal: str, role: str = "editor") -> bool:
    """Make `principal` a member of the project's organization, for tests with a second person.
    The kernel has no members API yet, so this writes the API's SQLite database directly: it
    needs the same `INKLING_API_DATA_DIR` the API was started with (default database only)."""
    data = os.environ.get("INKLING_API_DATA_DIR")
    db = Path(data) / "api.db" if data else None
    if not db or not db.exists():
        return False
    con = sqlite3.connect(db, timeout=30)
    try:
        org = con.execute("select org_id from projects where id = ?", (pid,)).fetchone()
        if not org:
            return False
        con.execute("insert or ignore into organization_members (org_id, principal, role) values (?, ?, ?)", (org[0], principal, role))
        con.commit()
        return True
    finally:
        con.close()
