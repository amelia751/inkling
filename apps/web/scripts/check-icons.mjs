// Icons come only from src/components/icons. Fails on direct imports of icon
// packages elsewhere (e.g. lucide-react pulled in by a pasted shadcn component).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../src", import.meta.url).pathname;
const allowed = join(root, "components/icons");
const banned = /from\s+["'](lucide-react|@gravity-ui\/icons[^"']*|react-icons[^"']*|@heroicons\/[^"']*|@radix-ui\/react-icons)["']/;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(name) ? [p] : [];
  });

const bad = walk(root)
  .filter((f) => !f.startsWith(allowed))
  .flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((line, i) => (banned.test(line) ? `${relative(root, f)}:${i + 1}  ${line.trim()}` : null))
      .filter(Boolean),
  );

if (bad.length) {
  console.error(`Import icons from "@/components/icons" instead:\n${bad.join("\n")}`);
  process.exit(1);
}
