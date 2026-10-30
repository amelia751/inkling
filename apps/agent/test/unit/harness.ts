import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createModelRuntime, registerScriptedProvider, type ScriptFixture } from "../../src/agent/models.ts";
import { createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import type { AgentEvent, ClientToolSpec, DatasetSnapshot } from "../../src/protocol.ts";
import { SessionService } from "../../src/runtime/sessions.ts";

export const TOKEN = "test-service-token-0123456789";

/** A real pi runtime + session service + HTTP app on a scripted model; no network. */
export async function harness(fixture: ScriptFixture, env: Record<string, string> = {}, extraTools: ToolDefinition<any, any, any>[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "inkling-agent-"));
  const { config } = loadConfig({
    APP_ENV: "test",
    AGENT_MODEL: "scripted",
    AGENT_DATA_DIR: dir,
    INTERNAL_AGENT_SERVICE_TOKEN: TOKEN,
    AGENT_STUDIO_URL: "http://127.0.0.1:9",
    ...env,
  });
  const runtime = await createModelRuntime(config);
  registerScriptedProvider(runtime, fixture);
  const log = createLogger("silent");
  const sessions = new SessionService({ config, runtime, log, extraTools });
  const app = createApp({ config, sessions, log });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  /** Read a run's SSE stream, letting `onEvent` answer client tools/approvals, until `done`. */
  async function drive(runId: string, onEvent: (e: AgentEvent) => void | Promise<void> = () => {}, after = 0, until?: (e: AgentEvent) => boolean) {
    const res = await call("GET", `/v1/runs/${runId}/events?after=${after}`);
    if (res.status !== 200 || !res.body) throw new Error(`events ${res.status}`);
    const events: AgentEvent[] = [];
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return events;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const e = JSON.parse(data) as AgentEvent;
          events.push(e);
          await onEvent(e);
          if (e.type === "done" || until?.(e)) return events;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return {
    dir,
    config,
    runtime,
    sessions,
    app,
    call,
    json,
    drive,
    cleanup: async () => {
      await sessions.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const ENV_TOOLS: ClientToolSpec[] = [
  { name: "get_environment", description: "The current environment.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "patch_environment",
    description: "Edit the running environment with a JSON Patch.",
    input_schema: { type: "object", properties: { patch: { type: "array" }, summary: { type: "string" } }, required: ["patch", "summary"] },
    title: "Editing environment",
  },
  { name: "run_command", description: "Run a Studio command.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "show_items", description: "Show a clickable list of items.", input_schema: { type: "object", properties: { title: { type: "string" }, itemIds: { type: "array", items: { type: "string" } } } } },
];

export function snapshot(projectId = "demo", extra: Partial<DatasetSnapshot> = {}): DatasetSnapshot {
  return {
    project: { id: projectId, title: "Demo", viewer: "image-2d", task: "classification", labels: ["normal", "pneumonia"], license: "CC BY 4.0", source: "test", restricted: false },
    items: [
      { id: "a.jpeg", name: "a.jpeg", group: "normal", sourceLabel: "normal", assets: ["demo/normal/a.jpeg"] },
      { id: "b.jpeg", name: "b.jpeg", group: "pneumonia", sourceLabel: "pneumonia" },
    ],
    annotations: [{ id: "n1", itemId: "a.jpeg", label: "pneumonia", type: "class", provenance: "ai-suggested", summary: "Class" }],
    selectedIds: [],
    tools: ["select", "box"],
    unsavedChanges: false,
    ...extra,
  };
}
