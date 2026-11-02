"""Changes, Health, Rules and Connected agents (todo17 Milestones 2-4, the browser half).

By default the change-request, findings, rules and connected-agents routes are answered in the
browser (page.route) with the round-2 contracts, so this runs on a frozen dev server with no
backend. `--live` drives the real API instead and skips when those routes aren't there yet (404).

- Changes is in the project nav; the list shows title, author, agent badge and state.
- A change opens with its diff (op, path, before -> after), findings and comments; Merge on a
  stale base shows "needs update" inline; Close closes it. No changes: "No change requests."
- Health on Overview: counts by severity, findings grouped by rule (catalogue titles), Fix,
  "Would have rejected N writes" with Promote, the gardener; "Using the <preset> rules".
- Settings > Rules: a rejected save shows each violation by its field (path -> message).
- Settings > Connected agents: list and Revoke; empty state after.

    INKLING_E2E=1 pnpm exec vite --port 5199 --strictPort
    python3 e2e/todo17_changes_health_test.py --port 5199 [--live]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from harness import launch, parse_args, sync_playwright  # noqa: E402

results: list[tuple[str, bool, str]] = []
P = "2d-xray"
SHOTS = Path(__file__).parent / "screenshots"
LIVE = "--live" in sys.argv
if LIVE:
    sys.argv.remove("--live")


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' — {detail}' if detail else ''}")


NOW = "2026-11-02T10:00:00Z"


def cr(cid: str, title: str, state: str = "passed", agent: str | None = "Claude Code") -> dict:
    return {
        "id": cid, "projectId": P, "title": title, "actor": f"agent:{agent}" if agent else "amelia", "onBehalfOf": "amelia" if agent else None,
        "agent": agent, "state": state, "operations": [{"op": "rules.patch", "input": {}}], "findings": [], "base": {"rules": 3},
        "createdAt": NOW, "updatedAt": NOW, "mergedBy": None, "mergedAt": None, "comments": [],
    }


class FakeApi:
    """The round-2 contracts, in memory."""

    def __init__(self) -> None:
        self.changes = {
            "c1": {**cr("c1", "Add PNA as a synonym of pneumonia"), "diff": [{"op": "replace", "path": "/labels/1/synonyms", "before": [], "after": ["PNA"]}]},
            "c2": {**cr("c2", "Rename dataset", state="needs-update", agent=None), "diff": [{"op": "replace", "path": "/name", "before": "old", "after": "new"}],
                   "findings": [{"rule": "dataset.metadata-missing", "severity": "error", "path": "/metadata/license", "message": "License is required", "fix": "Fill it in"}]},
        }
        self.findings = [
            {"id": "f1", "resourceKind": "file", "resourceId": "n1", "rule": "layout.misplaced", "severity": "warn", "path": "/path", "message": "File is outside images/", "fix": "Move it", "fixable": True, "mode": "evaluate", "source": "scan", "firstSeen": NOW, "resolvedAt": None},
            {"id": "f2", "resourceKind": "annotation", "resourceId": "a1", "rule": "label.unknown", "severity": "error", "path": "/label", "message": "PNA isn't a label", "fix": "Use pneumonia", "fixable": False, "mode": "enforce", "source": "write", "firstSeen": NOW, "resolvedAt": None},
        ]
        self.rejected = {"layout.misplaced": 3}
        self.agents = [{"id": "a1", "clientName": "Claude Code", "scopes": ["project:read", "project:write"], "createdAt": NOW, "lastUsedAt": NOW}]
        self.promoted: list[dict] = []
        self.gardener = 0

    def handle(self, route) -> None:
        req = route.request
        path = re.sub(r"^.*?/v1/", "/", req.url.split("?")[0])
        m = req.method
        body = json.loads(req.post_data) if req.post_data else {}

        def ok(data, status=200, ctype="application/json"):
            route.fulfill(status=status, content_type=ctype, body="" if data is None else json.dumps(data))

        base = f"/projects/{P}"
        if path == f"{base}/changes" and m == "GET":
            state = "all" if "state=all" in req.url else "open"
            rows = [{k: v for k, v in c.items() if k != "diff"} for c in self.changes.values() if state == "all" or c["state"] not in ("merged", "closed")]
            return ok({"changes": rows})
        mm = re.fullmatch(rf"{base}/changes/([^/]+)(/merge|/close|/comments)?", path)
        if mm:
            c = self.changes.get(mm.group(1))
            if not c:
                return ok({"detail": "Not found"}, 404)
            action = mm.group(2)
            if action == "/merge":
                if c["state"] == "needs-update":
                    return ok({"detail": {"error": "The base moved and checks fail", "code": "needs-update"}}, 409)
                c["state"] = "merged"
                c["mergedBy"] = "amelia"
            elif action == "/close":
                c["state"] = "closed"
            elif action == "/comments":
                com = {"id": f"m{len(c['comments']) + 1}", "author": "amelia", "body": body.get("body", ""), "createdAt": NOW}
                c["comments"].append(com)
                return ok(com, 201)
            return ok(c)
        if path == f"{base}/findings":
            counts = {s: sum(1 for f in self.findings if f["severity"] == s) for s in ("error", "warn", "info")}
            return ok({"findings": self.findings, "counts": counts, "wouldHaveRejected": self.rejected})
        mm = re.fullmatch(rf"{base}/findings/([^/]+)/fix", path)
        if mm:
            self.findings = [f for f in self.findings if f["id"] != mm.group(1)]
            return ok({"applied": True})
        if path == f"{base}/rules/promote":
            self.promoted.append(body)
            self.rejected.pop(body.get("rule"), None)
            return ok({"rules": {}, "revision": 4})
        if path == f"{base}/gardener":
            self.gardener += 1
            return ok({"changeRequests": [cr("c3", "Move misplaced files", state="open")]})
        if path == f"{base}/rules/history":
            return ok({"history": [{"revision": 3, "rules": {}, "actor": "amelia", "onBehalfOf": None, "createdAt": NOW}]})
        if path == f"{base}/rules":
            if m == "PUT":
                return route.fulfill(status=422, content_type="application/problem+json", body=json.dumps({
                    "type": "/docs/lint-rules#write_rejected", "title": "The rules aren't valid", "status": 422, "code": "write_rejected", "retryable": False,
                    "violations": [{"rule": "rules.invalid", "severity": "error", "path": "/labels/0/name", "message": "\"PNA\" already names label pneumonia", "fix": "Pick another name"}],
                }))
            return ok({"rules": {"version": 1, "labels": [{"id": "normal", "name": "normal", "synonyms": [], "allowedGeometries": []}, {"id": "pneumonia", "name": "pneumonia", "synonyms": ["PNA"], "allowedGeometries": ["box"]}],
                                 "layout": {"folderPatterns": [], "forbiddenCharacters": ""}, "datasets": {"requiredMetadata": [], "oneModalityPerDataset": False, "uniqueNames": True},
                                 "annotations": {"insideImage": True, "requiredAttributes": []}, "imaging": {"checks": {}}, "severityOverrides": {}, "merge": {"auto": "write-tier"}},
                       "revision": 3, "source": "preset", "preset": "chest-xray"})
        if path == "/me/connected-agents" and m == "GET":
            return ok({"agents": self.agents})
        mm = re.fullmatch(r"/me/connected-agents/([^/]+)", path)
        if mm and m == "DELETE":
            self.agents = [a for a in self.agents if a["id"] != mm.group(1)]
            return route.fulfill(status=204, body="")
        return route.continue_()


ROUTES = re.compile(r".*/v1/(projects/[^/]+/(changes|findings|rules|gardener)|me/connected-agents)(/.*)?(\?.*)?$")


def main() -> int:
    args = parse_args()
    base = f"http://localhost:{args.port}"
    SHOTS.mkdir(exist_ok=True)
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        if LIVE:
            if page.request.get(f"{base}/api/v1/projects/{P}/changes").status in (404, 405, 501) or page.request.get(f"{base}/api/v1/projects/{P}/findings").status in (404, 405, 501):
                print("SKIP --live needs the change-request and findings routes (todo17 round 2 backends)")
                return 0
        else:
            fake = FakeApi()
            page.route(ROUTES, fake.handle)

        # ---- Changes in the nav, the list ----
        page.goto(f"{base}/projects/{P}/overview")
        page.get_by_test_id("nav-changes").click()
        page.get_by_test_id("changes-page").wait_for(timeout=20000)
        check("Changes opens from the project nav", page.url.endswith(f"/projects/{P}/changes"))
        if not LIVE:
            rows = page.get_by_test_id("change-row")
            rows.first.wait_for(timeout=10000)
            check("the list shows open change requests", rows.count() == 2)
            first = page.locator("[data-testid=change-row][data-change-id=c1]")
            check("rows show author and agent badge", "Claude Code for amelia" in first.get_by_test_id("change-author").inner_text() and first.get_by_test_id("change-agent").count() == 1)
            check("rows show the state", first.get_by_test_id("change-state").inner_text() == "Checks passed")
            page.screenshot(path=str(SHOTS / "todo17_changes.png"))

            # ---- Detail: diff, comment, merge ----
            first.click()
            page.get_by_test_id("change-detail").wait_for()
            diff = page.get_by_test_id("change-diff-row").first
            diff.wait_for(timeout=10000)
            check("detail shows the diff before -> after", diff.get_by_test_id("change-before").inner_text() == "[]" and diff.get_by_test_id("change-after").inner_text() == '["PNA"]')
            page.get_by_test_id("change-comment-input").fill("Looks right")
            page.get_by_test_id("change-comment-submit").click()
            page.get_by_test_id("change-comment").first.wait_for(timeout=10000)
            check("comments post", "Looks right" in page.get_by_test_id("change-comment").first.inner_text())
            page.get_by_test_id("change-merge").click()
            page.wait_for_function("() => document.querySelector('[data-testid=change-detail] [data-state]')?.getAttribute('data-state') === 'merged'", timeout=10000)
            check("Merge merges", page.get_by_test_id("change-merge").count() == 0)

            # ---- A stale change: 409 needs update, findings, Close ----
            page.goto(f"{base}/projects/{P}/changes/c2")
            page.get_by_test_id("change-findings").wait_for(timeout=10000)
            check("detail shows findings with severity", page.locator("[data-testid=change-findings] [data-testid=finding][data-severity=error]").count() == 1)
            page.get_by_test_id("change-merge").click()
            page.get_by_test_id("change-needs-update").wait_for(timeout=10000)
            check("a stale merge shows needs update inline", "needs an update" in page.get_by_test_id("change-needs-update").inner_text())
            page.get_by_test_id("change-close").click()
            page.wait_for_function("() => document.querySelector('[data-testid=change-detail] [data-state]')?.getAttribute('data-state') === 'closed'", timeout=10000)
            check("Close closes", True)
            page.goto(f"{base}/projects/{P}/changes")
            page.get_by_test_id("changes-empty").wait_for(timeout=10000)
            check("no open changes: the empty state", "No change requests." in page.get_by_test_id("changes-empty").inner_text())

            # ---- Health on Overview ----
            page.goto(f"{base}/projects/{P}/overview")
            health = page.get_by_test_id("health")
            health.wait_for(timeout=20000)
            page.get_by_test_id("health-counts").wait_for(timeout=10000)
            check("Health counts by severity", page.get_by_test_id("health-count-error").inner_text().startswith("1") and page.get_by_test_id("health-count-warn").inner_text().startswith("1"))
            groups = page.get_by_test_id("health-group")
            check("findings grouped by rule, worst first, with catalogue titles", groups.count() == 2 and groups.first.get_attribute("data-rule") == "label.unknown" and "Label isn't in the project's rules" in groups.first.inner_text())
            check("rules source line", "Using the chest-xray rules" in page.get_by_test_id("health-rules-source").inner_text())
            check("would have rejected N writes", "Would have rejected 3 writes" in page.get_by_test_id("health-would-reject").first.inner_text())
            page.screenshot(path=str(SHOTS / "todo17_health.png"))
            page.get_by_test_id("health-promote").first.click()
            page.wait_for_function("() => !document.querySelector('[data-testid=health-would-reject]')", timeout=10000)
            check("Promote sends error severity", fake.promoted == [{"rule": "layout.misplaced", "severity": "error"}])
            page.get_by_test_id("health-gardener").click()
            page.wait_for_timeout(500)
            check("Tidy with the gardener calls the gardener", fake.gardener == 1)
            page.get_by_test_id("health-fix").first.click()
            page.wait_for_function("() => document.querySelectorAll('[data-testid=health-group]').length === 1", timeout=10000)
            check("Fix applies and the finding goes", page.get_by_test_id("health-fix").count() == 0)

            # ---- Settings > Rules: violations inline ----
            page.goto(f"{base}/projects/{P}/settings/rules")
            page.get_by_test_id("rules-editor").wait_for(timeout=20000)
            check("Rules says it's using the preset", "Using the chest-xray rules" in page.get_by_test_id("rules-source").inner_text())
            page.get_by_test_id("rules-label-name").first.fill("PNA")
            page.get_by_test_id("rules-save").click()
            page.get_by_test_id("rules-violation").first.wait_for(timeout=10000)
            check("a rejected save lists path -> message", "labels.0.name" in page.get_by_test_id("rules-violation").first.inner_text())
            check("and shows it by the field", page.locator("[data-testid=rules-field-error][data-field='labels.0']").count() == 1)
            check("history lists revisions", page.get_by_test_id("rules-history-row").count() == 1)

            # ---- Settings > Connected agents ----
            page.goto(f"{base}/settings/connected-agents")
            page.get_by_test_id("connected-agents-page").wait_for(timeout=20000)
            page.get_by_test_id("agent-connection-name").first.wait_for(timeout=10000)
            check("connected agents list the client", page.get_by_test_id("agent-connection-name").first.inner_text() == "Claude Code")
            page.get_by_test_id("agent-connection-revoke").first.click()
            page.get_by_test_id("agent-revoke-confirm-button").click()
            page.get_by_test_id("connected-agents-empty").wait_for(timeout=10000)
            check("Revoke removes it; empty state after", "No connected agents." in page.get_by_test_id("connected-agents-empty").inner_text())
        else:
            page.goto(f"{base}/projects/{P}/overview")
            page.get_by_test_id("health").wait_for(timeout=20000)
            check("Health renders against the live API", True)

        check("no page errors", not errors, "; ".join(errors[:3]))
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
