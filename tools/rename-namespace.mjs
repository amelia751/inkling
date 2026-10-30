#!/usr/bin/env node
// Rewrites stored documents after a namespace rename (todo/todo2.md D3):
//   node tools/rename-namespace.mjs --from <old> --to <new> [--dry-run]
// Every JSON string or key that is an id under `<old>.` (or mentions one inside a `when`
// clause or other text) becomes `<new>.`. Files: plugins/*/plugin.yaml, registry/presets/*.json, seed-data
// manifests, saved environments and annotations, and e2e / plugin fixtures. Edit
// packages/plugin-contracts/src/naming.ts first (namespace = <new>, legacyNamespaces += <old>)
// so documents that this script doesn't reach keep resolving.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = opt("from");
const to = opt("to");
const dry = args.includes("--dry-run");
if (!from || !to || !/^[a-z][a-z0-9-]*$/.test(to)) {
  console.error("usage: node tools/rename-namespace.mjs --from <old> --to <new> [--dry-run]");
  process.exit(2);
}

const root = new URL("..", import.meta.url).pathname;
const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(`(^|[^\\w.-])${escaped}\\.(?=[\\w-])`, "g");
const renameText = (s) => s.replace(re, `$1${to}.`);

function walk(v) {
  if (typeof v === "string") return renameText(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [renameText(k), walk(x)]));
  return v;
}

const jsonFiles = (dir, deep = true) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "node_modules") return [];
        if (statSync(p).isDirectory()) return deep ? jsonFiles(p) : [];
        return name.endsWith(".json") || name.endsWith(".jsonl") || name === "plugin.yaml" ? [p] : [];
      });

const targets = [
  ...jsonFiles(join(root, "registry/presets")),
  ...jsonFiles(join(root, "seed-data"), false),
  ...jsonFiles(join(root, "seed-data/.environments")),
  ...jsonFiles(join(root, "seed-data/.annotations")),
  ...readdirSync(join(root, "seed-data")).flatMap((d) => (existsSync(join(root, "seed-data", d)) && statSync(join(root, "seed-data", d)).isDirectory() ? jsonFiles(join(root, "seed-data", d)).filter((f) => /environment[^/]*\.json$|workspace\.json$/.test(f)) : [])),
  ...jsonFiles(join(root, "apps/web/e2e/fixtures")),
  ...(existsSync(join(root, "plugins")) ? readdirSync(join(root, "plugins")).filter((p) => p !== "node_modules" && p !== "package.json").flatMap((p) => jsonFiles(join(root, "plugins", p))) : []),
];

let changed = 0;
for (const file of [...new Set(targets)]) {
  const before = readFileSync(file, "utf8");
  let after;
  if (file.endsWith(".yaml")) after = renameText(before);
  else if (file.endsWith(".jsonl")) after = before.split("\n").map((l) => (l.trim() ? JSON.stringify(walk(JSON.parse(l))) : l)).join("\n");
  else {
    let data;
    try {
      data = JSON.parse(before);
    } catch {
      continue;
    }
    const indent = /^\{\n(\s+)/.exec(before)?.[1] ?? "  ";
    after = JSON.stringify(walk(data), null, indent) + (before.endsWith("\n") ? "\n" : "");
  }
  if (after === before) continue;
  changed++;
  const count = (before.match(re) ?? []).length;
  console.log(`${dry ? "would rewrite" : "rewrote"} ${relative(root, file)} (${count} ids)`);
  if (!dry) writeFileSync(file, after);
}
console.log(`${changed} file(s) ${dry ? "to rewrite" : "rewritten"}: ${from}.* → ${to}.*`);
