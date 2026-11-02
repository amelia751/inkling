"""Studio boot timeline and Milestone 1 budgets (todo11 §4, §7).

    STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort      # in apps/web
    python3 e2e/boot_test.py --port 5199 [--runs 3] [--report-only]

Per preset (image-2d, video, volume-3d, ecg, pathology) it prints, in ms:

- cold: a fresh browser context (empty HTTP cache) loading the Studio URL; times are since
  navigation start;
- warm: the same page navigating away and back inside the app (SPA); times are since that
  navigation.

`shell` is the first frame with the Studio chrome (the annotation toolbar) on screen,
`frame` the viewer's first drawn item (the `first-frame` boot mark; for image-2d also the
2D viewer's test hook). Both are sampled with requestAnimationFrame from an init script, so
the same script measures builds without the boot marks (the baseline in todo11 §7).

Then it checks the Milestone 1 exits: shell under 1.5 s warm / 3 s cold per preset, image-2d
first frame under 3 s cold, a panel whose module fails leaves the viewer working, and item
switches in image2d keep one engine instance. `--report-only` prints without gating.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import NAMING, REPO, launch, open_studio, parse_args, sync_playwright  # noqa: E402

RES = NAMING["resourcePrefix"]
HOOK_2D = f"__{RES}2d"
TIMELINE = f"__{RES}BootTimeline"
TOOLBAR = "[role='toolbar'][aria-label='Annotation tools']"

PRESETS = {
    "image-2d": "2d-xray",
    "video": "video-endoscopy",
    "volume-3d": "3d-brain-mri",
    "ecg": "ecg-waveform",
    "pathology": "pathology-wsi",
}

# Budgets (ms): todo11 §7.
SHELL_WARM, SHELL_COLD, FRAME_2D_COLD = 1500, 3000, 3000

PROBE = """
(() => {
  const probe = { start: 0, t: {} };
  window.__bootProbe = probe;
  const conds = {
    shell: () => !!document.querySelector(%(toolbar)s),
    frame: () => performance.getEntriesByName(%(mark)s, "mark").length > 0 || (%(is2d)s && !!window[%(hook)s]),
  };
  const tick = () => {
    const now = performance.now();
    for (const k in conds) if (!(k in probe.t) && conds[k]()) probe.t[k] = now - probe.start;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
"""


def probe_script(preset: str) -> str:
    return PROBE % {
        "toolbar": json.dumps(TOOLBAR),
        "mark": json.dumps(f"{RES}:boot:first-frame"),
        "is2d": "true" if preset == "image-2d" else "false",
        "hook": json.dumps(HOOK_2D),
    }


def wait_probe(page, keys=("shell", "frame"), timeout=90.0) -> dict:
    end = time.time() + timeout
    t = {}
    while time.time() < end:
        t = page.evaluate("() => window.__bootProbe.t")
        if all(k in t for k in keys):
            return t
        time.sleep(0.1)
    return t


def timeline(page) -> dict | None:
    return page.evaluate(f"() => window.{TIMELINE} ? window.{TIMELINE}() : null")


def spa_go(page, path: str) -> None:
    page.evaluate("(p) => { history.pushState(null, '', p); dispatchEvent(new PopStateEvent('popstate')); }", path)


def measure(browser, port: int, preset: str, dataset: str) -> dict:
    st = open_studio(browser, port, dataset, init_script=probe_script(preset))
    page = st.page
    cold = wait_probe(page, keys=("shell",))
    # A build without boot marks (the baseline) only reports image-2d's frame, from its hook.
    marked = page.evaluate(f"() => typeof window.{TIMELINE} === 'function'")
    if marked or preset == "image-2d":
        cold = wait_probe(page, keys=("shell", "frame"), timeout=60.0)
    marks = timeline(page)
    # Warm: away (projects list) and back, inside the app.
    spa_go(page, "/projects")
    page.wait_for_function(f"() => !document.querySelector({json.dumps(TOOLBAR)})", timeout=30000)
    time.sleep(0.5)
    page.evaluate("() => { window.__bootProbe.t = {}; window.__bootProbe.start = performance.now(); }")
    spa_go(page, f"/projects/{dataset}/studio/{dataset}")
    warm = wait_probe(page, keys=("shell",))
    page.context.close()
    return {"cold": cold, "warm": warm, "marks": marks, "errors": st.errors}


def fmt(v) -> str:
    return f"{v:7.0f}" if isinstance(v, (int, float)) else f"{'—':>7}"


def item_switch_keeps_engine(browser, port: int) -> tuple[bool, str]:
    st = open_studio(browser, port, "2d-xray")
    page = st.page
    page.wait_for_function(f"() => !!window.{HOOK_2D}", timeout=90000)
    first = page.evaluate(f"() => ({{ engine: window.{HOOK_2D}.engine, item: window.{HOOK_2D}.itemId }})")
    seen = {first["item"]}
    engines = {first["engine"]}
    n = page.evaluate("async () => (await import('/src/studio/stores/studio.ts')).useStudio.getState().itemIndex")
    for i in range(1, 6):
        page.evaluate(f"async () => (await import('/src/studio/stores/studio.ts')).useStudio.getState().setItemIndex({n + i})")
        page.wait_for_function(f"(prev) => window.{HOOK_2D} && !prev.includes(window.{HOOK_2D}.itemId)", arg=list(seen), timeout=30000)
        cur = page.evaluate(f"() => ({{ engine: window.{HOOK_2D}.engine, item: window.{HOOK_2D}.itemId }})")
        seen.add(cur["item"])
        engines.add(cur["engine"])
    page.context.close()
    return len(engines) == 1 and len(seen) == 6, f"{len(seen)} items, engine instances {sorted(engines)}"


def broken_panel_leaves_viewer(browser, port: int) -> tuple[bool, str]:
    """A right panel from a module whose chunk fails to load: the viewer and other panels still work."""
    manifest = json.loads((REPO / "seed-data" / "manifest.json").read_text())
    xray = next(p for p in manifest["projects"] if p["id"] == "2d-xray")
    panel = f"{RES}.wsi.panels.counts"
    proj = {**xray, "id": "broken-panel", "title": "Broken panel", "environment": {"extends": "preset:image-2d", "panels": {"right": [panel]}}}
    st = open_studio(browser, port, "broken-panel", extra_projects=[proj], fixture_annotations=[], init_script=None)
    page = st.page
    # The module's chunk can't be fetched (a deploy gap, a blocked CDN…).
    page.context.route("**/plugins/wsi/ui/impl.ts*", lambda route: route.abort())
    page.reload()
    try:
        page.wait_for_selector(f"[data-testid='slot-failed'][data-slot-id='{panel}']", timeout=60000)
        page.wait_for_function(f"() => !!window.{HOOK_2D}", timeout=90000)
        ok = page.locator(TOOLBAR).count() == 1 and page.locator("[data-testid='env-errors'], [data-testid='studio-crashed']").count() == 0
        detail = "panel shows its own error; viewer, toolbar and items work"
    except Exception as e:  # noqa: BLE001
        ok, detail = False, f"{type(e).__name__}: {str(e)[:200]}; errors={st.errors[:3]}"
    page.context.close()
    return ok, detail


def main() -> int:
    ap_args = parse_args_with_runs()
    failures: list[str] = []
    with sync_playwright() as pw:
        browser = launch(pw, ap_args.browser, ap_args.headed)
        # Prime the dev server's transform cache so "cold" means a cold browser, not a cold Vite.
        for preset, dataset in PRESETS.items():
            measure(browser, ap_args.port, preset, dataset)
        rows = {}
        for preset, dataset in PRESETS.items():
            runs = [measure(browser, ap_args.port, preset, dataset) for _ in range(ap_args.runs)]
            med = lambda kind, key: statistics.median([r[kind][key] for r in runs if key in r[kind]]) if any(key in r[kind] for r in runs) else None  # noqa: E731
            rows[preset] = {"cold_shell": med("cold", "shell"), "cold_frame": med("cold", "frame"), "warm_shell": med("warm", "shell"), "marks": runs[-1]["marks"]}
        print(f"\nStudio boot, median of {ap_args.runs} (ms; cold since navigation start, warm since the in-app navigation)")
        print(f"{'preset':<11}{'cold shell':>11}{'cold frame':>11}{'warm shell':>11}")
        for preset, r in rows.items():
            print(f"{preset:<11}{fmt(r['cold_shell']):>11}{fmt(r['cold_frame']):>11}{fmt(r['warm_shell']):>11}")
        for preset, r in rows.items():
            m = r["marks"]
            if m and m.get("steps"):
                key = [s for s in m["steps"] if not s["step"].startswith("module")]
                mods = [s for s in m["steps"] if s["step"].startswith("module")]
                print(f"  {preset}: " + ", ".join(f"{s['step']} {s['sinceRoute']}" for s in key) + f"  ({len(mods)} modules, last at {max((s['sinceRoute'] for s in mods), default=0)})")
        if not ap_args.report_only:
            for preset, r in rows.items():
                if r["cold_shell"] is None or r["cold_shell"] >= SHELL_COLD:
                    failures.append(f"{preset}: cold shell {r['cold_shell']} ms ≥ {SHELL_COLD}")
                if r["warm_shell"] is None or r["warm_shell"] >= SHELL_WARM:
                    failures.append(f"{preset}: warm shell {r['warm_shell']} ms ≥ {SHELL_WARM}")
            f2d = rows["image-2d"]["cold_frame"]
            if f2d is None or f2d >= FRAME_2D_COLD:
                failures.append(f"image-2d: cold first frame {f2d} ms ≥ {FRAME_2D_COLD}")
            for name, fn in (("item switch keeps one engine", item_switch_keeps_engine), ("broken panel leaves the viewer working", broken_panel_leaves_viewer)):
                ok, detail = fn(browser, ap_args.port)
                print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
                if not ok:
                    failures.append(name)
        browser.close()
    for f in failures:
        print(f"FAIL  {f}")
    print("\nall boot checks passed" if not failures else f"\n{len(failures)} boot check(s) failed")
    return 1 if failures else 0


def parse_args_with_runs():
    argv = sys.argv[1:]
    runs, report_only = 3, False
    if "--runs" in argv:
        i = argv.index("--runs")
        runs = int(argv[i + 1])
        del argv[i : i + 2]
    if "--report-only" in argv:
        argv.remove("--report-only")
        report_only = True
    sys.argv = [sys.argv[0], *argv]
    a = parse_args()
    a.runs, a.report_only = runs, report_only
    return a


if __name__ == "__main__":
    sys.exit(main())
