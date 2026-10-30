#!/usr/bin/env node
// Rewrites stored documents after a namespace rename (todo/done/todo2.md D3):
//   node tools/rename-namespace.mjs --from <old> --to <new> [--dry-run]
//     [--env-prefix-from OLD_ --env-prefix-to NEW_] [--resource-prefix-from old --resource-prefix-to new]
// Every JSON string or key that is an id under `<old>.` (or mentions one inside a `when`
// clause or other text) becomes `<new>.`. Files: plugins/*/plugin.yaml, registry/presets/*.json, seed-data
// manifests, saved environments and annotations, and e2e / plugin fixtures. Edit
// packages/plugin-contracts/src/naming.ts first (namespace = <new>, legacyNamespaces += <old>)
// so documents that this script doesn't reach keep resolving.
//
// Deployment config (todo/done/todo3.md D.4) can't read the naming config at run time, so it spells
// the env prefix (`<OLD>_API_DATABASE_URL`) and the resource prefix (`<old>-objects` buckets,
// `<old>:jobs:ready` Redis keys) out. The same run rewrites them in infra/**, .github/**,
// apps/*/Dockerfile and apps/web/nginx/*. The prefixes default to the namespace (`--from acme`
// → `ACME_` and `acme`); pass the --*-prefix-* options when naming.ts sets them differently.
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
  console.error("usage: node tools/rename-namespace.mjs --from <old> --to <new> [--dry-run] [--env-prefix-from OLD_ --env-prefix-to NEW_] [--resource-prefix-from old --resource-prefix-to new]");
  process.exit(2);
}
const envPrefix = (ns) => `${ns.toUpperCase().replace(/-/g, "_")}_`;
const envFrom = opt("env-prefix-from") ?? envPrefix(from);
const envTo = opt("env-prefix-to") ?? envPrefix(to);
const resFrom = opt("resource-prefix-from") ?? from;
const resTo = opt("resource-prefix-to") ?? to;

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

// ---- Deployment config: env prefix and resource prefix ---------------------------------
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const envRe = new RegExp(`(?<![A-Za-z0-9_])${esc(envFrom)}(?=[A-Z0-9])`, "g");
// `<old>-objects`, `<old>:jobs:ready`, `<old>.flags`; not inside a longer word, path or URL.
const resRe = new RegExp(`(?<![\\w.\\-/@])${esc(resFrom)}(?=[-:.][\\w*])`, "g");
const configFile = (name) => /\.(ya?ml|json|env|sql|conf|template|toml|mjs|sh)$|^Dockerfile$|^Caddyfile$/.test(name) || name.endsWith(".env");
const configFiles = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "node_modules" || name === ".terraform") return [];
        return statSync(p).isDirectory() ? configFiles(p) : configFile(name) ? [p] : [];
      });
const deployTargets = [
  ...configFiles(join(root, "infra")),
  ...configFiles(join(root, ".github")),
  ...configFiles(join(root, "apps/web/nginx")),
  ...readdirSync(join(root, "apps")).map((a) => join(root, "apps", a, "Dockerfile")).filter(existsSync),
];
let deployChanged = 0;
for (const file of deployTargets) {
  const before = readFileSync(file, "utf8");
  const envHits = (before.match(envRe) ?? []).length;
  const resHits = resFrom === resTo ? 0 : (before.match(resRe) ?? []).length;
  if (!envHits && !resHits) continue;
  const after = before.replace(envRe, envTo).replace(resRe, resFrom === resTo ? resFrom : resTo);
  if (after === before) continue;
  deployChanged++;
  console.log(`${dry ? "would rewrite" : "rewrote"} ${relative(root, file)} (${envHits} env, ${resHits} resource)`);
  if (!dry) writeFileSync(file, after);
}
console.log(`${deployChanged} deployment file(s) ${dry ? "to rewrite" : "rewritten"}: ${envFrom}* → ${envTo}*, ${resFrom}[-:.]* → ${resTo}[-:.]*`);
