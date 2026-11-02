"""Phase 7 acceptance: non-medical Studios booted from environment JSON alone.

Each test injects a project whose `environment` only says `extends: preset:<id>` (plus data),
opens it, and checks the environment resolved, the right renderer mounted and basic work
happens — no module code is specific to these use cases.

    python3 e2e/environments_test.py --port 5199
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import NAMING, REGISTRY, RUNTIME, launch, open_studio, parse_args, sync_playwright  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def project(pid: str, preset: str, assets: list[dict]) -> dict:
    return {
        "id": pid,
        "title": f"Demo · {preset}",
        "environment": {"extends": f"preset:{preset}"},
        "source": "synthetic / seed reuse",
        "license": "CC0 (synthetic) or the seed's license",
        "status": "available",
        "assets": assets,
    }


def wait(fn, timeout=30.0, every=0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001 — page may be mid-load
            pass
        time.sleep(every)
    return last


def env_summary(st) -> dict:
    return st.store("s => s.env && ({ id: s.env.id, renderer: s.env.viewports[0].renderer.id, config: s.env.viewports[0].config, tools: s.env.tools.map(t => t.name), exporters: s.env.exporters.map(e => e.id) })")


def runtime(st, item_id: str, key: str):
    return st.page.evaluate(f"async () => (await import('{RUNTIME}')).getRuntime({item_id!r}, {key!r})")


def t_sensor(browser, port):
    csv = FIXTURES / "accelerometer.csv"
    p = project("sensor-demo", "sensor-timeseries-events", [{"path": "sensor-demo/accelerometer.csv", "sha256": "", "bytes": csv.stat().st_size, "record": "accelerometer"}])
    st = open_studio(browser, port, "sensor-demo", extra_projects=[p], fixtures={"sensor-demo/accelerometer.csv": csv}, fixture_annotations=[])
    try:
        env = wait(lambda: env_summary(st))
        check("sensor: environment resolves from preset JSON", bool(env) and env["renderer"] == "studio.timeseries.renderers.strip-chart", str(env and env["renderer"]))
        check("sensor: plain grid, no ECG paper", env["config"].get("grid") == "plain" and env["config"].get("reader") == "csv", str(env["config"].get("grid")))
        st.page.wait_for_selector("[data-testid='signal-canvas']", timeout=30000)
        info = wait(lambda: runtime(st, "sensor-demo/accelerometer.csv", "signalInfo"))
        check("sensor: CSV read at 50 Hz with 3 channels", bool(info) and round(info["fs"]) == 50 and len(info.get("leads") or info.get("channels") or []) == 3, str(info and {k: info[k] for k in info if k in ("fs", "leads", "channels")}))
        check("sensor: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        st.page.context.close()


def t_drone(browser, port):
    asset = {"path": "video-endoscopy/16e7e461-a9a7-4b04-8d2c-155de3eb1c90.mp4", "sha256": "", "bytes": 0}
    st = open_studio(browser, port, "drone-demo", extra_projects=[project("drone-demo", "drone-video-tracks", [asset])], fixture_annotations=[])
    try:
        env = wait(lambda: env_summary(st))
        # todo8 D4 Rule 1: the preset's event tool has no label group that accepts events, so it
        # is in env.unusableTools, not the toolbar.
        check("drone: video renderer with box tracks, MOT and CVAT", bool(env) and env["renderer"] == "studio.video.renderers.frame-canvas" and env["tools"] == ["select", "pan", "box"] and env["exporters"] == ["studio.video.exporters.mot", "studio.video.exporters.cvat-video"], str(env))
        unusable = st.store("s => s.env.unusableTools.map(u => u.tool.name)")
        check("drone: the event tool is unusable without an event label group (Rule 1)", unusable == ["event"], str(unusable))
        st.page.wait_for_selector("[data-testid='video-stage'][data-clock='ready']", timeout=45000)
        classes = st.store("s => s.env.labels[0].classes.map(c => c.id)")
        check("drone: label classes come from the preset", classes == ["car", "truck", "person"], str(classes))
        check("drone: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        st.page.context.close()


def t_satellite(browser, port):
    asset = {"path": "pathology-wsi/TCGA-A6-5665-01Z-00-DX1.dzi", "sha256": "", "bytes": 0, "slide": "tiles"}
    st = open_studio(browser, port, "satellite-demo", extra_projects=[project("satellite-demo", "satellite-tiles", [asset])], fixture_annotations=[])
    try:
        env = wait(lambda: env_summary(st))
        check("satellite: deep-zoom renderer with metres-per-pixel config", bool(env) and env["renderer"] == "studio.wsi.renderers.osd" and env["config"].get("mpp") == 500000, str(env and env["config"]))
        st.page.wait_for_selector("[data-testid='wsi-viewer']", timeout=30000)
        classes = st.store("s => s.env.labels.flatMap(g => g.classes.map(c => c.id))")
        check("satellite: land-use classes from the preset", classes == ["building", "field", "water", "tree"], str(classes))
        check("satellite: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        st.page.context.close()


def t_workspace_activation(browser, port):
    """todo2 Phase 3: a workspace without the WSI plugin can't run the pathology preset; enabling it can."""
    asset = {"path": "pathology-wsi/TCGA-A6-5665-01Z-00-DX1.dzi", "sha256": "", "bytes": 0, "slide": "tiles"}
    ns = NAMING["namespace"]
    state = {"workspaceId": "no-wsi", "plugins": [{"pluginId": f"{ns}.image2d", "version": "1.1.0", "state": "ACTIVATED"}]}
    st = open_studio(browser, port, "no-wsi", extra_projects=[project("no-wsi", "pathology", [asset])], fixture_annotations=[], workspace_state=state)
    try:
        st.page.wait_for_selector("[data-testid='env-errors']", timeout=30000)
        text = st.page.inner_text("[data-testid='env-errors']")
        check("activation: pathology doesn't resolve without the WSI plugin", f"{ns}.wsi" in text, text[:160])
        cat = st.page.evaluate(f"async () => (await import('{REGISTRY}')).registry.listModules().map(m => m.id)")
        check("activation: the catalogue lists only active plugins", f"{ns}.wsi" not in cat and f"{ns}.image2d" in cat, str(cat))
        st.page.evaluate(f"async () => (await import('{REGISTRY}')).registry.activate('{ns}.wsi')")
        st.page.wait_for_selector("[data-testid='wsi-viewer']", timeout=30000)
        env = wait(lambda: env_summary(st))
        check("activation: enabling WSI boots the pathology Studio without a reload", bool(env) and env["renderer"] == f"{ns}.wsi.renderers.osd", str(env))
        check("activation: no console errors", not [e for e in st.errors if "favicon" not in e], str(st.errors[:2]))
    finally:
        st.page.context.close()


def t_text(browser, port):
    txt = FIXTURES / "ner.txt"
    p = project("ner-demo", "ner", [{"path": "ner-demo/ner.txt", "sha256": "", "bytes": txt.stat().st_size}])
    st = open_studio(browser, port, "ner-demo", extra_projects=[p], fixtures={"ner-demo/ner.txt": txt}, fixture_annotations=[])
    try:
        env = wait(lambda: env_summary(st))
        check("text: a module written from outside boots preset:ner", bool(env) and env["renderer"] == "studio.text-spans.renderers.reader", str(env and env["renderer"]))
        st.page.wait_for_selector("[data-testid='text-reader'] [data-start]", timeout=20000)
        st.page.mouse.click(5, 300)
        st.page.keyboard.press("e")
        st.page.keyboard.press("3")
        # Select "London" (chars 44–50) with a real DOM range, then release the mouse on it.
        st.page.evaluate("""() => {
          const seg = document.querySelector("[data-testid='text-reader'] [data-start='0']");
          const node = seg.firstChild; const r = document.createRange();
          r.setStart(node, 44); r.setEnd(node, 50);
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
          seg.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }""")
        spans = wait(lambda: st.store("s => s.annotations.filter(a => a.geometry.type === 'studio.text-spans.span').map(a => ({ label: a.label, g: a.geometry }))"))
        ok = bool(spans) and spans[0]["label"] == "LOC" and spans[0]["g"] == {"type": "studio.text-spans.span", "start": 44, "end": 50, "text": "London"}
        check("text: selecting text stores a span with the active class", ok, str(spans))
        out = st.page.evaluate("""async () => {
          const { registry } = await import('/src/extension-host/registry.ts');
          const ex = await registry.loadImpl('studio.text-spans.exporters.jsonl');
          const s = (await import('/src/studio/stores/studio.ts')).useStudio.getState();
          const items = s.env.dataKind.groupItems({ assets: [{ path: 'ner-demo/ner.txt' }] });
          return await (await ex.build({ project: {}, items, annotations: s.annotations })).text();
        }""")
        check("text: JSONL export", '"spans":[[44,50,"LOC"]]' in out, out[:120])
        check("text: no console errors", not st.errors, str(st.errors[:2]))
    finally:
        st.page.context.close()


SANDBOX_HTML = """<!doctype html><html><head></head><body><p id=out>starting</p><script>
(async () => {
  let net = "blocked";
  try { await fetch("https://example.com/"); net = "allowed"; } catch { net = "blocked"; }
  const { item, annotations } = await studio.getAnnotations();
  const r = await studio.propose([
    { label: "cat", geometry: { type: "box", x: 10, y: 20, w: 30, h: 40 }, attributes: { net, seen: annotations.length } },
    { label: "unicorn", geometry: { type: "box", x: 0, y: 0, w: 1, h: 1 } },
  ]);
  document.getElementById("out").textContent = item.id + " added " + r.added;
})();
</script></body></html>"""


def t_agent_panels(browser, port):
    xray = next(p for p in __import__("json").loads((Path(__file__).resolve().parents[3] / "seed-data/manifest.json").read_text())["projects"] if p["id"] == "2d-xray")
    assets = [{k: v for k, v in a.items() if k != "label"} for a in xray["assets"][:2]]
    p = project("agent-panels", "generic-image", assets)
    p["environment"] = {
        "extends": "preset:generic-image",
        "labels": [{"name": "objects", "control": "RectangleLabels", "classes": [{"id": "cat"}]}],
        "panels": {"right": ["studio.experimental.panels.declarative", "studio.experimental.panels.sandbox"]},
        "overrides": [
            {"id": "studio.experimental.panels.declarative", "config": {"title": "Progress", "blocks": [{"type": "stat", "label": "On this item", "value": {"store": "annotations.item"}}]}},
            {"id": "studio.experimental.panels.sandbox", "config": {"title": "Auto-boxer", "html": SANDBOX_HTML, "height": 160}},
        ],
    }
    st = open_studio(browser, port, "agent-panels", extra_projects=[p], fixture_annotations=[], init_script="localStorage.setItem('studio.flags', 'agentPanels')")
    try:
        st.page.wait_for_selector("[data-testid='agent-declarative-panel']", timeout=30000)
        check("agent panels: tier 2 declarative panel renders from JSON", st.page.get_by_test_id("agent-stat").inner_text().strip() == "0")
        st.page.get_by_role("tab", name="Sandboxed tool").click()
        added = wait(lambda: st.store("s => s.annotations.filter(a => a.provenance === 'ai-suggested' && a.author === 'agent:sandbox').map(a => ({ label: a.label, g: a.geometry, attrs: a.attributes }))"))
        check("agent panels: tier 3 sandbox proposals arrive vetted and ai-suggested", bool(added) and len(added) == 1 and added[0]["label"] == "cat" and added[0]["g"]["type"] == "box", str(added))
        check("agent panels: the sandbox has no network", bool(added) and added[0]["attrs"]["net"] == "blocked", str(added and added[0]["attrs"]))
        frame_text = wait(lambda: (lambda t: t if "added" in t else None)(st.page.frame_locator("[data-testid='agent-sandbox']").frame_locator("iframe").locator("#out").inner_text()))
        check("agent panels: sandbox got its item through the bridge", bool(frame_text) and "added 1" in frame_text, str(frame_text))
        st.page.get_by_role("tab", name="Agent panel").click()
        stat = wait(lambda: st.page.get_by_test_id("agent-stat").inner_text().strip() == "1")
        check("agent panels: declarative bindings update live", bool(stat), st.page.get_by_test_id("agent-stat").inner_text())
        # The sandbox being denied storage and network is the isolation working.
        errs = [e for e in st.errors if "Content Security Policy" not in e and "example.com" not in e and "is sandboxed" not in e]
        check("agent panels: no console errors (besides the blocked fetch)", not errs, str(errs[:2]))
    finally:
        st.page.context.close()


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        for fn in (t_sensor, t_drone, t_satellite, t_workspace_activation, t_text, t_agent_panels):
            try:
                fn(browser, args.port)
            except Exception as e:  # noqa: BLE001 — report and keep going
                check(fn.__name__, False, f"{type(e).__name__}: {e}")
        browser.close()
    passed = sum(ok for _, ok, _ in results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
