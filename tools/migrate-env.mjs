#!/usr/bin/env node
// Renames env keys in a developer's local secrets/*.env after the todo5 Phase 3 rename
// (one scheme for every service: `<P><ROLE>_<KEY>`, `<P>ENV`, `<P>LOG_LEVEL`, `NAMING_FILE`;
// see secrets/README.md). Rewrites key names in place and never prints a value.
//   node tools/migrate-env.mjs [--dry-run] [file.env ...]   (default: secrets/*.env)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const { envPrefix: P } = JSON.parse(readFileSync(join(repo, "schemas/naming.json"), "utf8"));
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const files = args.filter((a) => !a.startsWith("--"));

/** Old key → new key; null drops the line. */
const RENAMES = {
  INTERNAL_AGENT_SERVICE_TOKEN: `${P}AGENT_TOKEN`,
  APP_ENV: `${P}ENV`,
  [`${P}API_ENV`]: `${P}ENV`,
  API_ENV: `${P}ENV`,
  LOG_LEVEL: `${P}LOG_LEVEL`,
  LOG_FORMAT: `${P}LOG_FORMAT`,
  AGENT_NAMING_FILE: "NAMING_FILE",
  NAMING_CONFIG: "NAMING_FILE",
  [`${P}KERNEL_URL`]: `${P}API_URL`,
  AGENT_KERNEL_URL: `${P}API_URL`,
  AGENT_STUDIO_URL: `${P}WEB_URL`,
  SWEEPER_ENABLED: `${P}AGENT_SWEEPER_ENABLED`,
  [`${P}KERNEL`]: null,
  [`VITE_${P}KERNEL`]: null,
  LOAD_ENTRIES: `${P}VERSIONING_LOAD_ENTRIES`,
  LOAD_RESULTS: `${P}VERSIONING_LOAD_RESULTS`,
  VERBOSE: `${P}VERSIONING_TEST_VERBOSE`,
};
/** Every other unprefixed AGENT_* key gains the prefix. */
const rename = (key) => (key in RENAMES ? RENAMES[key] : key.startsWith("AGENT_") ? `${P}${key}` : key);

const dir = join(repo, "secrets");
const targets = files.length ? files : existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".env")).map((n) => join(dir, n)) : [];
let changed = 0;
for (const file of targets) {
  const lines = readFileSync(file, "utf8").split("\n");
  const notes = [];
  const out = lines.flatMap((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=.*)$/.exec(line);
    if (!m) return [line];
    const next = rename(m[2]);
    if (next === m[2]) return [line];
    notes.push(next === null ? `${m[2]} (removed)` : `${m[2]} → ${next}`);
    return next === null ? [] : [`${m[1]}${next}${m[3]}`];
  });
  if (!notes.length) continue;
  changed++;
  console.log(`${relative(process.cwd(), file)}: ${notes.join(", ")}`);
  if (!dry) writeFileSync(file, out.join("\n"));
}
console.log(changed ? (dry ? "Dry run: nothing written." : `Updated ${changed} file(s).`) : "Nothing to migrate.");
