"""Pipeline runs under Data (todo12 Milestone 1): the run list and one run's detail against
fixtures, live from the project event stream.

    INKLING_E2E=1 pnpm exec vite --port 5201 --strictPort      # in apps/web
    python3 e2e/pipeline_runs_test.py --port 5201 [--browser chromium] [--out e2e/.artifacts]

The gateway routes (`/api/v1/projects/:id/pipeline-runs`, `/api/v1/pipeline-runs/:id`,
`.../approve`) and the project SSE stream are answered by Playwright from
`e2e/fixtures/pipelines/` and an in-test event queue, so no API, pipeline or versioning service
runs and no seed data is read. The stream is served the way the kernel does it (`id:`,
`event:`, `data:` = the event's payload; a short `retry:` so the browser reconnects and
picks up the next queued events).

Checks the `data-testid` regression contract (`pipeline-run-row`, `pipeline-run-status`,
`pipeline-step-row`, `pipeline-file-report`, `pipeline-approve`), that events move a run and a
step without a reload (faster than the 10 s fallback poll), the per-file report with problems
first, the candidate link, Approve bound to the candidate digest with an idempotency key, the
button hidden for someone who may not approve, and a 404 for a run in another workspace.
Screenshots go to --out.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import Route, sync_playwright

FIX = Path(__file__).parent / "fixtures" / "pipelines"
PROJECT = "e2e-pipelines"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}", flush=True)


def parse_args() -> argparse.Namespace:
    # No seed check (harness.parse_args has one): this test reads no seed data.
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default=str(Path(__file__).parent / ".artifacts"))
    return ap.parse_args()


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text())


class Backend:
    """The gateway routes and the project stream, in memory. `push` queues an SSE event and
    applies it to the stored runs the way the server would (so a refetch agrees)."""

    def __init__(self, can_approve: bool = True):
        self.runs = load("runs.json")
        self.detail = {"run_review": load("run_review.json"), "run_live": load("run_live.json")}
        self.detail["run_review"]["review"]["can_approve"] = can_approve
        self.events: list[tuple[str, dict]] = []
        self.seq = 0
        self.approvals: list[dict] = []

    def set_state(self, run_id: str, state: str) -> None:
        for r in self.runs["runs"]:
            if r["run_id"] == run_id:
                r["state"] = state
        if run_id in self.detail:
            self.detail[run_id]["state"] = state

    def push(self, type_: str, payload: dict) -> None:
        payload = {"project_id": PROJECT, **payload}
        if "state" in payload:
            self.set_state(payload["run_id"], payload["state"])
        if type_.startswith("pipeline.step.") and payload.get("run_id") in self.detail:
            for s in self.detail[payload["run_id"]]["steps"]:
                if s["step_id"] == payload["step_id"]:
                    s["state"] = {"pipeline.step.started": "running", "pipeline.step.completed": "succeeded"}.get(type_, "failed")
        self.events.append((type_, payload))

    def install(self, ctx) -> None:
        summary = {"id": PROJECT, "orgId": "org_e2e", "title": "Pipeline e2e", "description": "", "visibility": "shared", "sample": False, "archived": False, "createdBy": "user:ana", "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-11-01T00:00:00Z", "lastActivityAt": "2026-11-01T09:20:00Z", "attested": True, "restricted": False}

        def json_(route: Route, body, status: int = 200) -> None:
            route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

        def projects(route: Route) -> None:
            path = route.request.url.split("?")[0]
            if path.endswith("/v1/projects"):
                return json_(route, {"projects": [summary]})
            if path.endswith(f"/v1/projects/{PROJECT}"):
                return json_(route, summary)
            if path.endswith(f"/v1/projects/{PROJECT}/pipeline-runs"):
                return json_(route, self.runs)
            if path.endswith(f"/v1/projects/{PROJECT}/events"):
                body = "retry: 300\n\n"
                while self.events:
                    t, p = self.events.pop(0)
                    self.seq += 1
                    body += f"id: evt_{self.seq}\nevent: {t}\ndata: {json.dumps(p)}\n\n"
                return route.fulfill(status=200, headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"}, body=body)
            return route.continue_()

        def runs(route: Route) -> None:
            req = route.request
            path = req.url.split("?")[0]
            rid = path.split("/pipeline-runs/")[1].split("/")[0]
            if path.endswith("/approve") and req.method == "POST":
                body = json.loads(req.post_data or "{}")
                self.approvals.append({"run_id": rid, "body": body, "key": req.headers.get("idempotency-key")})
                cand = self.detail[rid]["candidate"]["output_manifest_digest"]
                if body.get("candidate_digest") != cand:
                    return json_(route, {"detail": "candidate changed"}, 409)
                self.set_state(rid, "publishing")
                return json_(route, {"approval_id": f"ap_{rid}", "state": "publishing"})
            if rid in self.detail:
                return json_(route, self.detail[rid])
            return json_(route, {"detail": "Not Found"}, 404)

        ctx.route("**/api/v1/projects**", projects)
        ctx.route("**/api/v1/pipeline-runs/**", runs)


def rows_state(page) -> dict[str, str]:
    return page.evaluate("() => Object.fromEntries([...document.querySelectorAll('[data-testid=pipeline-run-row]')].map(r => [r.dataset.runId, r.querySelector('[data-testid=pipeline-run-status]')?.dataset.state]))")


def wait_for(fn, timeout: float = 5.0) -> tuple[bool, float]:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if fn():
            return True, time.time() - t0
        time.sleep(0.1)
    return False, time.time() - t0


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = getattr(pw, args.browser).launch(headless=not args.headed)

        # ---- A reviewer: list, live updates, detail, approve ----------------------------------
        be = Backend(can_approve=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        be.install(ctx)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"{base}/projects/{PROJECT}/files/pipelines")
        page.wait_for_selector("[data-testid=pipeline-run-row]", timeout=30000)
        states = rows_state(page)
        check("the list shows every run, newest first", list(states) == ["run_live", "run_review", "run_failed", "run_published"], str(list(states)))
        check("each row carries its status", states == {"run_live": "running", "run_review": "awaiting_review", "run_failed": "failed", "run_published": "published"}, str(states))
        check("status words, not engine words", page.locator("[data-testid=pipeline-run-row][data-run-id=run_review] [data-testid=pipeline-run-status]").inner_text() == "Needs review")
        review_counts = page.locator("[data-testid=pipeline-run-row][data-run-id=run_review] [data-testid=pipeline-run-counts]").inner_text()
        check("a row counts files, quarantined and rejected", "10 files" in review_counts and "1 quarantined" in review_counts and "1 rejected" in review_counts, review_counts)
        check("Data is the active section", page.locator("[data-testid=project-sidebar] a[aria-current=page]").inner_text().strip() == "Data", page.locator("[data-testid=project-sidebar] a[aria-current=page]").all_inner_texts().__repr__())
        page.get_by_role("radio", name="Needs review").click()
        check("the Needs review filter keeps only waiting runs", list(rows_state(page)) == ["run_review"], str(list(rows_state(page))))
        page.get_by_role("radio", name="All").click()
        page.wait_for_timeout(1000)  # let the stream connect
        page.screenshot(path=str(out / "pipeline-runs.png"), full_page=True)

        # An event moves a run without a reload (the fallback poll is 10 s).
        be.push("pipeline.run.completed", {"run_id": "run_live", "state": "awaiting_review"})
        ok, took = wait_for(lambda: rows_state(page).get("run_live") == "awaiting_review", 5.0)
        check("pipeline.run.completed from the stream updates the row", ok, f"{took:.1f}s")
        be.set_state("run_live", "running")  # put it back for the detail check below
        be.push("pipeline.run.started", {"run_id": "run_live", "state": "running"})

        # Detail of the live run: a step event moves the step.
        page.goto(f"{base}/projects/{PROJECT}/files/pipelines/run_live")
        page.wait_for_selector("[data-testid=pipeline-step-row]", timeout=20000)
        page.wait_for_timeout(800)
        derive = page.locator("[data-testid=pipeline-step-row][data-step-id=derive]")
        check("a running step shows as running", derive.get_attribute("data-state") == "running", str(derive.get_attribute("data-state")))
        be.push("pipeline.step.completed", {"run_id": "run_live", "step_id": "derive"})
        ok, took = wait_for(lambda: derive.get_attribute("data-state") == "succeeded", 5.0)
        check("pipeline.step.completed from the stream updates the step", ok, f"{took:.1f}s")
        check("no approve button on a running run", page.locator("[data-testid=pipeline-approve]").count() == 0)

        # The run waiting for review, from the list.
        page.goto(f"{base}/projects/{PROJECT}/files/pipelines")
        page.locator("[data-testid=pipeline-run-row][data-run-id=run_review]").click()
        page.wait_for_selector("[data-testid=pipeline-run-page][data-state=awaiting_review]", timeout=20000)
        steps = page.evaluate("() => [...document.querySelectorAll('[data-testid=pipeline-step-row]')].map(r => [r.dataset.stepId, r.dataset.state])")
        check("steps are listed in order with their states", steps == [["inspect", "succeeded"], ["validate", "succeeded"], ["derive", "succeeded"], ["propose", "succeeded"]], str(steps))
        check("a retried step says so", "attempt 2 of 3" in page.locator("[data-testid=pipeline-step-row][data-step-id=derive]").inner_text())
        report = page.locator("[data-testid=pipeline-file-report]")
        file_states = page.evaluate("() => [...document.querySelectorAll('[data-testid=pipeline-file-report] [data-testid=pipeline-file-row]')].map(r => r.dataset.state)")
        check("the per-file report lists all ten files", len(file_states) == 10, str(len(file_states)))
        check("problems come first in the report", file_states[:2] == ["quarantined", "rejected"], str(file_states[:3]))
        check("a quarantined file says why", "no DICM preamble" in report.locator("[data-testid=pipeline-file-row][data-state=quarantined]").inner_text())
        check("quarantined files have their own list", page.locator("[data-testid=pipeline-quarantined] [data-testid=pipeline-quarantined-row]").count() == 1)
        report.get_by_role("radio", name="Problems 2").click()
        check("the report filters to problems", report.locator("[data-testid=pipeline-file-row]").count() == 2)
        report.get_by_role("radio", name="All 10").click()
        href = page.locator("[data-testid=pipeline-candidate-link]").get_attribute("href") or ""
        check("the candidate links to its review", href == f"/projects/{PROJECT}/datasets/ds_study/versions/reviews/rv_42", href)
        approve = page.locator("[data-testid=pipeline-approve]")
        check("a reviewer sees Approve", approve.count() == 1 and approve.is_enabled())
        page.screenshot(path=str(out / "pipeline-run-review.png"), full_page=True)

        approve.click()
        page.wait_for_selector("[data-testid=pipeline-run-page][data-state=publishing]", timeout=10000)
        a = be.approvals[-1] if be.approvals else {}
        check("Approve sends the candidate digest", a.get("body") == {"candidate_digest": "sha256:5a1e0d00c0ffee11"}, str(a.get("body")))
        check("Approve carries an idempotency key", a.get("key") == "approve:run_review:sha256:5a1e0d00c0ffee11", str(a.get("key")))
        check("after approving, the button goes and the run is publishing", page.locator("[data-testid=pipeline-approve]").count() == 0)
        be.push("pipeline.run.completed", {"run_id": "run_review", "state": "published"})
        ok, took = wait_for(lambda: page.locator("[data-testid=pipeline-run-page]").get_attribute("data-state") == "published", 5.0)
        check("the published event lands on the open run", ok, f"{took:.1f}s")
        page.screenshot(path=str(out / "pipeline-run-published.png"), full_page=True)

        # A run from another workspace: a 404, shown as "Not found".
        page.goto(f"{base}/projects/{PROJECT}/files/pipelines/run_elsewhere")
        page.wait_for_selector("[data-testid=error-view]", timeout=20000)
        check("an unknown run is Not found", page.locator("[data-testid=error-view]").get_attribute("data-error") == "not-found")
        check("no page errors (reviewer)", not errors, "; ".join(errors[:3]))
        ctx.close()

        # ---- Someone who may not approve: no button --------------------------------------------
        be2 = Backend(can_approve=False)
        ctx2 = browser.new_context(viewport={"width": 1280, "height": 860})
        be2.install(ctx2)
        page2 = ctx2.new_page()
        errors2: list[str] = []
        page2.on("pageerror", lambda e: errors2.append(str(e)))
        page2.goto(f"{base}/projects/{PROJECT}/files/pipelines/run_review")
        page2.wait_for_selector("[data-testid=pipeline-run-page][data-state=awaiting_review]", timeout=30000)
        page2.wait_for_selector("[data-testid=pipeline-review-note]", timeout=10000)
        check("no Approve for someone who may not approve", page2.locator("[data-testid=pipeline-approve]").count() == 0)
        check("they're told it waits for a reviewer", "Waiting for a reviewer" in page2.locator("[data-testid=pipeline-review-note]").inner_text())
        check("no page errors (non-reviewer)", not errors2, "; ".join(errors2[:3]))

        # Narrow window: still readable, no horizontal scroll.
        page2.set_viewport_size({"width": 390, "height": 844})
        page2.wait_for_timeout(300)
        scroll = page2.evaluate("() => { const m = document.querySelector('main'); return m ? m.scrollWidth - m.clientWidth : 0; }")
        check("no horizontal scroll at phone width", scroll <= 1, f"{scroll}px")
        page2.screenshot(path=str(out / "pipeline-run-narrow.png"), full_page=True)
        ctx2.close()
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed; screenshots in {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
