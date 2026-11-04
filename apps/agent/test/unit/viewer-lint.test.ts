import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintViewerFiles } from "@studio/plugin-ui-sdk/viewer-lint.ts";
import { describe, expect, it } from "vitest";
import { VIEWER_LIST_SCRIPT, parseViewerFileList } from "../../src/tools/kernel.ts";

describe("run_plugin_checks viewer-lint (todo23 W2)", () => {
  it("lists a plugin's viewer files with sizes and lints them", () => {
    const dir = mkdtempSync(join(tmpdir(), "viewer-lint-"));
    try {
      mkdirSync(join(dir, "ui"));
      writeFileSync(join(dir, "ui", "contributions.json"), "{}");
      writeFileSync(join(dir, "ui", "viewer.js"), 'export function render({ el }) { el.style.color = "#123456"; fetch("/x"); }');
      writeFileSync(join(dir, "ui", "decoder.wasm"), new Uint8Array(10));
      const files = parseViewerFileList(execSync(VIEWER_LIST_SCRIPT, { cwd: dir, shell: "/bin/sh" }).toString()).sort((a, b) => a.path.localeCompare(b.path));
      expect(files).toEqual([{ path: "ui/decoder.wasm", bytes: 10 }, { path: "ui/viewer.js", bytes: expect.any(Number) }]);
      rmSync(join(dir, "ui"), { recursive: true });
      expect(parseViewerFileList(execSync(VIEWER_LIST_SCRIPT, { cwd: dir, shell: "/bin/sh" }).toString())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const f = lintViewerFiles([{ path: "ui/viewer.js", content: 'el.style.color = "#123456"; fetch("/x");' }]);
    expect(f.map((x) => x.rule).sort()).toEqual(["network", "raw-colour"]);
  });
});
