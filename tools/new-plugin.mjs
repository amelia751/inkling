// Scaffold a first-party plugin from plugins/_template (AGENTS.md, "Adding a first-party plugin").
//   node tools/new-plugin.mjs <name> ["Title"]
// Copies the template (minus node_modules), renames the `example` module id, the package name
// and the test file, then prints the registration steps that need a human (or agent) decision.
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const [name, title = name?.replace(/(^|-)(\w)/g, (_, dash, c) => (dash ? " " : "") + c.toUpperCase())] = process.argv.slice(2);
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("usage: node tools/new-plugin.mjs <name> [\"Title\"]   (name: lowercase, digits and dashes)");
  process.exit(1);
}
const dest = join(root, "plugins", name);
if (existsSync(dest)) {
  console.error(`plugins/${name} already exists`);
  process.exit(1);
}
const { namespace } = JSON.parse(readFileSync(join(root, "schemas/naming.json"), "utf8"));

cpSync(join(root, "plugins/_template"), dest, { recursive: true, filter: (src) => !src.includes("node_modules") });
renameSync(join(dest, "ui/template.test.ts"), join(dest, `ui/${name}.test.ts`));

const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
for (const file of files(dest)) {
  const before = readFileSync(file, "utf8");
  const after = before
    .replaceAll("@studio/plugin-template", `@studio/plugin-${name}`)
    .replaceAll(`${namespace}.example`, `${namespace}.${name}`)
    .replaceAll('ns("example', `ns("${name}`)
    .replaceAll("Example module", title);
  if (after !== before) writeFileSync(file, after);
}

console.log(`Created plugins/${name}. Next:
  1. Edit plugins/${name}/ui/manifest.ts and plugin.yaml (descriptions, contributions).
  2. Register it in apps/web/src/extension-host/bundled.ts (one import, one array entry),
     add "@studio/plugin-${name}": "workspace:*" to apps/web/package.json and its
     "@plugins/${name}/*" path to apps/web/tsconfig.json.
  3. pnpm install && pnpm emit:schemas && node tools/build-registry.mjs
  4. Add an e2e smoke test (apps/web/e2e) and a preset if it boots a Studio on its own.`);
