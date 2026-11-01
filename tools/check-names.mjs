#!/usr/bin/env node
// Naming rules (todo/todo5.md): every name is `scope + role`, where the role is the folder.
//   1. Workspace packages: apps/<x> and packages/<x> are `@studio/<x>`; plugins/<x> is
//      `@studio/plugin-<x>` (a leading `_` is dropped: plugins/_template → @studio/plugin-template).
//      Python dists follow the same rule with dashes (`studio-<x>`, `studio-plugin-<x>`; a nested
//      member joins its path: apps/web/e2e → studio-web-e2e) and import as the dist name with
//      underscores. A `-py` folder may drop the suffix when a `-ts` twin exists
//      (packages/observability-py → studio-observability). Both repo roots are `studio-workspace`.
//   2. Env vars: each service reads them in one module (CONFIG_MODULES), through a helper that adds
//      the naming config's envPrefix. Anywhere else only third-party standards and NAMING_FILE may
//      be read by name. Passing the whole environment on (`{**os.environ}`, `opts.env ?? process.env`)
//      is fine. Tests and scripts are exempt.
// Usage: node tools/check-names.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const errors = [];
const read = (p) => readFileSync(join(repo, p), "utf8");
const dirs = (d) => (existsSync(join(repo, d)) ? readdirSync(join(repo, d)).filter((n) => statSync(join(repo, d, n)).isDirectory()) : []);

// ---- 1. Package names ---------------------------------------------------------------------
const npmName = (top, folder) => (top === "plugins" ? `@studio/plugin-${folder.replace(/^_/, "")}` : `@studio/${folder}`);
const pyNames = (top, folder) => {
  const base = top === "plugins" ? `studio-plugin-${folder.replace(/^_/, "")}` : `studio-${folder}`;
  const twin = /-py$/.test(folder) && existsSync(join(repo, top, folder.replace(/-py$/, "-ts")));
  return twin ? [base, base.replace(/-py$/, "")] : [base];
};
const pyproject = (rel) => /^\[project\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(read(rel))?.[1];

for (const top of ["apps", "packages", "plugins"]) {
  for (const folder of dirs(top)) {
    const pj = `${top}/${folder}/package.json`;
    if (existsSync(join(repo, pj))) {
      const name = JSON.parse(read(pj)).name;
      if (name !== npmName(top, folder)) errors.push(`${pj}: name is ${name}, expected ${npmName(top, folder)}`);
    }
    const pp = `${top}/${folder}/pyproject.toml`;
    if (existsSync(join(repo, pp))) {
      const name = pyproject(pp);
      const want = pyNames(top, folder);
      if (!want.includes(name)) errors.push(`${pp}: name is ${name}, expected ${want.join(" or ")}`);
      const src = `${top}/${folder}/src`;
      const mod = name?.replaceAll("-", "_");
      if (existsSync(join(repo, src)) && mod && !existsSync(join(repo, src, mod))) errors.push(`${src}/: the import package should be ${mod}/ (the dist name ${name} with underscores)`);
    }
  }
}
// Nested Python members of the uv workspace (apps/web/e2e → studio-web-e2e).
for (const member of JSON.parse(`[${/^members\s*=\s*\[([^\]]*)\]/m.exec(read("pyproject.toml"))?.[1] ?? ""}]`)) {
  const parts = member.split("/");
  if (parts.length < 3) continue;
  const want = `studio-${parts.slice(1).join("-")}`;
  const name = pyproject(`${member}/pyproject.toml`);
  if (name !== want) errors.push(`${member}/pyproject.toml: name is ${name}, expected ${want}`);
}
for (const [file, name] of [["package.json", JSON.parse(read("package.json")).name], ["pyproject.toml", pyproject("pyproject.toml")]]) {
  if (name !== "studio-workspace") errors.push(`${file}: the root is named ${name}, expected studio-workspace`);
}

// ---- 2. Where env vars are read -------------------------------------------------------------
const CONFIG_MODULES = new Set([
  "apps/agent/src/config.ts",
  "apps/api/src/studio_api/config.py",
  "apps/api/src/studio_api/naming.py", // finds REPO_ROOT / NAMING_FILE, i.e. the prefix itself
  "apps/worker/src/studio_worker/config.py",
  "apps/versioning/internal/config/config.go",
  "apps/pipeline/internal/config/config.go",
  "apps/web/vite.config.ts",
  "apps/mcp/src/main.ts",
  "packages/plugin-sdk/src/studio_plugin_sdk/naming.py", // the SDK's env() for plugin code
]);
const THIRD_PARTY = /^(NAMING_FILE|NODE_ENV|CI|HOME|PATH|HOSTNAME|GIT_SHA|OTEL_\w+|AWS_\w+|DAYTONA_\w+|OPENAI_API_KEY|ANTHROPIC_API_KEY|UV_\w+|VIRTUAL_ENV)$/;
const ACCESS = {
  // process.env.X | process.env["X"] | process.env[expr]
  ts: /process\.env(?:\.([A-Za-z_]\w*)|\[\s*["'`]([^"'`$]*)["'`]\s*\]|(\[))/g,
  // os.environ.get("X") | os.environ["X"] | os.getenv("X") | the same with an expression
  py: /os\.(?:environ\.get|environ\s*\[|getenv)\(?\s*(?:["'](\w+)["']|(\S))/g,
  // os.Getenv("X") | os.Getenv(expr) | os.LookupEnv
  go: /os\.(?:Getenv|LookupEnv)(?:\(\s*(?:"(\w+)"|(\S)))?/g,
};
const SKIP = /(^|\/)(node_modules|\.venv|__pycache__|_generated|dist|tests?|e2e|scripts|__fixtures__)(\/|$)|\.test\.ts$|_test\.go$|\.d\.ts$/;
const walk = (d) =>
  !existsSync(join(repo, d))
    ? []
    : readdirSync(join(repo, d)).flatMap((n) => {
        const rel = `${d}/${n}`;
        if (SKIP.test(rel)) return [];
        return statSync(join(repo, rel)).isDirectory() ? walk(rel) : [rel];
      });
const files = [...dirs("apps").map((a) => `apps/${a}`), ...dirs("packages").map((p) => `packages/${p}`), ...dirs("plugins").map((p) => `plugins/${p}`)].flatMap(walk);
for (const rel of [...files, "apps/web/vite.config.ts"]) {
  const lang = /\.(tsx?|mjs)$/.test(rel) ? "ts" : rel.endsWith(".py") ? "py" : rel.endsWith(".go") ? "go" : null;
  if (!lang || CONFIG_MODULES.has(rel)) continue;
  const src = read(rel);
  for (const m of src.matchAll(ACCESS[lang])) {
    const name = lang === "ts" ? (m[1] ?? m[2]) : m[1];
    const dynamic = lang === "ts" ? m[3] : m[2];
    if (name === undefined && !dynamic) continue; // the whole environment, passed on
    if (name !== undefined && THIRD_PARTY.test(name)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    errors.push(`${rel}:${line}  ${m[0]}\n    → read settings through this service's config module (${[...CONFIG_MODULES].filter((c) => c.startsWith(rel.split("/").slice(0, 2).join("/"))).join(", ") || "add one"})`);
  }
}

if (errors.length) {
  console.error(`Naming violations (${errors.length}):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("Names OK.");
