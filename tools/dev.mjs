#!/usr/bin/env node
// `pnpm dev` and `pnpm dev:signin` (todo15 D6, D8): web, api, agent and worker through Turborepo.
//
//   node tools/dev.mjs            dev auth (trusted dev headers, the dev principal)
//   node tools/dev.mjs --signin   api, web and agent in AUTH_MODE=workos with secrets/workos.env
//
// Model (D6): <envPrefix>AGENT_MODEL from the shell or a secrets/*.env file; else the agent's default
// when a provider key is set, else `scripted`. Nothing here prints a value:
// only key names. A variable already exported in the shell always wins.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repo = new URL("..", import.meta.url).pathname;
const P = JSON.parse(readFileSync(join(repo, "schemas/naming.json"), "utf8")).envPrefix;
const SECRETS = join(repo, "secrets");
const signin = process.argv.includes("--signin");
const extra = process.argv.slice(2).filter((a) => a !== "--signin");

/** `KEY=VALUE` lines; `#` comments, `export ` and quotes allowed (as apps/agent/src/secrets.ts). */
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const q = /^(['"])(.*)\1$/.exec(m[2]);
    const v = q ? q[2] : m[2].replace(/\s+#.*$/, "");
    if (v !== "") out[m[1]] = v;
  }
  return out;
}

const files = existsSync(SECRETS) ? readdirSync(SECRETS).filter((f) => f.endsWith(".env")).sort() : [];
const fromFiles = Object.assign({}, ...files.map((f) => parseEnvFile(join(SECRETS, f))));
const env = { ...process.env };
const set = (key, value) => {
  if (value !== undefined && (env[key] === undefined || env[key] === "")) env[key] = value;
};
const notes = [];

// ---- Model (D6) ----------------------------------------------------------------------------------
const providerKey = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].some((k) => env[k] || fromFiles[k]);
if (!env[`${P}AGENT_MODEL`] && !fromFiles[`${P}AGENT_MODEL`]) {
  // A provider key in the shell or secrets/: the agent's own default model, as before todo15.
  // No key at all: scripted, so the assistant still answers (free, canned).
  if (providerKey) notes.push("model: the agent's default (a provider key is set)");
  else {
    set(`${P}AGENT_MODEL`, "scripted");
    notes.push(`model: scripted (no provider key; set one in secrets/models.env for a real model)`);
  }
} else {
  const model = env[`${P}AGENT_MODEL`] || fromFiles[`${P}AGENT_MODEL`];
  notes.push(`model: ${model}`);
}

// ---- The web talks to the api this script starts (not the seed server) -------------------------
set(`${P}API_URL`, "http://127.0.0.1:8000");

// ---- Sign-in (D8) --------------------------------------------------------------------------------
if (signin) {
  const workos = join(SECRETS, "workos.env");
  if (!existsSync(workos)) {
    console.error("dev:signin needs secrets/workos.env (copy secrets/workos.env.example; docs/running.md, \"Sign in locally\")");
    process.exit(1);
  }
  const w = parseEnvFile(workos);
  // Vite reads only its process env: hand it (and the api and agent) the file's keys.
  for (const [k, v] of Object.entries(w)) set(k, v);
  const web = (env[`${P}API_PUBLIC_URL`] || "http://localhost:5173").replace(/\/$/, "");
  set(`${P}API_AUTH_MODE`, "workos");
  set(`${P}API_DEV_TRUST_HEADERS`, "0");
  set(`${P}API_WORKOS_REDIRECT_URI`, `${web}/api/auth/callback`);
  set(`${P}API_PUBLIC_URL`, web);
  set(`${P}API_URL`, "http://localhost:8000");
  set(`${P}WEB_AUTH_MODE`, "workos");
  set(`${P}AGENT_AUTH_MODE`, "workos");
  // The agent verifies the same AuthKit tokens as the api: default its settings to the api's.
  set(`${P}AGENT_WORKOS_CLIENT_ID`, env[`${P}API_WORKOS_CLIENT_ID`]);
  set(`${P}AGENT_WORKOS_ISSUER`, env[`${P}API_WORKOS_ISSUER`]);
  set(`${P}AGENT_WORKOS_BASE_URL`, env[`${P}API_WORKOS_BASE_URL`]?.replace(/\/$/, ""));
  const need = ["API_WORKOS_API_KEY", "API_WORKOS_CLIENT_ID", "API_WORKOS_COOKIE_PASSWORD"].map((k) => P + k).filter((k) => !env[k]);
  if (need.length) {
    console.error(`dev:signin: secrets/workos.env is missing ${need.join(", ")}`);
    process.exit(1);
  }
  notes.push(`auth: workos (${env[`${P}API_WORKOS_BASE_URL`] ? "base URL from secrets/workos.env" : "WorkOS staging"}), sign in at ${web}`);
} else {
  notes.push("auth: dev (trusted dev headers)");
}

console.log(`[dev] ${notes.join("; ")}`);
const args = ["turbo", "run", "dev", "--env-mode=loose", ...["web", "api", "agent", "worker"].map((a) => `--filter=@studio/${a}`), ...extra];
const child = spawn("pnpm", ["exec", ...args], { cwd: repo, env, stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
