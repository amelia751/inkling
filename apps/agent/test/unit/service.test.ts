import { Writable } from "node:stream";
import {
  continueTrace,
  createServiceLogger,
  installFetchPropagation,
  parseTraceparent,
  requestIdFrom,
  runWithContext,
  sameOriginAs,
} from "@studio/observability-ts";
import { afterEach, describe, expect, it } from "vitest";
import { INTERRUPTED_MESSAGE } from "../../src/cluster/coordinator.ts";
import { ConfigError, envName, loadConfig, withPrefix } from "../../src/config.ts";
import type { AgentEvent } from "@studio/agent-protocol";
import { ENV_TOOLS, harness, snapshot } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const FIXTURE = {
  scripts: [
    { when: "wait", turns: [{ toolCalls: [{ name: "get_environment" }] }, { text: "never" }] },
    { when: "overview", turns: [{ toolCalls: [{ name: "dataset_overview" }] }, { text: "done" }] },
  ],
};

async function session(hh: H) {
  const res = await hh.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS });
  return res.body.sessionId as string;
}

describe("service conventions", () => {
  it("/healthz, /readyz and /version are open; requests carry X-Request-Id", async () => {
    h = await harness(FIXTURE, { GIT_SHA: "abc1234" });
    expect((await h.app.request("/healthz")).status).toBe(200);
    const ready = await h.app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, checks: { draining: { ok: true }, store: { ok: true, detail: "file" } } });
    const version = await h.app.request("/version");
    expect(await version.json()).toEqual({ service: "agent", version: "0.1.0", gitSha: "abc1234" });
    const echoed = await h.app.request("/healthz", { headers: { "x-request-id": "req-42" } });
    expect(echoed.headers.get("x-request-id")).toBe("req-42");
    const minted = await h.app.request("/healthz", { headers: { "x-request-id": "bad id with spaces" } });
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("config errors name the keys, never the values", () => {
    const fail = (env: Record<string, string>) => {
      try {
        loadConfig(withPrefix({ ENV: "test", AGENT_MODEL: "scripted", ...env }));
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as Error).message;
      }
      throw new Error("expected a ConfigError");
    };
    expect(fail({ AGENT_STORE: "postgres", AGENT_EVENT_BUS: "redis" })).toBe(`missing required settings: ${envName("AGENT_DATABASE_URL")}, ${envName("AGENT_REDIS_URL")}`);
    const msg = fail({ AGENT_EVENT_BUS: "kafka-sk-supersecretvalue", AGENT_PORT: "sk-another-secret" });
    expect(msg).toContain("AGENT_EVENT_BUS");
    expect(msg).toContain("AGENT_PORT");
    expect(msg).not.toContain("supersecret");
    expect(msg).not.toContain("another-secret");
    const { config } = loadConfig(withPrefix({ ENV: "test", AGENT_MODEL: "scripted", AGENT_SWEEPER_ENABLED: "false", AGENT_HOST: "0.0.0.0" }));
    expect(config.sweeperEnabled).toBe(false);
    expect(config.host).toBe("0.0.0.0");
    expect(loadConfig(withPrefix({ ENV: "test", AGENT_MODEL: "scripted" })).config.sweeperEnabled).toBe(true);
  });
});

describe("graceful shutdown", () => {
  it("drain: readyz fails at once, new runs get 503, in-flight runs past the grace end interrupted", async () => {
    h = await harness(FIXTURE, { AGENT_CLIENT_TOOL_TIMEOUT_S: "60" });
    const sid = await session(h);
    const runId = (await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "wait" })).body.runId as string;
    const head = await h.drive(runId, () => {}, 0, (e) => e.type === "client-tool");
    const draining = h.sessions.drain(300);
    expect((await h.app.request("/readyz")).status).toBe(503);
    const other = await session(h);
    expect((await h.json("POST", `/v1/sessions/${other}/messages`, { text: "overview", snapshot: snapshot() })).status).toBe(503);
    expect(await draining).toBe(1);
    const tail = await h.drive(runId, () => {}, head.at(-1)!.seq);
    expect(tail.filter((e) => e.type === "error" || e.type === "done").map((e) => (e.type === "error" ? e.message : e.status))).toEqual([INTERRUPTED_MESSAGE, "failed"]);
    expect((await h.sessions.store.getRun(runId))?.status).toBe("interrupted");
    // The answer can no longer be posted.
    const call = head.find((e): e is Extract<AgentEvent, { type: "client-tool" }> => e.type === "client-tool")!;
    expect((await h.json("POST", `/v1/runs/${runId}/client-tools/${call.callId}`, { ok: true, output: {} })).status).toBe(409);
  });

  it("drain lets runs that finish within the grace period complete", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    const runId = (await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "overview", snapshot: snapshot() })).body.runId as string;
    expect(await h.sessions.drain(5000)).toBe(0);
    expect((await h.drive(runId)).at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect((await h.sessions.store.getRun(runId))?.status).toBe("completed");
  });
});

describe("observability", () => {
  const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("parses W3C traceparent and rejects malformed ones", () => {
    expect(parseTraceparent(TP)).toEqual({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
    const t = continueTrace(TP);
    expect(t.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(t.parentSpanId).toBe("00f067aa0ba902b7");
    expect(continueTrace(undefined).traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(requestIdFrom("ok-1")).toBe("ok-1");
  });

  it("log lines carry service, version, request_id and trace_id, with secrets redacted", () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createServiceLogger({ service: "agent", version: "1.2.3", redact: ["apiKey"], destination: dest });
    runWithContext({ requestId: "req-1", trace: continueTrace(TP) }, () => log.info({ apiKey: "sk-123" }, "hello"));
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ service: "agent", version: "1.2.3", level: "info", request_id: "req-1", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", apiKey: "[redacted]", msg: "hello" });
  });

  it("outgoing fetches to internal services carry traceparent and x-request-id; others don't", async () => {
    const seen: Record<string, string | null>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), traceparent: headers.get("traceparent"), requestId: headers.get("x-request-id") });
      return new Response("ok");
    }) as typeof fetch;
    const uninstall = installFetchPropagation(sameOriginAs(["http://api.internal:8000/base", undefined, "not a url"]));
    try {
      await runWithContext({ requestId: "req-9", trace: continueTrace(TP) }, async () => {
        await fetch("http://api.internal:8000/v1/things");
        await fetch("https://api.openai.com/v1/x");
      });
      await fetch("http://api.internal:8000/v1/outside");
    } finally {
      uninstall();
      globalThis.fetch = original;
    }
    expect(seen[0]!.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(seen[0]!.traceparent).not.toContain("00f067aa0ba902b7");
    expect(seen[0]!.requestId).toBe("req-9");
    expect(seen[1]).toMatchObject({ traceparent: null, requestId: null });
    expect(seen[2]).toMatchObject({ traceparent: null, requestId: null });
  });
});
