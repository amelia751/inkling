#!/usr/bin/env node
// viewer-lint CLI (todo23 W2): `node packages/plugin-ui-sdk/scripts/viewer-lint.mjs <dir|file>… [--json] [--max-bytes N]`
// Lints a rung-4 viewer (src/viewer-lint.ts) and prints the findings, one per line, or as a JSON
// array of {rule, file, line, message, severity} with --json. Exits 1 on any error finding,
// 2 on bad usage. Skips node_modules and dot-directories.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Node < 22.18 needs the flag to import TypeScript; re-run with it.
if (!process.features?.typescript && !process.env.VIEWER_LINT_CHILD) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, VIEWER_LINT_CHILD: "1" } });
  process.exit(r.status ?? 2);
}

const { lintViewerFiles, viewerLintOk } = await import("../src/viewer-lint.ts");

const args = process.argv.slice(2);
const json = args.includes("--json");
const maxIdx = args.indexOf("--max-bytes");
const maxBytes = maxIdx >= 0 ? Number(args[maxIdx + 1]) : undefined;
const targets = args.filter((a, i) => !a.startsWith("--") && (maxIdx < 0 || i !== maxIdx + 1));
if (!targets.length) {
  console.error("usage: viewer-lint <dir|file>… [--json] [--max-bytes N]");
  process.exit(2);
}

const findings = [];
for (const t of targets) {
  const root = resolve(t);
  if (!existsSync(root)) {
    console.error(`viewer-lint: no such path: ${t}`);
    process.exit(2);
  }
  const files = [];
  const walk = (p) => {
    const s = statSync(p);
    if (s.isDirectory()) {
      for (const n of readdirSync(p)) if (n !== "node_modules" && !n.startsWith(".")) walk(join(p, n));
    } else files.push({ path: relative(statSync(root).isDirectory() ? root : resolve(root, ".."), p).split("\\").join("/"), content: new Uint8Array(readFileSync(p)) });
  };
  walk(root);
  findings.push(...lintViewerFiles(files, { maxBytes, root: t }));
}

if (json) console.log(JSON.stringify(findings, null, 2));
else {
  for (const f of findings) console.log(`${f.file}:${f.line} ${f.severity} [${f.rule}] ${f.message}`);
  console.log(findings.length ? `${findings.length} finding(s)` : "viewer-lint: clean");
}
process.exit(viewerLintOk(findings) ? 0 : 1);
