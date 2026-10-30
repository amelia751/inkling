// Repo-wide rules (docs/README.md, todo/done/todo3.md Phase B):
//   1. apps/* never import each other: they talk over HTTP and events only.
//   2. packages/* never import from apps/* or plugins/*.
//   3. plugins/*/ui imports only the SDK, contracts, ui and renderers (below).
// (Python has the same rules as import-linter contracts in the root pyproject.toml.)
//
// Plugin layering inside the web build (docs/modules.md, todo/done/todo2.md §1.9):
//   packages/contracts  → nothing internal
//   packages/plugin-ui-sdk     → contracts
//   packages/ui         → nothing internal
//   packages/renderers  → sdk, contracts, ui
//   plugins/*/ui               → sdk, contracts, ui, renderers, and other plugins'
//                                manifest.ts / public.ts only
//   extension-host             → sdk, contracts, ui (bundled.ts and host.tsx are the
//                                composition roots and may import anything)
//   studio (shell)             → extension-host, sdk, contracts, ui; never @plugins/*
//   studio/core                → like the shell, plus renderers (the built-in tools)
// Tests (*.test.ts, *.test-helpers.ts) may reach into the host to set up a real registry.
// Also: no brand name in code (D3). Usage: node tools/check-boundaries.mjs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const repo = new URL("..", import.meta.url).pathname;
const webSrc = join(repo, "apps/web/src");

const codeFiles = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "node_modules") return [];
        return statSync(p).isDirectory() ? codeFiles(p) : /\.(tsx?|mjs)$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
      });

const listDirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()) : []);

const IMPORT = /(?:import|export)\s[^"'`]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

/** Layer (and plugin name / path inside it) of a repo-relative path. */
function layerOfPath(rel) {
  let m;
  if ((m = /^packages\/(agent-protocol|contracts|plugin-ui-sdk|ui|renderers)\//.exec(rel))) return { layer: m[1] };
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
  "agent-protocol": [],
  "contracts": [],
  "plugin-ui-sdk": ["contracts"],
  "ui": [],
  "renderers": ["plugin-ui-sdk", "contracts", "ui"],
  plugin: ["plugin-ui-sdk", "contracts", "ui", "renderers"],
  host: ["plugin-ui-sdk", "contracts", "ui"],
  shell: ["host", "plugin-ui-sdk", "contracts", "ui", "core", "agent-protocol"],
  // Studio built-ins (files, labels, select, pan…): contributes like a plugin, lives in the shell.
  core: ["shell", "host", "plugin-ui-sdk", "contracts", "ui", "renderers", "agent-protocol"],
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
  const hint = from.layer === "plugin" || from.layer === "renderers" ? " (use the host API in @studio/plugin-ui-sdk)" : "";
  return `${name} must not depend on ${target}${hint}`;
}

const roots = ["apps/web/src", "packages", "plugins"].map((d) => join(repo, d));
const errors = [];
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
    errors.push(msg);
  }
}

// ---- Repo-wide rules 1 and 2 -------------------------------------------------------------
// Workspace package names of apps (`@studio/web`, `@studio/agent`, …) count as the app.
const APPS = listDirs(join(repo, "apps"));
const appPackages = new Map(
  APPS.flatMap((app) => {
    const pj = join(repo, "apps", app, "package.json");
    return existsSync(pj) ? [[JSON.parse(readFileSync(pj, "utf8")).name, app]] : [];
  }),
);
/** The app (or "plugins") an import resolves into, or null. */
function repoTarget(file, spec) {
  if (appPackages.has(spec.split("/").slice(0, 2).join("/"))) return { app: appPackages.get(spec.split("/").slice(0, 2).join("/")) };
  if (spec.startsWith("@plugins/")) return { plugins: true };
  if (!spec.startsWith(".")) return null;
  const rel = relative(repo, resolve(dirname(file), spec));
  let m;
  if ((m = /^apps\/([^/]+)\//.exec(rel))) return { app: m[1] };
  if (rel.startsWith("plugins/")) return { plugins: true };
  return null;
}
const repoRoots = [...APPS.map((a) => join("apps", a)), "packages"];
for (const file of repoRoots.flatMap((d) => codeFiles(join(repo, d)))) {
  const fromRel = relative(repo, file);
  const fromApp = /^apps\/([^/]+)\//.exec(fromRel)?.[1];
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const to = repoTarget(file, spec);
    if (!to) continue;
    let why = null;
    if (fromApp && to.app && to.app !== fromApp) why = `apps/${fromApp} must not import apps/${to.app}: apps talk over HTTP and events only`;
    else if (!fromApp && to.app) why = `packages must not import apps/${to.app}`;
    else if (!fromApp && to.plugins) why = "packages must not import plugins";
    if (!why) continue;
    const line = src.slice(0, m.index).split("\n").length;
    errors.push(`${fromRel}:${line}  ${src.split("\n")[line - 1].trim()}\n    → ${why}`);
  }
}

// ---- Rule 3 for Python plugin workers ----------------------------------------------------
// Plugins aren't uv workspace members (each keeps its own lock), so import-linter can't see
// them: a plugin's Python may import the SDK and third-party packages, never an app.
const pyFiles = (dir) =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "node_modules" || name === ".venv" || name === "__pycache__") return [];
        return statSync(p).isDirectory() ? pyFiles(p) : name.endsWith(".py") ? [p] : [];
      });
const PY_IMPORT = /^\s*(?:from|import)\s+(studio_api|studio_worker)\b/gm;
for (const file of pyFiles(join(repo, "plugins"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(PY_IMPORT)) {
    const line = src.slice(0, m.index).split("\n").length;
    errors.push(`${relative(repo, file)}:${line}  ${m[0].trim()}\n    → plugin workers import only studio_plugin_sdk (talk to the kernel through it)`);
  }
}

// ---- No brand name in code (todo/done/todo2.md D3) -------------------------------------
// The product name lives only in packages/contracts/src/naming.ts. Comments, docs,
// presets and fixtures may mention it; code (strings and identifiers) may not.
const BRAND = /\binkling\b/i;
const brandRoots = ["apps/web/src", "apps/web/dev", "apps/web/scripts", "apps/mcp/src", "packages", "plugins", "tools"].map((d) => join(repo, d)).filter(existsSync);
const brandExempt = (rel) => rel.endsWith("contracts/src/naming.ts") || rel === "tools/check-boundaries.mjs" || rel.includes("__fixtures__") || rel.includes("/node_modules/");
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
      errors.push(`${rel}:${line}  ${text.trim().slice(0, 100)}\n    → brand name in code: use NAMING / ns() from @studio/contracts/naming`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (errors.length) {
  console.error(`Module boundary violations (${errors.length}):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("Module boundaries OK.");
