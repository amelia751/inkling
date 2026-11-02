"""todo10 Phase 6 exit: the agent opens a format the Studio doesn't support (MetaImage .mha)
with only a converter and an environment: no viewer code.

The scripted agent climbs the ladder (apps/agent/src/agent/prompts/builder.md):
  rung 1, configuration: the catalogue (through apps/mcp, as an outside agent sees it) has no
          data kind for .mha, so recombining viewers can't work;
  rung 2, converter: the MetaImage → NIfTI converter runs in the worker runtime
          (studio_worker.convert) on the synthetic sample; the agent gets only the fixed-schema
          ConversionSummary, which names the canonical shape and the preset that shows it;
  then an environment (set_environment through apps/mcp, validated by the Studio's resolver,
  saved as `agent:mcp`) that points the existing volume viewer at the converted asset.
The Studio then shows the volume with first-party code only.

Real: apps/mcp and the dev server's resolver, the converter runtime and its isolation, the
Studio rendering. Scripted: the agent's decisions (this file), the converter's source (written
ahead of time, apps/worker/tests/fixtures/converters/metaimage-py), and registering the output
as a dataset asset (a job-start/asset route belongs to todo10-boundary; here the converted file
is served to the Studio by the test harness).

    STUDIO_E2E=1 pnpm exec vite --port 5240 --strictPort           # apps/web
    python3 ../../tests/e2e/converter_test.py --port 5240           # from apps/web
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "web" / "e2e"))
from harness import NAMING, launch, open_studio, parse_args, src_url, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CONVERTER = ROOT / "apps" / "worker" / "tests" / "fixtures" / "converters" / "metaimage-py"
PROJECT = "mha-demo"
NS = NAMING["namespace"]
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def wait(fn, timeout=60.0, every=0.5):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception:  # noqa: BLE001
            pass
        time.sleep(every)
    return last


class Mcp:
    """A minimal MCP stdio client for apps/mcp (newline-delimited JSON-RPC)."""

    def __init__(self, web: str):
        mcp = ROOT / "apps" / "mcp"
        env = {**__import__("os").environ, f"{NAMING['envPrefix']}WEB_URL": web}
        self.p = subprocess.Popen(["node", str(mcp / "node_modules/tsx/dist/cli.mjs"), str(mcp / "src/main.ts")], cwd=mcp, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        self.seq = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "scripted-agent", "version": "1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, m: dict) -> None:
        assert self.p.stdin
        self.p.stdin.write(json.dumps(m) + "\n")
        self.p.stdin.flush()

    def request(self, method: str, params: dict) -> dict:
        self.seq += 1
        self._send({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params})
        assert self.p.stdout
        while True:
            m = json.loads(self.p.stdout.readline())
            if m.get("id") == self.seq:
                return m.get("result") or {"error": m.get("error")}

    def tool(self, name: str, args: dict) -> tuple[bool, str]:
        r = self.request("tools/call", {"name": name, "arguments": args})
        return not r.get("isError"), "".join(c.get("text", "") for c in r.get("content", []))

    def close(self) -> None:
        self.p.terminate()


def synthetic_mha(path: Path) -> None:
    """64×64×24 int16 phantom (a smooth ellipsoid), MetaImage with inline data. Synthetic only."""
    import numpy as np  # the worker's environment has numpy

    x, y, z = np.meshgrid(np.arange(64), np.arange(64), np.arange(24), indexing="ij")
    r = np.sqrt(((x - 32) / 20) ** 2 + ((y - 30) / 14) ** 2 + ((z - 12) / 8) ** 2)
    arr = (np.clip(1 - r, 0, 1) * 800 + x * 2).astype(np.int16)  # a smooth blob on a ramp, so the default window shows it
    header = "ObjectType = Image\nNDims = 3\nBinaryData = True\nBinaryDataByteOrderMSB = False\nCompressedData = False\nElementSpacing = 1 1 2\nDimSize = 64 64 24\nElementType = MET_SHORT\nElementDataFile = LOCAL\n"
    path.write_bytes(header.encode() + arr.transpose().astype("<i2").tobytes())


def convert(src: Path, out: Path) -> dict:
    """The worker's converter runtime, as the convert job runs it."""
    p = subprocess.run(["uv", "run", "--project", str(ROOT / "apps" / "worker"), "python", "-m", "studio_worker.convert", str(CONVERTER), str(src), str(out)], capture_output=True, text=True, cwd=ROOT)
    return json.loads(p.stdout.strip().splitlines()[-1])


def main() -> int:
    args = parse_args()
    web = f"http://localhost:{args.port}"
    tmp = Path(tempfile.mkdtemp())
    sample = tmp / "phantom.mha"
    synthetic_mha(sample)
    agent = Mcp(web)
    try:
        # Rung 1: is there a data kind for .mha? (The catalogue lists each data kind's extensions.)
        ok, catalog = agent.tool("catalog", {})
        check("rung 1: the agent reads the catalogue through apps/mcp", ok and "catalogue" in catalog, catalog[:60])
        check("rung 1: no data kind reads .mha, so configuration alone can't open it", ".mha" not in catalog)

        # Rung 2: the converter, run by the worker runtime; the agent sees only the summary.
        summary = convert(sample, tmp / "out")
        check("rung 2: the converter turns the sample into a canonical shape", summary.get("ok") and summary.get("shape") == "assets", json.dumps(summary)[:300])
        allowed = {"ok", "converter", "shape", "files", "dataKind", "durationMs", "error", "line"}
        check("rung 2: the agent gets a fixed-schema summary only", set(summary) <= allowed and all(set(f) <= {"path", "mediaType", "bytes", "sha256", "dims", "dtype", "range"} for f in summary.get("files", [])), str(sorted(summary)))
        f = summary["files"][0]
        check("rung 2: the summary has the volume's shape", f.get("dims") == [64, 64, 24] and f.get("dtype") == "int16", str(f))

        # The environment: the existing volume viewer on the converted asset (preset from converter.yaml).
        import yaml

        preset = yaml.safe_load((CONVERTER / "converter.yaml").read_text())["output"]["preset"]
        env = {"extends": preset, "task": "segmentation", "labels": [{"name": "labels", "control": "Labels", "classes": [{"id": "phantom", "color": "chart-1"}]}]}
        ok, saved = agent.tool("set_environment", {"projectId": PROJECT, "spec": env})
        check("environment: the Studio's resolver accepts it and saves it as the agent's", ok and '"agent:mcp"' in saved, saved[:200])
    finally:
        agent.close()

    converted = tmp / "out" / f["path"]
    asset_path = f"{PROJECT}/converted/phantom.nii.gz"
    proj = {
        "id": PROJECT,
        "title": "MetaImage phantoms (synthetic)",
        "environment": {"extends": "preset:generic-image"},
        "source": "synthetic",
        "license": "CC0",
        "status": "available",
        # The convert job's output, registered as the dataset's asset (scripted; see the docstring).
        "assets": [{"path": asset_path, "sha256": f["sha256"], "bytes": f["bytes"], "subject": "phantom-01", "sequence": "t1"}],
    }
    with sync_playwright() as pw:
        browser = launch(pw, args.browser, args.headed)
        st = open_studio(browser, args.port, PROJECT, extra_projects=[proj], fixtures={asset_path: converted}, fixture_annotations=[])
        p = st.page
        try:
            vol = wait(lambda: p.evaluate(f"async () => (await import('{src_url('packages/plugin-ui-sdk/src/runtime.ts')}')).getRuntime('phantom-01', 'volume')"), 90)
            check("studio: the first-party volume viewer shows the converted file", bool(vol) and list(vol.get("dims", [])) == [64, 64, 24], str(vol))
            env_id = st.store("s => s.env && s.env.viewports.map(v => v.renderer.id)")
            check("studio: the viewport is the volume plugin's renderer", env_id == [f"{NS}.volume.renderers.cornerstone-mpr"], str(env_id))
            check("studio: no sandboxed viewer, no generated plugin code", p.locator("[data-testid='sandbox-viewer']").count() == 0)
            out = Path(args.out) / "converters"
            out.mkdir(parents=True, exist_ok=True)
            p.screenshot(path=str(out / "mha-converted.png"))
            errs = [e for e in st.errors if "favicon" not in e]
            check("studio: no console errors", not errs, str(errs[:3]))
        finally:
            p.context.close()
            browser.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
