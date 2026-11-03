// node --test tools/dev-reset.test.mjs — `pnpm dev:reset` against a temp repo (todo22 W7).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { targets } from "./dev-reset.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const P = JSON.parse(readFileSync(join(here, "../schemas/naming.json"), "utf8")).envPrefix;
const script = join(here, "dev-reset.mjs");

function fakeRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dev-reset-")));
  for (const f of ["apps/api/.data/api.db", "apps/agent/.data/sessions/x.json", "seed-data/.annotations/p.json", "seed-data/sample.png", "secrets/workos.env"]) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
  return root;
}

const run = (root, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...process.env, [`${P}DEV_RESET_ROOT`]: root, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("--yes removes the dev data and keeps secrets and samples", () => {
  const root = fakeRepo();
  try {
    const r = run(root, ["--yes"], { [`${P}WEB_ANNOTATIONS_DIR`]: "" });
    assert.equal(r.status, 0, r.stderr);
    for (const gone of ["apps/api/.data", "apps/agent/.data", "seed-data/.annotations"]) assert.ok(!existsSync(join(root, gone)), gone);
    for (const kept of ["seed-data/sample.png", "secrets/workos.env"]) assert.ok(existsSync(join(root, kept)), kept);
    assert.match(r.stdout, /removed apps\/api\/\.data/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without --yes and without a terminal nothing is removed", () => {
  const root = fakeRepo();
  try {
    const r = run(root, []);
    assert.equal(r.status, 1);
    assert.ok(existsSync(join(root, "apps/api/.data/api.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run lists and keeps", () => {
  const root = fakeRepo();
  try {
    const r = run(root, ["--dry-run"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /apps\/agent\/\.data/);
    assert.ok(existsSync(join(root, "apps/agent/.data")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an annotations folder outside the repo, or a protected one, is refused", () => {
  const root = fakeRepo();
  try {
    assert.throws(() => targets(root, { [`${P}WEB_ANNOTATIONS_DIR`]: tmpdir() }), /outside the repo/);
    assert.throws(() => targets(root, { [`${P}WEB_ANNOTATIONS_DIR`]: "../elsewhere" }), /outside the repo/);
    assert.throws(() => targets(root, { [`${P}WEB_ANNOTATIONS_DIR`]: "secrets" }), /never removes/);
    assert.throws(() => targets(root, { [`${P}WEB_ANNOTATIONS_DIR`]: "seed-data" }), /never removes/);
    assert.throws(() => targets(root, { [`${P}WEB_ANNOTATIONS_DIR`]: "." }), /outside the repo|never removes/);
    const r = run(root, ["--yes"], { [`${P}WEB_ANNOTATIONS_DIR`]: "secrets" });
    assert.equal(r.status, 2);
    assert.ok(existsSync(join(root, "apps/api/.data")), "a refusal removes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
