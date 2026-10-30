"""Shared Playwright helpers for Studio viewer tests.

Run a dev server first (`INKLING_E2E=1 pnpm exec vite --port <port> --strictPort` in apps/web;
INKLING_E2E turns off hot reload so concurrent edits can't reload the page mid-test), then
`python3 e2e/<viewer>_test.py --port <port> [--browser chromium|webkit|firefox]`.

Every test goes through `open_studio`, which intercepts annotation saves so a test can
never modify seed-data/.annotations: PUTs are answered with a fake "saved" document and
recorded on `Studio.saves` for assertions. Extra fixture files (e.g. synthetic DICOM) and
extra manifest projects can be injected the same way, without touching seed-data/.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, Page, Route, sync_playwright


REPO = Path(__file__).resolve().parents[3]
NAMING = json.loads((REPO / "schemas" / "naming.json").read_text())

# Browser URLs of modules tests import directly. Shell and host files live under apps/web/src
# (served at /src/...); packages and plugins live outside the Vite root and are served at
# /@fs/<absolute path>, the same URL the app itself loads them from (so module state is shared).
STORE = "/src/studio/stores/studio.ts"
REGISTRY = "/src/extension-host/registry.ts"


def src_url(repo_path: str) -> str:
    """URL for a repo-relative module path, e.g. src_url('plugins/cine/ui/model.ts')."""
    if repo_path.startswith("apps/web/src/"):
        return "/" + repo_path[len("apps/web/"):]
    return f"/@fs{REPO / repo_path}"


RUNTIME = src_url("packages/plugin-ui-sdk/src/runtime.ts")


@dataclass
class Studio:
    page: Page
    saves: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def store(self, expr: str = "s => s") -> Any:
        """Evaluate a selector against the zustand store state, e.g. `s => s.annotations.length`."""
        return self.page.evaluate(
            f"async () => {{ const m = await import('{STORE}'); return ({expr})(m.useStudio.getState()); }}"
        )

    def act(self, expr: str) -> Any:
        """Call store actions, e.g. `s => s.setTool('box')`."""
        return self.page.evaluate(
            f"async () => {{ const m = await import('{STORE}'); return ({expr})(m.useStudio.getState()); }}"
        )

    def shot(self, name: str, out: Path) -> Path:
        out.mkdir(parents=True, exist_ok=True)
        path = out / f"{name}.png"
        self.page.screenshot(path=str(path))
        return path


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default=str(Path(__file__).parent / ".artifacts"))
    return ap.parse_args()


def launch(pw, name: str, headed: bool = False) -> Browser:
    return getattr(pw, name).launch(headless=not headed)


def open_studio(
    browser: Browser,
    port: int,
    dataset: str,
    *,
    fixtures: dict[str, Path] | None = None,
    extra_projects: list[dict[str, Any]] | None = None,
    viewport: tuple[int, int] = (1440, 900),
    init_script: str | None = None,
    device_scale_factor: float = 1,
    fixture_annotations: list[dict[str, Any]] | None = None,
    workspace_state: dict[str, Any] | None = None,
) -> Studio:
    """Open /datasets/<dataset> with saves intercepted.

    fixtures: map of seed path (as used in manifest asset.path) → local file served at /seed/<path>.
    extra_projects: appended to the served manifest's `projects`.
    init_script: JS run before any page script (e.g. to delete window.VideoDecoder).
    device_scale_factor: HiDPI rendering (2 = retina).
    fixture_annotations: answer the annotations GET with exactly these, so a test never
      depends on what happens to be saved in seed-data/.annotations.
    workspace_state: answer the workspace's active-plugin state (Workspace API) with this.
    """
    ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, device_scale_factor=device_scale_factor)
    if init_script:
        ctx.add_init_script(init_script)
    page = ctx.new_page()
    studio = Studio(page)
    page.on("pageerror", lambda e: studio.errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and studio.errors.append(m.text))

    def annotations(route: Route) -> None:
        req = route.request
        if req.method == "PUT":
            doc = json.loads(req.post_data or "{}")
            studio.saves.append(doc)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({**doc, "revision": doc.get("revision", 0) + 1}))
        elif fixture_annotations is not None:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"revision": 1, "annotations": fixture_annotations}))
        else:
            route.continue_()

    page.route("**/api/annotations/**", annotations)

    if workspace_state is not None:
        page.route(f"**/api/v1/workspaces/{dataset}/state", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(workspace_state)))

    if extra_projects:
        def manifest(route: Route) -> None:
            res = route.fetch()
            data = res.json()
            data["projects"] = data["projects"] + extra_projects
            route.fulfill(response=res, body=json.dumps(data), content_type="application/json")

        page.route("**/seed/manifest.json", manifest)

    for seed_path, local in (fixtures or {}).items():
        body = Path(local).read_bytes()
        ctype = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
        page.route(f"**/seed/{seed_path}", lambda route, _request=None, body=body, ctype=ctype: route.fulfill(status=200, body=body, content_type=ctype))

    page.goto(f"http://localhost:{port}/datasets/{dataset}")
    return studio


__all__ = ["NAMING", "REGISTRY", "RUNTIME", "STORE", "Studio", "launch", "open_studio", "parse_args", "src_url", "sync_playwright"]
