// Enforces the module architecture's layering (docs/modules.md, todo/todo.md §1):
//   platform  → nothing below it (no kits, modules or Studio components)
//   kits      → platform only (never a module)
//   modules   → platform, kits, and other modules' manifest.ts / public.ts only
//   shell     → platform (never a module directly; src/bundle.ts is the one composition root)
// Usage: node scripts/check-boundaries.mjs [--strict]. Without --strict, files listed in
// scripts/boundaries-allowlist.json only warn; --strict ignores the allowlist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = new URL("../src", import.meta.url).pathname;
const strict = process.argv.includes("--strict");
const allowFile = new URL("./boundaries-allowlist.json", import.meta.url).pathname;
const allowlist = !strict && existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, "utf8")) : [];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?|mjs)$/.test(name) ? [p] : [];
  });

const IMPORT = /(?:import|export)\s[^"'`]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

/** Repo-relative target ("platform/registry.ts") of an import, or null for packages. */
function target(file, spec) {
  let abs;
  if (spec.startsWith("@/")) abs = join(root, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(file), spec);
  else return null;
  return relative(root, abs).replace(/\.(tsx?|jsx?)$/, "");
}

const layer = (rel) => {
  if (rel === "bundle") return "root";
  const top = rel.split("/")[0];
  if (top === "platform" || top === "kits" || top === "modules") return top;
  if (top === "app" || top === "lib" || (top === "components" && rel.startsWith("components/studio"))) return "shell";
  return "other";
};
const moduleOf = (rel) => rel.split("/")[1];
const isPublicEntry = (rel) => /^modules\/[^/]+\/(manifest|public)$/.test(rel) || /^modules\/[^/]+$/.test(rel);

function violation(from, to) {
  const a = layer(from), b = layer(to);
  if (a === "platform" && (b === "modules" || b === "kits" || to.startsWith("components/studio"))) return "platform must not depend on modules, kits or Studio components";
  if (a === "kits" && b === "modules") return "kits must not depend on modules";
  if (a === "kits" && to.startsWith("components/studio")) return "kits must not depend on Studio components";
  if (a === "modules" && b === "modules" && moduleOf(from) !== moduleOf(to) && !isPublicEntry(to))
    return `modules/${moduleOf(from)} may only import modules/${moduleOf(to)}/manifest.ts or public.ts`;
  if (a === "modules" && (to.startsWith("app/") || to.startsWith("components/studio"))) return "modules must not import the Studio shell; use RendererProps and platform/runtime";
  if (a === "shell" && b === "modules") return "the shell reaches modules only through platform/ (registry, ViewportHost)";
  return null;
}

const errors = [], warnings = [];
for (const file of walk(root)) {
  const from = relative(root, file).replace(/\.(tsx?|jsx?|mjs)$/, "");
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const to = target(file, spec);
    if (!to) continue;
    const why = violation(from, to);
    if (!why) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const msg = `${relative(root, file)}:${line}  ${lines[line - 1].trim()}\n    → ${why}`;
    (allowlist.some((p) => from.startsWith(p)) ? warnings : errors).push(msg);
  }
}

if (warnings.length) console.warn(`Boundary exceptions (allowlisted, ${warnings.length}):\n${warnings.join("\n")}\n`);
if (errors.length) {
  console.error(`Module boundary violations (${errors.length}):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`Module boundaries OK${strict ? " (strict)" : allowlist.length ? ` (${allowlist.length} allowlisted paths)` : ""}.`);
