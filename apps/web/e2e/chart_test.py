"""Smoke test for the chart kit (todo23 W1): preset:series-chart on a synthetic candle CSV.

    STUDIO_E2E=1 pnpm exec vite --port 5312 --strictPort    # in apps/web
    python3 e2e/chart_test.py --port 5312

Boots the Studio from the preset alone, checks the candle chart and its attribution render,
then draws an event (instant) and a window (span) with the chart tools.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from environments_test import check, env_summary, project, results, runtime, wait  # noqa: E402
from harness import launch, open_studio, parse_args, sync_playwright  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "series.csv"
PATH = "chart-demo/series.csv"


def t_chart(browser, port):
    p = project("chart-demo", "series-chart", [{"path": PATH, "sha256": "", "bytes": FIXTURE.stat().st_size}])
    st = open_studio(browser, port, "chart-demo", extra_projects=[p], fixtures={PATH: FIXTURE}, fixture_annotations=[])
    try:
        env = wait(lambda: env_summary(st))
        check("chart: environment resolves from the preset", bool(env) and env["renderer"] == "studio.chart.renderers.series", str(env and env["renderer"]))
        check("chart: window and event tools", bool(env) and env["tools"][-2:] == ["window", "event"], str(env and env["tools"]))
        st.page.wait_for_selector("[data-testid='chart-series'][data-mode='candles']", timeout=30000)
        info = wait(lambda: runtime(st, PATH, "chartInfo"))
        check("chart: 40 candles read from the CSV", bool(info) and info["mode"] == "candles" and info["bars"] == 40, str(info))
        check("chart: attribution visible", st.page.locator("[data-testid='chart-attribution']").is_visible())

        box = st.page.locator("[data-testid='chart-series'] canvas").first.bounding_box()
        assert box
        y = box["y"] + box["height"] / 2
        st.act("s => s.setActiveLabel('event')")
        st.page.mouse.move(box["x"] + 5, box["y"] + 5)
        st.page.keyboard.press("t")
        wait(lambda: st.store("s => s.tool") == "event", 5)
        st.page.mouse.click(box["x"] + box["width"] * 0.4, y)
        inst = wait(lambda: st.store("s => s.annotations.filter(a => a.geometry.type === 'instant').length"), 5)
        check("chart: event tool adds an instant", inst == 1, str(inst))

        st.act("s => s.setActiveLabel('window')")
        st.page.keyboard.press("i")
        wait(lambda: st.store("s => s.tool") == "window", 5)
        st.page.mouse.click(box["x"] + box["width"] * 0.2, y)
        time.sleep(0.2)
        check("chart: first click opens a window", st.page.locator("[data-testid='chart-window-draft']").count() == 1)
        st.page.mouse.click(box["x"] + box["width"] * 0.5, y)
        span = wait(lambda: st.store("s => s.annotations.find(a => a.geometry.type === 'span')"), 5)
        check("chart: window tool adds a span with attributes.kind", bool(span) and span["geometry"]["end"] > span["geometry"]["start"] and span["attributes"]["kind"] == "window", str(span and span["geometry"]))
        check("chart: window band drawn", wait(lambda: st.page.locator("[data-testid='chart-window']").count(), 5) == 1)
        # The injected project has no kernel record, so its trash listing 404s; anything else is a failure.
        errors = [e for e in st.errors if "status of 404" not in e]
        markers = st.page.evaluate("() => document.querySelector(\"[data-testid='chart-series']\") !== null")
        check("chart: still mounted after drawing", markers)
        check("chart: no console errors", not errors, str(errors[:2]))
    finally:
        st.page.context.close()


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser if hasattr(args, "browser") else "chromium")
        t_chart(browser, args.port)
        browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
