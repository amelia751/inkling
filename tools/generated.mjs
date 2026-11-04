#!/usr/bin/env node
// Every generated file in the repo, in one place.
//   pnpm regen            rebuild them all (in dependency order)
//   pnpm check:generated  fail if any is stale (what ci and the pre-push hook run)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");

const run = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, out }));
  });

async function apiClientCurrent() {
  const dir = mkdtempSync(path.join(tmpdir(), "api-client-"));
  try {
    const out = path.join(dir, "schema.d.ts");
    const r = await run("pnpm", ["--filter", "@studio/api-client", "exec", "openapi-typescript", "../../schemas/api/openapi.json", "-o", out]);
    if (!r.ok) return r;
    const same = readFileSync(out, "utf8") === readFileSync(path.join(root, "packages/api-client/src/schema.d.ts"), "utf8");
    return { ok: same, out: same ? "" : "packages/api-client/src/schema.d.ts is stale" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// [what, regenerate, check]; regenerated in this order (the api-client reads the OpenAPI spec).
const artifacts = [
  ["schemas/ (environment schema, catalogue, modules reference)", ["pnpm", ["emit:schemas"]], ["pnpm", ["emit:schemas", "--check"]]],
  ["registry/index.json", ["node", ["tools/build-registry.mjs"]], ["node", ["tools/build-registry.mjs", "--check"]]],
  ["kernel contracts (apps/api _generated)", ["pnpm", ["--filter", "@studio/api", "exec", "uv", "run", "--package", "studio-api", "python", "scripts/gen_contracts.py"]], ["pnpm", ["--filter", "@studio/api", "contracts:check"]]],
  ["schemas/api/openapi.json", ["uv", ["run", "--package", "studio-api", "python", "apps/api/scripts/dump_openapi.py"]], ["uv", ["run", "--package", "studio-api", "python", "apps/api/scripts/dump_openapi.py", "--check"]]],
  ["packages/api-client/src/schema.d.ts", ["pnpm", ["--filter", "@studio/api-client", "generate"]], apiClientCurrent],
];

if (check) {
  const results = await Promise.all(artifacts.map(([, , c]) => (typeof c === "function" ? c() : run(...c))));
  const stale = artifacts.filter((_, i) => !results[i].ok);
  for (const [name] of stale) {
    const r = results[artifacts.findIndex((a) => a[0] === name)];
    console.error(`stale: ${name}\n${r.out.trim().split("\n").slice(-6).join("\n")}\n`);
  }
  if (stale.length) {
    console.error("Generated files are out of date. Run `pnpm regen` and commit the result.");
    process.exit(1);
  }
  console.log("Generated files are current.");
} else {
  for (const [name, [cmd, args]] of artifacts) {
    process.stdout.write(`${name} … `);
    const r = await run(cmd, args);
    if (!r.ok) {
      console.log("failed");
      console.error(r.out);
      process.exit(1);
    }
    console.log("ok");
  }
}
