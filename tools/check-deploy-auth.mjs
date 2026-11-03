#!/usr/bin/env node
// Dev mode can't be deployed (todo22 D2). Every deploy config signs people in with WorkOS:
// this fails on any
//   - `*AUTH_MODE` other than `workos`;
//   - `*DEV_TRUST_HEADERS` that isn't off (0/false);
//   - `*AGENT_STORE=file` (the agent's laptop store);
//   - a `sqlite:` URL.
// It reads
//   1. every YAML / env file under infra/k8s (base, components, overlays: ConfigMap data, env
//      name/value pairs, JSON-patch `path: /data/<KEY>` + `value:`, `KEY=value` literals), so a
//      patch that never renders still can't carry dev mode;
//   2. every overlay rendered with `kubectl kustomize` when kubectl is on PATH (skipped otherwise,
//      and for overlays/gke/live/*, which need the git-ignored local.env);
//   3. every Terraform file under infra/terraform (Cloud Run `run.tf`: `env { name = "…" value =
//      "…" }` blocks, and `KEY = "value"` assignments in maps).
// Dev auth lives only in `pnpm dev` (tools/dev.mjs) and infra/docker/env/*, which it doesn't read.
// Usage: node tools/check-deploy-auth.mjs [--root <repo>] [--no-render]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
const stripComment = (line) => line.replace(/\s+#.*$/, "");

/** The rule a key/value breaks, or null. */
export function violation(key, rawValue) {
  const value = unquote(String(rawValue));
  if (/sqlite:/i.test(value)) return "sqlite URL (deployed stages use Postgres)";
  if (/AUTH_MODE$/.test(key) && value !== "workos") return `auth mode must be workos, not "${value}"`;
  if (/DEV_TRUST_HEADERS$/.test(key) && !/^(0|false|no|off)$/i.test(value)) return "trusted dev headers must be off";
  if (/AGENT_STORE$/.test(key) && value.toLowerCase() === "file") return "the agent's file store is laptop only";
  return null;
}

/** Key/value pairs in YAML or env-file text, with 1-based line numbers. */
export function yamlPairs(text) {
  const pairs = [];
  let pending = null; // { key, until }: a `name: KEY` or `path: /data/KEY` waiting for `value:`
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = stripComment(raw);
    if (/^\s*#/.test(line) || !line.trim()) return;
    const n = i + 1;
    let m;
    if ((m = /^\s*(?:-\s+)?name:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(line))) {
      pending = { key: m[1], until: n + 3 };
      return;
    }
    if ((m = /^\s*(?:-\s+)?path:\s*\/data\/([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line))) {
      pending = { key: m[1], until: n + 3 };
      return;
    }
    if ((m = /^\s*(?:-\s+)?value:\s*(.*)$/.exec(line))) {
      if (pending && n <= pending.until && m[1].trim()) pairs.push({ key: pending.key, value: m[1], line: n });
      pending = null;
      return;
    }
    if (/^\s*(?:-\s+)?valueFrom:/.test(line)) pending = null;
    if ((m = /^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*):\s+(\S.*)$/.exec(line))) pairs.push({ key: m[1], value: m[2], line: n });
    else if ((m = /^\s*(?:-\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)=(.*?)["']?\s*$/.exec(line))) pairs.push({ key: m[1], value: m[2], line: n });
    // A sqlite URL anywhere on a line (flow maps, args, literals).
    if (/sqlite:/i.test(line) && !pairs.some((p) => p.line === n && /sqlite:/i.test(p.value)))
      pairs.push({ key: "(value)", value: line.trim(), line: n });
  });
  return pairs;
}

/** Key/value pairs in Terraform text (Cloud Run env blocks and `KEY = "value"` assignments). */
export function terraformPairs(text) {
  const pairs = [];
  const lineOf = (idx) => text.slice(0, idx).split("\n").length;
  const clean = text.replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
  for (const m of clean.matchAll(/\benv\s*\{([^{}]*?)\}/g)) {
    const name = /\bname\s*=\s*"([^"]+)"/.exec(m[1])?.[1];
    const value = /\bvalue\s*=\s*"([^"]*)"/.exec(m[1])?.[1];
    if (name && value !== undefined) pairs.push({ key: name, value, line: lineOf(m.index) });
  }
  for (const m of clean.matchAll(/(?<![\w."])"?([A-Z][A-Z0-9_]*)"?\s*=\s*"([^"]*)"/g))
    pairs.push({ key: m[1], value: m[2], line: lineOf(m.index) });
  for (const m of clean.matchAll(/"([^"\n]*sqlite:[^"\n]*)"/gi)) pairs.push({ key: "(value)", value: m[1], line: lineOf(m.index) });
  return pairs;
}

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".terraform") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(name)) out.push(p);
  }
  return out;
}

function overlays(k8s) {
  return walk(join(k8s, "overlays"), (n) => n === "kustomization.yaml")
    .filter((p) => /^kind:\s*Kustomization\s*$/m.test(readFileSync(p, "utf8")))
    .map((p) => p.slice(0, -"/kustomization.yaml".length))
    .filter((d) => !d.split(sep).includes("live"));
}

const hasKubectl = () => spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status === 0;

/** Every violation in the repo at `root`: [{ file, line, key, value, why }]. */
export function checkDeployAuth({ root, render = true } = {}) {
  const found = [];
  const add = (file, pairs) => {
    for (const p of pairs) {
      const why = violation(p.key, p.value);
      if (why) found.push({ file, line: p.line, key: p.key, value: unquote(p.value), why });
    }
  };
  const k8s = join(root, "infra/k8s");
  for (const f of walk(k8s, (n) => /\.(ya?ml|env)$|\.env\.example$|^local\.env$/.test(n)))
    add(relative(root, f), yamlPairs(readFileSync(f, "utf8")));
  for (const f of walk(join(root, "infra/terraform"), (n) => n.endsWith(".tf")))
    add(relative(root, f), terraformPairs(readFileSync(f, "utf8")));
  const rendered = [];
  if (render && existsSync(k8s) && hasKubectl()) {
    for (const dir of overlays(k8s)) {
      const label = `kubectl kustomize ${relative(root, dir)}`;
      const r = spawnSync("kubectl", ["kustomize", dir], { encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status !== 0) {
        found.push({ file: label, line: 0, key: "(render)", value: "", why: `render failed: ${r.stderr.trim().split("\n")[0]}` });
        continue;
      }
      rendered.push(relative(root, dir));
      add(label, yamlPairs(r.stdout));
    }
  }
  return { found, rendered };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const rootArg = args.indexOf("--root");
  const root = rootArg >= 0 ? args[rootArg + 1] : fileURLToPath(new URL("..", import.meta.url));
  const render = !args.includes("--no-render");
  const { found, rendered } = checkDeployAuth({ root, render });
  if (found.length) {
    console.error(`check-deploy-auth: ${found.length} deploy setting(s) would run dev mode (todo22 D2):`);
    for (const f of found) console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.key}=${f.value}  (${f.why})`);
    process.exit(1);
  }
  const how = rendered.length ? `rendered ${rendered.length} overlay(s)` : render ? "kubectl not found, files only" : "files only";
  console.log(`check-deploy-auth: ok (${how})`);
}
