// Enforces the plugin layering (docs/modules.md, todo/todo2.md §1.9):
//   packages/plugin-contracts  → nothing internal
//   packages/plugin-ui-sdk     → contracts
//   packages/studio-ui         → nothing internal
//   packages/studio-renderers  → sdk, contracts, studio-ui
//   plugins/*/ui               → sdk, contracts, studio-ui, studio-renderers, and other plugins'
//                                manifest.ts / public.ts only
//   extension-host             → sdk, contracts, studio-ui (bundled.ts and host.tsx are the
//                                composition roots and may import anything)
//   studio (shell)             → extension-host, sdk, contracts, studio-ui; never @plugins/*
//   studio/core                → like the shell, plus studio-renderers (the built-in tools)
// Tests (*.test.ts, *.test-helpers.ts) may reach into the host to set up a real registry.
// Also: no brand name in code (D3). Usage: node scripts/check-boundaries.mjs [--strict].
// Without --strict, files listed in scripts/boundaries-allowlist.json only warn.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const repo = new URL("../../..", import.meta.url).pathname;
const webSrc = join(repo, "apps/web/src");
const strict = process.argv.includes("--strict");
const allowFile = new URL("./boundaries-allowlist.json", import.meta.url).pathname;
const allowlist = !strict && existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, "utf8")) : [];

const codeFiles = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "node_modules") return [];
        return statSync(p).isDirectory() ? codeFiles(p) : /\.(tsx?|mjs)$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
      });

const IMPORT = /(?:import|export)\s[^"'`]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

/** Layer (and plugin name / path inside it) of a repo-relative path. */
function layerOfPath(rel) {
  let m;
  if ((m = /^packages\/(plugin-contracts|plugin-ui-sdk|studio-ui|studio-renderers)\//.exec(rel))) return { layer: m[1] };
  if ((m = /^plugins\/([^/]+)\/ui\/(.*)$/.exec(rel))) return { layer: "plugin", plugin: m[1], rest: m[2] };
  if (rel.startsWith("apps/web/src/extension-host/")) return { layer: "host", rest: rel.slice("apps/web/src/extension-host/".length) };
  if (rel.startsWith("apps/web/src/studio/core/")) return { layer: "core" };
  if (rel.startsWith("apps/web/src/studio/") || /^apps\/web\/src\/[^/]+$/.test(rel)) return { layer: "shell" };
  return { layer: "other" };
}

/** Layer of an import target, or null for third-party packages. */
function layerOfImport(file, spec) {
  let m;
  if ((m = /^@studio\/([^/]+)/.exec(spec))) return { layer: m[1] };
  if ((m = /^@plugins\/([^/]+)\/(.*)$/.exec(spec))) return { layer: "plugin", plugin: m[1], rest: m[2] };
  let abs;
  if (spec.startsWith("@/")) abs = join(webSrc, spec.slice(2));
  else if (spec.startsWith(".")) abs = resolve(dirname(file), spec);
  else return null;
  return layerOfPath(relative(repo, abs));
}

const ALLOWED = {
  "plugin-contracts": [],
  "plugin-ui-sdk": ["plugin-contracts"],
  "studio-ui": [],
  "studio-renderers": ["plugin-ui-sdk", "plugin-contracts", "studio-ui"],
  plugin: ["plugin-ui-sdk", "plugin-contracts", "studio-ui", "studio-renderers"],
  host: ["plugin-ui-sdk", "plugin-contracts", "studio-ui"],
  shell: ["host", "plugin-ui-sdk", "plugin-contracts", "studio-ui", "core"],
  // Studio built-ins (files, labels, select, pan…): contributes like a plugin, lives in the shell.
  core: ["shell", "host", "plugin-ui-sdk", "plugin-contracts", "studio-ui", "studio-renderers"],
};
const isPublicEntry = (rest) => /^(manifest|public)(\.tsx?)?$/.test(rest);
const COMPOSITION_ROOTS = new Set(["bundled", "host"]);

function violation(fromRel, from, to) {
  if (from.layer === "other") return null;
  if (to.layer === from.layer) {
    if (to.layer === "plugin" && to.plugin !== from.plugin && !isPublicEntry(to.rest)) return `plugins/${from.plugin} may only import plugins/${to.plugin}/ui/manifest.ts or public.ts`;
    return null;
  }
  if (from.layer === "host" && COMPOSITION_ROOTS.has(from.rest.replace(/\.tsx?$/, ""))) return null;
  if (/\.test\.tsx?$|\.test-helpers\.ts$/.test(fromRel) && (to.layer === "host" || to.layer === "shell" || to.layer === "plugin")) return null;
  if (ALLOWED[from.layer]?.includes(to.layer)) return null;
  const name = { plugin: "plugins/*/ui", host: "extension-host", shell: "the Studio shell" }[from.layer] ?? `packages/${from.layer}`;
  const target = { plugin: "@plugins/*", host: "extension-host", shell: "the Studio shell (apps/web/src/studio)" }[to.layer] ?? `@studio/${to.layer}`;
  const hint = from.layer === "plugin" || from.layer === "studio-renderers" ? " (use the host API in @studio/plugin-ui-sdk)" : "";
  return `${name} must not depend on ${target}${hint}`;
}

const roots = ["apps/web/src", "packages", "plugins"].map((d) => join(repo, d));
const errors = [], warnings = [];
for (const file of roots.flatMap(codeFiles)) {
  const fromRel = relative(repo, file);
  const from = layerOfPath(fromRel);
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const to = layerOfImport(file, spec);
    if (!to) continue;
    const why = violation(fromRel, from, to);
    if (!why) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const msg = `${fromRel}:${line}  ${lines[line - 1].trim()}\n    → ${why}`;
    (allowlist.some((p) => fromRel.startsWith(p)) ? warnings : errors).push(msg);
  }
}

// ---- No brand name in code (todo/todo2.md D3) -------------------------------------
// The product name lives only in packages/plugin-contracts/src/naming.ts. Comments, docs,
// presets and fixtures may mention it; code (strings and identifiers) may not.
const BRAND = /\binkling\b/i;
const brandRoots = ["apps/web/src", "apps/web/dev", "apps/web/scripts", "packages", "plugins"].map((d) => join(repo, d)).filter(existsSync);
const brandExempt = (rel) => rel.endsWith("plugin-contracts/src/naming.ts") || rel.includes("__fixtures__") || rel.includes("/node_modules/");
for (const file of brandRoots.flatMap(codeFiles)) {
  const rel = relative(repo, file);
  if (brandExempt(rel)) continue;
  const src = readFileSync(file, "utf8");
  if (!BRAND.test(src)) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    const leaf = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || node.kind === ts.SyntaxKind.JsxText;
    if (leaf) {
      const text = node.getText(sf);
      if (!BRAND.test(text)) return;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      errors.push(`${rel}:${line}  ${text.trim().slice(0, 100)}\n    → brand name in code: use NAMING / ns() from @studio/plugin-contracts/naming`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (warnings.length) console.warn(`Boundary exceptions (allowlisted, ${warnings.length}):\n${warnings.join("\n")}\n`);
if (errors.length) {
  console.error(`Module boundary violations (${errors.length}):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`Module boundaries OK${strict ? " (strict)" : allowlist.length ? ` (${allowlist.length} allowlisted paths)` : ""}.`);
