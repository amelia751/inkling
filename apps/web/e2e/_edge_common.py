"""Shared bits of the todo18 edge e2e tests (edge_session_test.py, edge_stuck_test.py)."""

from __future__ import annotations

import time

UPLOADS = "/src/studio/stores/uploads.ts"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def uploads(page, js: str):
    """Run `js` (an async function body, `u` = the uploads module) in the page."""
    return page.evaluate(f"async () => {{ const u = await import('{UPLOADS}'); {js} }}")


def seed_session(page, phase: str, import_id: str = "imp_e2e") -> None:
    """A tray entry as if an upload were under way (the shell mounts the tray)."""
    uploads(
        page,
        f"""u.useUploads.setState((s) => ({{ sessions: [{{ key: 'e2e-1', projectId: 'p', importId: '{import_id}', title: 'scans', phase: '{phase}',
            total: 2, prepared: 2, skippedJunk: 0, checkingSince: Date.now(),
            files: [{{ clientFileId: 'f0', relPath: 'scans/a.png', size: 10, received: 4, state: 'pending', reason: null }}] }}, ...s.sessions] }}));""",
    )


def wait_text(page, text: str, timeout: float = 10) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if text in page.inner_text("body"):
            return True
        time.sleep(0.2)
    return False


def finish() -> int:
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    return 1 if bad else 0
