/**
 * End to end: pi + a real model + a real Daytona sandbox, through the same SessionRegistry the HTTP
 * service uses. Needs the model key (e.g. OPENAI_API_KEY) and DAYTONA_API_KEY. Always deletes the sandbox.
 */
import { createModelRuntime } from "../src/agent/models.ts";
import { describeSecrets, loadConfig } from "../src/config.ts";
import type { AgentEvent } from "../src/protocol.ts";
import { createDaytona } from "../src/sandbox/client.ts";
import { SandboxManager } from "../src/sandbox/manager.ts";
import { SessionRegistry } from "../src/runtime/sessions.ts";
import { loadDevSecrets } from "../src/secrets.ts";

process.env.APP_ENV ??= "test";
loadDevSecrets();
const { config } = loadConfig();
console.log(`model=${config.model.provider}:${config.model.id} ${describeSecrets(config)}`);
const daytona = createDaytona(config);
if (!daytona) throw new Error("DAYTONA_API_KEY missing");

const sandboxes = new SandboxManager(daytona, config, { warn: (m) => console.warn(`[sandbox] ${m}`) });
const registry = new SessionRegistry({ config, runtime: await createModelRuntime(config), sandboxes });
const session = await registry.create({ projectId: "smoke", profile: "coder" }, "smoke");

const events: AgentEvent[] = [];
let text = "";
try {
  const { run } = await registry.send(
    session,
    "In the sandbox, create hello.py that prints 'inkling-ok', run it with bash, and report exactly what it printed.",
  );
  await new Promise<void>((resolve) => {
    for (const e of run.events.after(0)) events.push(e);
    const off = run.events.subscribe((e) => {
      events.push(e);
      if (e.type === "text") text += e.delta;
      if (e.type === "tool-call") console.log(`  tool  ${e.title}`);
      if (e.type === "sandbox") console.log(`  sandbox ${e.state}`);
      if (e.type === "error") console.log(`  error ${e.message}`);
      if (e.type === "done") {
        off();
        resolve();
      }
    });
  });
  const usage = events.filter((e) => e.type === "usage");
  const cost = usage.reduce((n, e) => n + (e.type === "usage" ? e.costUsd : 0), 0);
  const tokens = usage.reduce((n, e) => n + (e.type === "usage" ? e.inputTokens + e.outputTokens : 0), 0);
  const done = events.find((e) => e.type === "done");
  console.log(`\n${text.trim()}\n`);
  console.log(`status=${done?.type === "done" ? done.status : "?"} events=${events.length} tokens=${tokens} cost=$${cost.toFixed(4)}`);

  const checks = {
    completed: done?.type === "done" && done.status === "completed",
    sandboxReady: events.some((e) => e.type === "sandbox" && e.state === "ready"),
    usedSandboxTool: events.some((e) => e.type === "tool-call" && ["bash", "write", "run_python"].includes(e.name)),
    reportedOutput: text.includes("inkling-ok"),
  };
  console.log(checks);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} finally {
  await registry.delete(session.id);
  console.log("sandbox deleted");
}
