"""todo29 W1/W5: attaching never sends, attachments are tiles (seed mode, mocked writes).

On an empty project's Overview, files attached to the composer show as tiles in it; no message
is queued and the drawer stays shut. Typing and Send queue one message carrying the drop and
open the drawer. No "Checking" (or any other pipeline word) shows anywhere.

The seed stand-in can't take files (adding files needs the kernel), so the attachment is put in
the composer's store the way `useChatDrop` does after a drop (a local drop whose bytes haven't
moved: its tiles are loading); the drop handler itself is covered by
`src/studio/app/entry/chat-attach.test.ts`, the full upload by `chat_drop_test.py`.

    STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort   # in apps/web
    python3 e2e/chat_attach_test.py --port 5199
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"
PENDING = "/src/studio/app/entry/pending-ask.ts"
ATTACH = "/src/studio/app/entry/composer-attachments.ts"
DROPS = "/src/studio/core/drops/store.ts"
WORDS = ["Checking", "Ready", "In the Studio", "Kept in Sources", "Preparing"]


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def json_route(body, status: int = 200):
    return lambda route: route.fulfill(status=status, content_type="application/json", body=json.dumps(body))


def patched(transform):
    def handle(route):
        r = route.fetch()
        route.fulfill(response=r, body=json.dumps(transform(r.json())))

    return handle


ATTACH_JS = """
async ([projectId, n]) => {
  const drops = await import('%s');
  const attach = await import('%s');
  const id = 'drp-e2e-1';
  drops.useDrops.getState().put({ id, projectId, origin: 'chat', conversationId: 'conv-e2e', files: Array.from({ length: n }, (_, i) => ({ relPath: `cxr_${String(i).padStart(2, '0')}.png`, size: 100 + i })), uploadKeys: [], createdAt: Date.now() });
  attach.useComposerAttachments.getState().attach(projectId, { drop: { dropId: id, messageId: 'msg-e2e-1' } });
  return id;
}
""" % (DROPS, ATTACH)


def no_pipeline_words(page) -> tuple[bool, str]:
    text = page.locator("[data-testid=empty-project]").inner_text()
    hit = [w for w in WORDS if w in text]
    return not hit, ", ".join(hit)


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route(f"**/api/v1/projects/{P}/overview", patched(lambda o: {**o, "empty": True, "data": [], "tasks": [], "resume": None, "latestImport": None}))
        page.route("**/api/agent/sessions", json_route({"error": "The agent service isn't running"}, 502))
        page.goto(f"{base}/projects/{P}/overview")
        page.wait_for_selector("[data-testid=empty-project-input]", timeout=30000)

        page.evaluate(ATTACH_JS, [P, 10])
        tiles = page.locator("[data-testid=empty-project] [data-testid=attachment-tile]")
        tiles.first.wait_for(timeout=10000)
        more = page.locator("[data-testid=empty-project] [data-testid=attachment-more]")
        check("attached files are tiles in the empty composer", tiles.count() == 7 and more.inner_text().strip() == "+3", f"{tiles.count()} tiles, more={more.inner_text() if more.count() else None}")
        states = set(tiles.evaluate_all("els => els.map(e => e.dataset.state)"))
        check("tiles not yet uploaded are loading", states == {"loading"}, str(states))
        more.click()
        check("+N expands to every tile", tiles.count() == 10, str(tiles.count()))
        ok, hit = no_pipeline_words(page)
        check("no Checking / Ready / Preparing words", ok, hit)
        asks = page.evaluate(f"async () => (await import('{PENDING}')).usePendingAsks.getState().asks")
        check("attaching queues no message", not asks, json.dumps(asks))
        check("the drawer stays shut", page.locator("[data-testid=agent-drawer-collapsed]").count() == 1 and page.locator("[data-testid=agent-drawer]").count() == 0)
        check("Send works with only attachments", page.get_by_test_id("composer-send").is_enabled())

        page.locator("[data-testid=empty-project-input]").fill("Make me a Studio")
        page.get_by_test_id("composer-send").click()
        page.wait_for_selector("[data-testid=agent-drawer]", timeout=10000)
        check("Send opens the drawer", True)
        # The drawer takes the queued message at once when the agent is up; here it isn't, so the
        # ask either stays queued or was taken with the drop. Either way it carried text + drop.
        asks = page.evaluate(f"async () => (await import('{PENDING}')).usePendingAsks.getState().asks")
        queued = asks.get(P)
        check("one message with the text and the drop", queued is None or (queued.get("text") == "Make me a Studio" and (queued.get("drop") or {}).get("dropId") == "drp-e2e-1"), json.dumps(asks))
        check("the composer's tiles are gone after Send", page.locator("[data-testid=empty-project] [data-testid=attachment-tile]").count() == 0)
        check("no Checking text anywhere", page.get_by_text("Checking", exact=False).count() == 0)
        check("no page errors", not errors, "; ".join(errors[:3]))
        ctx.close()
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
