#!/usr/bin/env node
// `pnpm dev:reset` (todo22 W7): wipe the laptop's dev data so `pnpm dev` starts from nothing.
//
//   node tools/dev-reset.mjs          asks y/N, then removes:
//     apps/api/.data                  the api's SQLite, dev secret key, signing key, local blobs
//     apps/agent/.data                the agent's file store (chats, runs)
//     seed-data/.annotations          the Vite dev annotation store (or <envPrefix>WEB_ANNOTATIONS_DIR)
//   node tools/dev-reset.mjs --yes    no question (scripts, CI)
//   node tools/dev-reset.mjs --dry-run  print what would go, remove nothing
//
// Never touches secrets/ or the seed-data samples. Every path must resolve inside the repo, and
// none may be the repo itself, secrets/ or seed-data/; anything else is refused before removing.
// <envPrefix>DEV_RESET_ROOT points the script at another root (the unit test uses a temp dir).
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const scriptRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = JSON.parse(readFileSync(join(scriptRepo, "schemas/naming.json"), "utf8")).envPrefix;

/** The folders `dev:reset` removes, resolved against `root`. Throws on any path it must not touch. */
export function targets(root, env = process.env) {
  const repo = realpathSync(root);
  const annotations = env[`${P}WEB_ANNOTATIONS_DIR`] || "seed-data/.annotations";
  const list = ["apps/api/.data", "apps/agent/.data", annotations].map((p) => (isAbsolute(p) ? p : join(repo, p)));
  const forbidden = [repo, join(repo, "secrets"), join(repo, "seed-data"), join(repo, "apps"), join(repo, ".git")];
  return list.map((p) => {
    // Resolve symlinks of the part that exists, so a link can't lead outside the repo.
    let abs = resolve(p);
    if (existsSync(abs)) abs = realpathSync(abs);
    const rel = relative(repo, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`refusing ${p}: it resolves outside the repo (${repo})`);
    if (forbidden.includes(abs) || rel.split(sep)[0] === "secrets") throw new Error(`refusing ${p}: dev:reset never removes ${rel || "the repo"}`);
    return abs;
  });
}

async function main(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const dry = argv.includes("--dry-run");
  const root = process.env[`${P}DEV_RESET_ROOT`] || scriptRepo;
  let paths;
  try {
    paths = targets(root);
  } catch (e) {
    console.error(`dev:reset: ${e.message}`);
    return 2;
  }
  const present = paths.filter((p) => existsSync(p));
  const show = (p) => relative(realpathSync(root), p) || p;
  if (!present.length) {
    console.log("dev:reset: nothing to remove (no dev data yet)");
    return 0;
  }
  console.log("dev:reset removes the local dev data (secrets/ and seed-data samples stay):");
  for (const p of present) console.log(`  ${show(p)}`);
  if (dry) return 0;
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("dev:reset: not a terminal; pass --yes to confirm");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Stop pnpm dev first. Remove these? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("dev:reset: nothing removed");
      return 1;
    }
  }
  for (const p of present) {
    rmSync(p, { recursive: true, force: true });
    console.log(`removed ${show(p)}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
