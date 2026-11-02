#!/usr/bin/env node
// `pnpm doctor` (todo19 §2 F): is this machine ready to run the product? Checks the worker's
// converters (ffmpeg/ffprobe for video, OpenSlide and libvips for slides, dciodvfy optional), the
// database (every table and column the api's models expect) and the seeds, and prints the one
// command that fixes each gap. Exit 1 when a required check fails.
//
//   node tools/doctor.mjs           all checks
//   node tools/doctor.mjs --worker  only the worker's converters (what `pnpm dev` prints)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const workerOnly = process.argv.includes("--worker");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", timeout: 120_000, ...opts });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

function version(out) {
  return /version\s+([\w.\-]+)/i.exec(out)?.[1] ?? "present";
}

/** The worker's own view (`studio_worker.capabilities.detect`), so doctor and the worker agree. */
function workerCapabilities() {
  const r = run("uv", [
    "run", "--quiet", "--package", "studio-worker", "python", "-c",
    "import json; from studio_worker import capabilities as c; d = c.detect(); print(json.dumps(d))",
  ]);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out.split("\n").pop());
  } catch {
    return null;
  }
}

const checks = [];
const add = (name, ok, detail, fix, optional = false) => checks.push({ name, ok, detail, fix, optional });

const caps = workerCapabilities();
if (caps === null) {
  add("worker environment", false, "uv couldn't run studio-worker", "uv sync");
} else {
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const r = run(tool, ["-version"]);
    add(tool, r.ok, r.ok ? version(r.out) : "not on PATH", "brew install ffmpeg  (Debian/Ubuntu: sudo apt-get install ffmpeg)");
  }
  add("OpenSlide", Boolean(caps.openslide), caps.openslide ?? "not importable in the worker", "uv sync  (openslide-python + openslide-bin)");
  add("pyvips (libvips)", Boolean(caps.pyvips), caps.pyvips ?? "not importable in the worker", "uv sync  (pyvips + pyvips-binary)");
  add("dciodvfy", Boolean(caps.dciodvfy), caps.dciodvfy ?? "not on PATH: DICOM checks are skipped", "install dicom3tools (https://www.dclunie.com/dicom3tools.html)", true);
}

if (!workerOnly) {
  const db = run("uv", [
    "run", "--quiet", "--package", "studio-api", "python", "-c",
    [
      "import sqlalchemy as sa",
      "from studio_api.config import settings",
      "from studio_api.db import Base",
      "import studio_api.models",
      "url = settings().database_url",
      "eng = sa.create_engine(url)",
      "insp = sa.inspect(eng)",
      "have = set(insp.get_table_names())",
      "miss = [t.name for t in Base.metadata.sorted_tables if t.name not in have]",
      "cols = [f'{t.name}.{c.name}' for t in Base.metadata.sorted_tables if t.name in have for c in t.columns if c.name not in {x['name'] for x in insp.get_columns(t.name)}]",
      "print(url.split('@')[-1], '|', ' '.join(miss + cols))",
    ].join("\n"),
  ]);
  if (!db.ok) add("database", false, db.out.split("\n").pop() || "unreachable", "pnpm infra:up  (then pnpm --filter @studio/api migrate)");
  else {
    const [where, missing] = db.out.split("\n").pop().split("|").map((s) => s.trim());
    const gaps = missing ? missing.split(" ") : [];
    const detail = gaps.length > 8 ? `${where}: ${gaps.length} tables or columns missing (not migrated?)` : gaps.length ? `${where}: missing ${missing}` : where;
    add("database", !missing, detail, "pnpm --filter @studio/api migrate  (a create_all dev sqlite: add the columns by hand, or delete it to recreate)");
  }
  const seeds = existsSync(join(repo, "seed-data/manifest.json"));
  add("seeds", seeds, seeds ? "seed-data/manifest.json" : "seed-data/ missing", "pnpm seeds");
}

let failed = 0;
for (const c of checks) {
  const mark = c.ok ? "ok  " : c.optional ? "skip" : "FAIL";
  if (!c.ok && !c.optional) failed++;
  console.log(`${mark}  ${c.name.padEnd(18)} ${c.detail}${c.ok ? "" : `\n      fix: ${c.fix}`}`);
}
if (failed) console.log(`\n${failed} check${failed === 1 ? "" : "s"} failed.`);
process.exit(failed ? 1 : 0);
