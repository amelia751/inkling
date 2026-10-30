// Icons come only from packages/studio-ui/src/icons. Fails on direct imports of icon
// packages anywhere else in the app, packages or plugins (e.g. lucide-react pulled in by a
// pasted shadcn component).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repo = new URL("../../..", import.meta.url).pathname;
const roots = ["apps/web/src", "packages", "plugins"].map((d) => join(repo, d));
const allowed = join(repo, "packages/studio-ui/src/icons");
const banned = /from\s+["'](lucide-react|@gravity-ui\/icons[^"']*|react-icons[^"']*|@heroicons\/[^"']*|@radix-ui\/react-icons)["']/;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(name) ? [p] : [];
  });

const bad = roots
  .flatMap(walk)
  .filter((f) => !f.startsWith(allowed))
  .flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((line, i) => (banned.test(line) ? `${relative(repo, f)}:${i + 1}  ${line.trim()}` : null))
      .filter(Boolean),
  );

if (bad.length) {
  console.error(`Import icons from "@studio/studio-ui/icons" instead:\n${bad.join("\n")}`);
  process.exit(1);
}
