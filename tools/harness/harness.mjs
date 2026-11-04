#!/usr/bin/env node
// todo23 W5/W10, local harness mode: run the verification checks on this machine, without
// Daytona, against one environment, the caller's plugins and fixtures, and hidden acceptance tests.
//
//   pnpm harness --env <file> [--plugins <dir>] [--fixtures <dir>] [--hidden-tests <dir>]
//                [--port <n>] [--out <dir>] [--report <file>] [--keep]
//
// The fixtures and hidden tests are copied into a temp folder and made read-only (D4): the caller's
// code can read them through the Studio, never change them. A frozen Vite server (E2E mode, its
// seeds from that temp folder) serves one Studio for the project `harness`; the checks run in
// order and the report has a fixed schema:
//
//   { version: 1, passed, env, port, out, steps: [{ name, status: "pass"|"fail"|"skip", blocking, details }] }
//
// `passed` is true when no blocking step failed. Exit code 0 when passed, 1 otherwise, 2 on bad usage.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NAMING = JSON.parse(fs.readFileSync(path.join(REPO, "schemas/naming.json"), "utf8"));
const PROJECT = "harness";
const PORTS = [5320, 5329];
const DRIVE = path.join(REPO, "tools/harness/drive.py");
const PY = ["run", "--no-project", "--with", "playwright", "python"];

export const STEP_NAMES = ["resolver-lint", "plugin-tests", "hidden-tests", "interaction-smoke", "accessibility", "screenshots", "viewer-lint", "token-lint", "design-judge"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "keep") out.keep = true;
    else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (!out.env) throw new Error("--env <file> is required");
  return out;
}

const freePort = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

async function pickPort(want) {
  if (want) return Number(want);
  for (let p = PORTS[0]; p <= PORTS[1]; p++) if (await freePort(p)) return p;
  throw new Error(`no free port in ${PORTS[0]}–${PORTS[1]}`);
}

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        if (d.name === "node_modules" || d.name.startsWith(".")) return [];
        const p = path.join(dir, d.name);
        return d.isDirectory() ? walk(p) : [p];
      })
    : [];

/** Read-only for everyone (D4): files 0444, folders 0555. */
function lockDown(dir) {
  for (const f of walk(dir)) fs.chmodSync(f, 0o444);
  const dirs = [dir];
  for (let i = 0; i < dirs.length; i++) for (const d of fs.readdirSync(dirs[i], { withFileTypes: true })) if (d.isDirectory()) dirs.push(path.join(dirs[i], d.name));
  for (const d of dirs.reverse()) fs.chmodSync(d, 0o555);
}

function unlock(dir) {
  if (!fs.existsSync(dir)) return;
  fs.chmodSync(dir, 0o755);
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) unlock(p);
    else fs.chmodSync(p, 0o644);
  }
}

/** A preset file ({id, title, spec}) or a bare environment. */
function readEnv(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return doc && typeof doc.spec === "object" && !doc.data && !doc.extends ? doc.spec : doc;
}

function seedFolder(tmp, env, fixtures) {
  const seed = path.join(tmp, "seed");
  const files = path.join(seed, PROJECT);
  fs.mkdirSync(files, { recursive: true });
  if (fixtures) fs.cpSync(fixtures, files, { recursive: true });
  const assets = walk(files).map((f) => ({ path: path.relative(seed, f).split(path.sep).join("/"), bytes: fs.statSync(f).size }));
  const project = { id: PROJECT, title: "Harness", task: env.task ?? "classification", source: `local:${PROJECT}`, license: "test", status: "available", environment: env, assets };
  fs.writeFileSync(path.join(seed, "manifest.json"), JSON.stringify({ projects: [project] }, null, 2));
  lockDown(seed);
  return { seed, assets: assets.length };
}

function startVite(port, seed) {
  const env = { ...process.env, [`${NAMING.envPrefix}E2E`]: "1", [`${NAMING.envPrefix}WEB_SEED_DIR`]: seed };
  delete env[`${NAMING.envPrefix}API_URL`]; // the harness's Studio is self-contained
  const child = spawn("pnpm", ["exec", "vite", "--port", String(port), "--strictPort"], { cwd: path.join(REPO, "apps/web"), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, log: () => log.slice(-4000) };
}

let live; // the running Vite, stopped on a signal too

function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}

async function waitUp(port, vite, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (vite.child.exitCode !== null) throw new Error(`vite exited: ${vite.log()}`);
    try {
      const r = await fetch(`http://localhost:${port}/seed/manifest.json`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`vite didn't answer on ${port} in ${timeoutMs / 1000} s`);
}

const tail = (s, n = 3000) => (s && s.length > n ? `…${s.slice(-n)}` : s ?? "");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 300_000, cwd: opts.cwd ?? REPO, env: { ...process.env, ...(opts.env ?? {}) } });
  return { code: r.status ?? (r.error ? -1 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
}

// ---- Steps ---------------------------------------------------------------------------------

async function resolverLint(port, env) {
  const r = await fetch(`http://localhost:${port}/api/environments/validate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(env) });
  const body = await r.json().catch(() => ({}));
  const ok = r.ok && body.ok !== false && !(body.errors ?? []).length;
  return { status: ok ? "pass" : "fail", details: { httpStatus: r.status, errors: body.errors ?? [], warnings: body.warnings ?? [] } };
}

function pluginDirs(plugins) {
  if (!plugins || !fs.existsSync(plugins)) return [];
  const own = fs.existsSync(path.join(plugins, "ui")) || fs.existsSync(path.join(plugins, "package.json"));
  return own ? [plugins] : fs.readdirSync(plugins, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => path.join(plugins, d.name));
}

function pluginTests(plugins) {
  const dirs = pluginDirs(plugins);
  if (!dirs.length) return { status: "skip", details: { reason: "no --plugins" } };
  const results = [];
  for (const dir of dirs) {
    const tests = walk(dir).filter((f) => /\.test\.tsx?$/.test(f));
    const pkg = fs.existsSync(path.join(dir, "package.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) : {};
    if (pkg.scripts?.test) {
      const r = run("pnpm", ["--dir", dir, "test"]);
      results.push({ plugin: path.basename(dir), runner: "package test", code: r.code, output: tail(r.stdout + r.stderr, 1500) });
    } else if (tests.length && path.resolve(dir).startsWith(path.join(REPO, "plugins") + path.sep)) {
      // First-party plugin tests run in apps/web's vitest (its include covers plugins/*/ui).
      const r = run("pnpm", ["exec", "vitest", "run", ...tests.map((t) => path.relative(path.join(REPO, "apps/web"), t))], { cwd: path.join(REPO, "apps/web") });
      results.push({ plugin: path.basename(dir), runner: "vitest", tests: tests.length, code: r.code, output: tail(r.stdout + r.stderr, 1500) });
    } else results.push({ plugin: path.basename(dir), runner: "none", code: null });
  }
  const ran = results.filter((r) => r.code !== null);
  if (!ran.length) return { status: "skip", details: { reason: "the plugins have no tests", results } };
  return { status: ran.every((r) => r.code === 0) ? "pass" : "fail", details: { results } };
}

function hiddenTests(hidden, port) {
  if (!hidden) return { status: "skip", details: { reason: "no --hidden-tests" } };
  const files = walk(hidden).filter((f) => f.endsWith(".py") && !path.basename(f).startsWith("_"));
  if (!files.length) return { status: "skip", details: { reason: "no python tests in the hidden folder" } };
  const results = files.map((f) => {
    const r = run("uv", [...PY, f, "--port", String(port)], { env: { [`${NAMING.envPrefix}HARNESS_PROJECT`]: PROJECT } });
    return { test: path.basename(f), code: r.code, output: tail(r.stdout + r.stderr, 1500) };
  });
  return { status: results.every((r) => r.code === 0) ? "pass" : "fail", details: { results } };
}

function drive(step, port, out) {
  const r = run("uv", [...PY, DRIVE, step, "--port", String(port), "--project", PROJECT, "--out", out], { timeoutMs: 400_000 });
  const line = r.stdout.trim().split("\n").pop();
  try {
    return JSON.parse(line);
  } catch {
    return { status: "fail", details: { error: `driver failed (exit ${r.code})`, output: tail(r.stdout + r.stderr) } };
  }
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const uiFiles = (plugins) => pluginDirs(plugins).flatMap((d) => walk(fs.existsSync(path.join(d, "ui")) ? path.join(d, "ui") : d)).filter((f) => SOURCE.test(f) && !/\.test\./.test(f));

function grepLint(files, rules) {
  const findings = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const [rule, re] of rules) if (re.test(line)) findings.push({ file: path.relative(REPO, f), line: i + 1, rule, text: line.trim().slice(0, 160) });
    });
  }
  return findings;
}

/** Another workstream's `viewer-lint`, when it exists; else the built-in checks below. */
function externalViewerLint() {
  for (const p of ["tools/viewer-lint/index.mjs", "tools/viewer-lint.mjs", "packages/viewer-lint/src/cli.ts", "packages/viewer-lint/bin/viewer-lint.mjs"]) if (fs.existsSync(path.join(REPO, p))) return path.join(REPO, p);
  return null;
}

function viewerLint(plugins) {
  const files = uiFiles(plugins);
  if (!files.length) return { status: "skip", details: { reason: "no plugin UI files" } };
  const ext = externalViewerLint();
  if (ext) {
    const r = run(ext.endsWith(".ts") ? "pnpm" : "node", ext.endsWith(".ts") ? ["exec", "tsx", ext, ...pluginDirs(plugins)] : [ext, ...pluginDirs(plugins)]);
    return { status: r.code === 0 ? "pass" : "fail", details: { linter: path.relative(REPO, ext), output: tail(r.stdout + r.stderr) } };
  }
  const findings = grepLint(files, [
    ["no-fetch", /(^|[^.\w])fetch\s*\((?!\s*assetUrl\()/], // asset bytes go through assetUrl()
    ["no-eval", /(^|[^.\w])eval\s*\(/],
    ["no-new-function", /new\s+Function\s*\(/],
    ["no-xhr", /XMLHttpRequest|WebSocket\s*\(/],
  ]);
  return { status: findings.length ? "fail" : "pass", details: { linter: "built-in (grep)", files: files.length, findings: findings.slice(0, 50) } };
}

function tokenLint(plugins) {
  const files = uiFiles(plugins);
  if (!files.length) return { status: "skip", details: { reason: "no plugin UI files" } };
  const findings = grepLint(files, [
    ["raw-hex-colour", /["'`]#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?["'`\s;]/],
    ["raw-rgb-colour", /["'`]rgba?\(\s*\d/],
  ]);
  return { status: findings.length ? "fail" : "pass", details: { linter: "built-in (grep): colours must be theme tokens", files: files.length, findings: findings.slice(0, 50) } };
}

// ---- Run -----------------------------------------------------------------------------------

export async function runHarness(opts) {
  const envFile = path.resolve(opts.env);
  const env = readEnv(envFile);
  const port = await pickPort(opts.port);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${NAMING.resourcePrefix}-harness-`));
  const out = path.resolve(opts.out ?? fs.mkdtempSync(path.join(os.tmpdir(), `${NAMING.resourcePrefix}-harness-out-`)));
  fs.mkdirSync(out, { recursive: true });
  const steps = [];
  const add = (name, blocking, r) => steps.push({ name, status: r.status, blocking, details: r.details ?? {} });
  let vite;
  try {
    const { seed, assets } = seedFolder(tmp, env, opts.fixtures && path.resolve(opts.fixtures));
    let hidden;
    if (opts.hiddenTests) {
      hidden = path.join(tmp, "hidden");
      fs.cpSync(path.resolve(opts.hiddenTests), hidden, { recursive: true });
      lockDown(hidden);
    }
    vite = live = startVite(port, seed);
    await waitUp(port, vite);
    add("resolver-lint", true, await resolverLint(port, env));
    add("plugin-tests", true, pluginTests(opts.plugins && path.resolve(opts.plugins)));
    add("hidden-tests", true, hiddenTests(hidden, port));
    const smoke = drive("smoke", port, out);
    add("interaction-smoke", true, { ...smoke, details: { assets, ...smoke.details } });
    add("accessibility", false, drive("a11y", port, out));
    add("screenshots", false, drive("screenshots", port, out));
    add("viewer-lint", true, viewerLint(opts.plugins && path.resolve(opts.plugins)));
    add("token-lint", false, tokenLint(opts.plugins && path.resolve(opts.plugins)));
    add("design-judge", false, { status: "skip", details: { reason: "advisory; not implemented in local mode" } });
  } catch (e) {
    add("harness", true, { status: "fail", details: { error: String(e instanceof Error ? e.message : e).slice(0, 4000) } });
  } finally {
    stop(vite?.child);
    if (!opts.keep) {
      unlock(tmp);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const done = new Set(steps.map((s) => s.name));
  for (const name of STEP_NAMES) if (!done.has(name)) steps.push({ name, status: "skip", blocking: false, details: { reason: "not reached" } });
  const passed = steps.every((s) => !s.blocking || s.status !== "fail");
  return { version: 1, passed, env: envFile, port, out, steps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`harness: ${e.message}\nusage: pnpm harness --env <file> [--plugins <dir>] [--fixtures <dir>] [--hidden-tests <dir>] [--port <n>] [--out <dir>] [--report <file>] [--keep]\n`);
    process.exit(2);
  }
  const stopAll = () => {
    stop(live?.child);
    process.exit(130);
  };
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
  const report = await runHarness(opts);
  const text = JSON.stringify(report, null, 2);
  if (opts.report) fs.writeFileSync(opts.report, text);
  process.stdout.write(`${text}\n`);
  process.exit(report.passed ? 0 : 1);
}
