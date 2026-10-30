/**
 * Live agent smoke test (todo1 §8.3): a real model plus a real Daytona sandbox, end to end through
 * the HTTP API in-process. Needs a model key (OPENAI_API_KEY or ANTHROPIC_API_KEY for AGENT_MODEL)
 * and DAYTONA_API_KEY. The sandbox is always deleted.
 *
 *   pnpm --filter @studio/agent smoke
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "../src/agent/models.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import type { AgentEvent } from "../src/protocol.ts";
import { SessionService } from "../src/runtime/sessions.ts";
import { createDaytona } from "../src/sandbox/client.ts";
import { loadDevSecrets } from "../src/secrets.ts";

process.env.APP_ENV ??= "test";
loadDevSecrets();
const token = "smoke-token-0123456789abcdef";
const dataDir = mkdtempSync(join(tmpdir(), "inkling-smoke-"));
const { config } = loadConfig({ ...process.env, INTERNAL_AGENT_SERVICE_TOKEN: token, AGENT_DATA_DIR: dataDir, AGENT_MAX_SPEND_USD: "0.50" });
const daytona = createDaytona(config);
if (!daytona || !config.providerKeys[config.model.provider]) {
  console.error(`smoke needs DAYTONA_API_KEY and a ${config.model.provider} key; skipping.`);
  process.exit(2);
}
const log = createLogger(process.env.LOG_LEVEL ?? "warn");
const sessions = new SessionService({ config, runtime: await createModelRuntime(config), log, daytona });
const app = createApp({ config, sessions, log });
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const { sessionId } = (await (await call("POST", "/v1/sessions", { projectId: "smoke", profile: "coder" })).json()) as { sessionId: string };
const t0 = Date.now();
try {
  const { runId } = (await (
    await call("POST", `/v1/sessions/${sessionId}/messages`, { text: "In the sandbox, create hello.py printing 'inkling-ok', run it, and report stdout." })
  ).json()) as { runId: string };
  const res = await call("GET", `/v1/runs/${runId}/events`);
  const events: AgentEvent[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const data = buf.slice(0, cut).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      buf = buf.slice(cut + 2);
      if (!data) continue;
      const e = JSON.parse(data) as AgentEvent;
      events.push(e);
      if (e.type === "tool-call") console.log(`  · ${e.title}`);
      if (e.type === "sandbox") console.log(`  · sandbox ${e.state}`);
      if (e.type === "done") break outer;
    }
  }
  const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
  const usage = events.filter((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage");
  console.log(`\nassistant: ${text.trim().slice(0, 400)}\n`);
  check("run completed", events.at(-1)?.type === "done" && (events.at(-1) as any).status === "completed", String((events.at(-1) as any)?.status));
  check("final text contains inkling-ok", text.includes("inkling-ok"));
  check("sandbox became ready", events.some((e) => e.type === "sandbox" && (e.state === "ready" || e.state === "resumed")));
  check("used bash or write", events.some((e) => e.type === "tool-call" && (e.name === "bash" || e.name === "write" || e.name === "run_python")));
  const tokensIn = usage.reduce((n, u) => n + u.inputTokens, 0);
  const tokensOut = usage.reduce((n, u) => n + u.outputTokens, 0);
  const cost = usage.reduce((n, u) => n + u.costUsd, 0);
  console.log(`model ${config.model.provider}:${config.model.id} · ${tokensIn} in / ${tokensOut} out · $${cost.toFixed(4)} · ${Math.round((Date.now() - t0) / 1000)}s`);
} finally {
  const del = await call("DELETE", `/v1/sessions/${sessionId}`);
  check("session and sandbox deleted", del.status === 204);
  await sessions.shutdown();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
