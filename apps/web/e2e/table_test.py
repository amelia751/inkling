"""Smoke test for plugins/table: preset:table-review boots the grid on a CSV, a row click is
published as runtime `selection`, the Rows tool stores a `class` annotation with
`attributes.rows`, and the CSV exporter joins the label.

    python3 e2e/table_test.py --port 5199
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from harness import RUNTIME, launch, open_studio, parse_args, sync_playwright  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


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


def t_table(browser, port):
    csv = FIXTURES / "table.csv"
    item = "table-demo/table.csv"
    p = {
        "id": "table-demo",
        "title": "Demo · table-review",
        "environment": {"extends": "preset:table-review"},
        "source": "synthetic",
        "license": "CC0 (synthetic)",
        "status": "available",
        "assets": [{"path": item, "sha256": "", "bytes": csv.stat().st_size}],
    }
    st = open_studio(browser, port, "table-demo", extra_projects=[p], fixtures={item: csv}, fixture_annotations=[])
    # The frozen dev server has no project trash route for injected projects; that 404 isn't ours.
    missing: list[str] = []
    st.page.on("response", lambda r: r.status == 404 and not r.url.endswith("/trash") and missing.append(r.url))
    try:
        env = wait(lambda: st.store("s => s.env && ({ renderer: s.env.viewports[0].renderer.id })"))
        check("table: preset:table-review boots the grid", bool(env) and env["renderer"] == "studio.table.renderers.grid", str(env))
        st.page.wait_for_selector("[data-testid='table-grid'] tr[data-row='4']", timeout=20000)
        cells = st.page.locator("[data-testid='table-grid'] tr[data-row='1'] td").all_inner_texts()
        check("table: CSV parsed (quoted comma kept)", "has, comma" in cells, str(cells))

        st.page.locator("[data-testid='table-grid'] tr[data-row='1'] td").nth(3).click()
        sel = wait(lambda: st.page.evaluate(f"async () => (await import('{RUNTIME}')).getRuntime({item!r}, 'selection')"))
        check("table: row click publishes runtime selection", bool(sel) and sel.get("rows") == [1] and sel.get("column") == "name", str(sel))

        # Rows tool + third class ("wrong"), then click row 3 (index 2).
        st.page.keyboard.press("r")
        st.page.keyboard.press("3")
        st.page.locator("[data-testid='table-grid'] tr[data-row='2'] td").first.click()
        anns = wait(lambda: st.store("s => s.annotations.filter(a => a.geometry.type === 'class' && a.attributes && a.attributes.rows !== undefined).map(a => ({ label: a.label, rows: a.attributes.rows }))"))
        check("table: Rows tool stores a class annotation with attributes.rows", anns == [{"label": "wrong", "rows": "2"}], str(anns))

        out = st.page.evaluate("""async () => {
          const { registry } = await import('/src/extension-host/registry.ts');
          const ex = await registry.loadImpl('studio.table.exporters.labeled-csv');
          const s = (await import('/src/studio/stores/studio.ts')).useStudio.getState();
          const items = s.env.dataKind.groupItems({ assets: [{ path: 'table-demo/table.csv' }] });
          return await (await ex.build({ project: {}, items, annotations: s.annotations })).text();
        }""")
        check("table: CSV export joins labels", out.startswith("file,id,name,amount,note,label") and "table-demo/table.csv,3,gamma,12,,wrong" in out, out[:200])
        errs = [e for e in st.errors if not e.startswith("Failed to load resource: the server responded with a status of 404")]
        check("table: no console errors", not errs and not missing, str((errs + missing)[:2]))
    finally:
        st.page.context.close()


def main() -> int:
    args = parse_args()
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        try:
            t_table(browser, args.port)
        except Exception as e:  # noqa: BLE001 — report
            check("t_table", False, f"{type(e).__name__}: {e}")
        browser.close()
    passed = sum(ok for _, ok, _ in results)
    print(f"\n{passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
