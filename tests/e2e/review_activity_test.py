"""todo6 Phase 8 exit, against the kernel: every review queue item type clicks through to the
right place, and Activity shows a mixed import's events in order with the right actors.

Two things this test plays because their owners land in other phases: the inspection worker's
privacy flag and "can't read" kind (Phase 5) and apps/versioning's review (the kernel's own audit entry for
`versioning.review.open`, which is what the queue reads). Both go straight to the kernel's
database, so the API must run on the same `<envPrefix>API_DATABASE_URL` as this script:

    export STUDIO_API_DATABASE_URL=sqlite:////tmp/p8.sqlite STUDIO_API_DATA_DIR=/tmp/p8-data
    uv run --package studio-api uvicorn studio_api.app:app --port 8208          # repo root
    STUDIO_API_URL=http://127.0.0.1:8208 STUDIO_E2E=1 pnpm exec vite --port 5208 --strictPort   # apps/web
    uv run --package studio-api python tests/e2e/review_activity_test.py --port 5208       # repo root
"""

from __future__ import annotations

import hashlib
import json
import re
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))

from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def png(w: int, h: int) -> bytes:
    raw = b"".join(b"\x00" + bytes([(x * 7 + y * 3 + w) % 256 for x in range(w)]) for y in range(h))

    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class Api:
    """JSON calls through the dev server's /api proxy (the browser's own path to the kernel)."""

    def __init__(self, request, base: str):
        self.r, self.base = request, base

    def __call__(self, method: str, path: str, body=None, headers=None, raw: bytes | None = None):
        h = {"Content-Type": "application/json", **(headers or {})} if raw is None else (headers or {})
        res = self.r.fetch(self.base + "/api" + path, method=method, headers=h, data=raw if raw is not None else (json.dumps(body) if body is not None else None))
        text = res.text()
        try:
            return res.status, json.loads(text) if text else None
        except ValueError:
            return res.status, text


def import_files(api: Api, project_id: str, files: dict[str, bytes], prefix: str, damage: set[str] = frozenset()) -> dict:
    body = {"attested": True, "files": [{"clientFileId": f"{prefix}{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    _, s = api("POST", f"/v1/projects/{project_id}/imports", body)
    for f in s["files"]:
        if f.get("uploadUrl"):
            rel = next(r for r in files if r.endswith(f["relPath"]))
            data = b"x" * len(files[rel]) if rel in damage else files[rel]
            url = f["uploadUrl"].removeprefix("/api")
            api("PUT", url, raw=data, headers={"Content-Type": "application/octet-stream"})
    _, done = api("POST", f"/v1/imports/{s['id']}/complete")
    return done


def play_worker_and_versioning(project_id: str, node_id: str, unknown_id: str, dataset_id: str) -> None:
    from studio_api import db as kdb
    from studio_api.context import RequestContext
    from studio_api.kernel import audit
    from studio_api.models import SourceNode

    with kdb.session_scope() as s:
        n = s.get(SourceNode, node_id)
        n.flags = {**(n.flags or {}), "privacy": {"reason": "header has a patient name field"}}
        s.get(SourceNode, unknown_id).detected_kind = "unknown"
        audit.record(s, RequestContext(project_id, "user:local-expert", "e2e"), "versioning.review.open", target=f"dataset:{dataset_id}", after={"reviewId": "rv-e2e", "source": "work/local-expert", "target": "main"})


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        api = Api(ctx.request, base)
        try:
            ok, _ = api("GET", "/v1/projects")
            if ok != 200 or api("GET", "/healthz")[0] == 404 and api("GET", "/v1/health")[0] != 200:
                print("SKIP kernel not reachable through the dev server proxy")
                return 0

            # ---- A mixed import, step by step (Activity checks the order and the actors). ----
            _, p = api("POST", "/v1/projects", {"title": "Phase 8 e2e"})
            pid = p["id"]
            files = {"study/scans/scan1.png": png(8, 8), "study/scans/scan2.png": png(9, 9), "study/notes.weird": b"\x00\x01unknown"}
            import_files(api, pid, files, "a")
            _, srcs = api("GET", f"/v1/projects/{pid}/sources")
            src = srcs["sources"][0]
            _, top = api("GET", f"/v1/sources/{src['id']}/children")
            def all_files(node=None):
                _, page_ = api("GET", f"/v1/sources/{src['id']}/children" + (f"?node={node}" if node else ""))
                out = []
                for k in page_["items"]:
                    out += all_files(k["id"]) if k["kind"] == "folder" else [k]
                return out
            listed = all_files()
            scan = next(f for f in listed if f["name"] == "scan1.png")
            weird = next(f for f in listed if f["name"] == "notes.weird")
            # The assistant proposes, for the person; the person confirms.
            _, sess = api("POST", "/v1/sessions", {"scopes": ["proposals.write"], "agent": "run-e2e"}, headers={"X-Workspace-Id": pid})
            agent = {"Authorization": f"Bearer {sess['token']}"}
            _, linked = api("POST", f"/v1/projects/{pid}/proposals", {"kind": "relationship", "payload": {"summary": "scans ↔ notes"}, "strength": "possible"}, headers=agent)
            api("POST", f"/v1/proposals/{linked['id']}/confirm", {})
            # A dataset with a task (the person, through the API like the New dataset form).
            _, ds = api("POST", f"/v1/projects/{pid}/datasets", {"title": "Scans", "nodeIds": [src["rootNodeId"]], "task": {"title": "Outline", "preset": "preset:image-2d"}})
            task = ds["tasks"][0]["id"]

            # ---- Everything that waits for a person. ----
            play_worker_and_versioning(pid, scan["id"], weird["id"], ds["id"])
            import_files(api, pid, {"later/x.png": png(12, 12)}, "b", damage={"later/x.png"})
            _, open_prop = api("POST", f"/v1/projects/{pid}/proposals", {"kind": "relationship", "payload": {"summary": "notes ↔ scans"}, "evidence": {"unmatched": 7}, "strength": "possible"}, headers=agent)
            ann = {"id": "e2e-s", "itemId": "x", "label": "l", "provenance": "ai-suggested", "author": "m", "createdAt": "2026-10-30T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}, "attributes": {"review_status": "pending"}}
            api("PUT", f"/annotations/{task}", {"revision": 0, "annotations": [ann]}, headers={"X-Workspace-Id": task})

            expected = {
                "privacy": (rf"/projects/{pid}/sources/{scan['id']}$", "[data-testid=section-sources], main"),
                "import": (rf"/projects/{pid}/sources\?import=imp", None),
                "quality": (rf"/projects/{pid}/sources/.+\?status=unsupported", None),
                "proposal": (rf"/projects/{pid}/explore/relationships\?proposal={open_prop['id']}$", None),
                "version-review": (rf"/projects/{pid}/datasets/{ds['id']}/versions/reviews/rv-e2e$", None),
                "annotations": (rf"/projects/{pid}/studio/{task}$", None),
            }
            page.goto(f"{base}/projects/{pid}/review")
            page.wait_for_selector("[data-testid=review-row]", timeout=20000)
            types = page.locator("[data-testid=review-row]").evaluate_all("rows => rows.map(r => r.dataset.type)")
            check("Review lists every item type", set(types) == set(expected), str(types))
            check("most severe first", types[0] in ("privacy", "import") and types[1] in ("privacy", "import"), str(types[:2]))
            for kind, (pattern, _) in expected.items():
                page.goto(f"{base}/projects/{pid}/review")
                row = page.locator(f"[data-testid=review-row][data-type='{kind}']").first
                row.wait_for(timeout=20000)
                row.click()
                page.wait_for_url(re.compile(pattern), timeout=15000)
                check(f"Review › {kind} opens its surface", re.search(pattern, page.url) is not None, page.url)
            # Filters by type, severity and dataset.
            page.goto(f"{base}/projects/{pid}/review?severity=high")
            page.wait_for_selector("[data-testid=review-row]", timeout=20000)
            sev = set(page.locator("[data-testid=review-row]").evaluate_all("rows => rows.map(r => r.dataset.severity)"))
            check("severity filter", sev == {"high"}, str(sev))
            page.goto(f"{base}/projects/{pid}/review?dataset={ds['id']}")
            page.wait_for_selector("[data-testid=review-row]", timeout=20000)
            dtypes = set(page.locator("[data-testid=review-row]").evaluate_all("rows => rows.map(r => r.dataset.type)"))
            check("dataset filter", dtypes == {"privacy", "version-review", "annotations"}, str(dtypes))
            # Overview's attention is the top 5 of the same queue, and clicks through the same way.
            page.goto(f"{base}/projects/{pid}/overview")
            page.wait_for_selector("[data-testid=attention-row]", timeout=20000)
            over = page.locator("[data-testid=attention-row]").evaluate_all("rows => rows.map(r => r.dataset.type)")
            check("Overview attention = top 5 of Review", over == types[:5], f"{over} vs {types[:5]}")
            page.locator("[data-testid=attention-row]").first.click()
            page.wait_for_url(re.compile(expected[over[0]][0]), timeout=15000)
            check("Overview attention row opens its surface", True, page.url)

            # ---- Activity: the import flow, in order, with the right actors. ----
            api("POST", f"/v1/source-nodes/{scan['id']}/privacy/clear", {"reason": "synthetic"})
            page.goto(f"{base}/projects/{pid}/activity")
            page.wait_for_selector("[data-testid=activity-entry]", timeout=20000)
            rows = page.locator("[data-testid=activity-entry]").evaluate_all(
                "rows => rows.map(r => ({ action: r.dataset.action, kind: r.dataset.actorKind, actor: r.querySelector('[data-testid=activity-actor]').textContent }))"
            )
            flow = [r for r in reversed(rows) if r["action"] in ("project.created", "import.started", "import.completed", "proposal.created", "proposal.confirmed", "dataset.created", "task.created", "privacy.cleared")]
            first_import = [r["action"] for r in flow][:8]
            want = ["project.created", "import.started", "import.completed", "proposal.created", "proposal.confirmed", "dataset.created", "task.created", "import.started"]
            check("Activity: the import flow in order", first_import == want, str(first_import))
            prop = next(r for r in flow if r["action"] == "proposal.created")
            check("the assistant is named with the person it acted for", prop["kind"] == "assistant" and prop["actor"] == "Assistant for local-expert", str(prop))
            conf = next(r for r in flow if r["action"] == "proposal.confirmed")
            check("the person confirmed", conf["kind"] == "person" and conf["actor"] == "local-expert", str(conf))
            check("the privacy decision is in the feed", flow[-1]["action"] == "privacy.cleared", str(flow[-1]))
            check("grouped by day", page.locator("[data-testid=activity-day]").count() >= 1)
            page.locator("[data-testid=activity-entry][data-action='dataset.created']").click()
            page.wait_for_url(f"**/projects/{pid}/datasets/{ds['id']}", timeout=15000)
            check("an activity entry links to its artifact", True, page.url)

            # ---- Datasets: the API-backed dataset and Settings › General. ----
            page.goto(f"{base}/projects/{pid}/datasets")
            page.wait_for_selector(f"[data-testid=dataset-card][data-dataset-id='{ds['id']}']", timeout=20000)
            check("Datasets lists the new dataset", page.locator(f"[data-testid=task-row][data-task-id='{task}']").count() == 1)
            page.goto(f"{base}/projects/{pid}/settings/general")
            page.wait_for_selector("#project-title", timeout=20000)
            page.fill("#project-title", "Phase 8 e2e (renamed)")
            page.get_by_test_id("visibility-shared").click()
            page.get_by_test_id("save-settings").click()
            page.wait_for_selector("[data-testid=settings-saved]", timeout=10000)
            _, after = api("GET", f"/v1/projects/{pid}")
            check("Settings › General saves title and visibility", after["title"] == "Phase 8 e2e (renamed)" and after["visibility"] == "shared", str({k: after[k] for k in ("title", "visibility")}))
            check("Settings has no Archive, only Delete project", page.locator("[data-testid=archive-project]").count() == 0 and page.get_by_test_id("delete-project").count() == 1)
        finally:
            ctx.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
