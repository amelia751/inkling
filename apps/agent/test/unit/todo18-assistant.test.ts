import { afterEach, describe, expect, it } from "vitest";
import { NAMING } from "@studio/contracts/naming";
import type { AgentEvent } from "@studio/agent-protocol";
import { ENV_TOOLS, harness } from "./harness.ts";

// Scripted model only (AGENTS.md): no real-model runs.
type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const FIXTURE = {
  scripts: [
    { when: "wait", turns: [{ toolCalls: [{ name: "get_environment" }] }, { text: "ok" }] },
    { when: "run beats", turns: [{ toolCalls: [{ name: "run_command", arguments: { id: `${NAMING.namespace}.timeseries.commands.detectBeats` } }] }, { text: "done" }] },
  ],
};

async function start(hh: H, text: string) {
  const sid = (await hh.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS })).body.sessionId as string;
  const res = await hh.json("POST", `/v1/sessions/${sid}/messages`, { text });
  expect(res.status).toBe(202);
  return res.body.runId as string;
}

describe("todo18 D assistant (scripted model)", () => {
  for (const [what, error] of [
    ["panel closed", "The Studio isn't open, so this tool can't run."],
    ["stop during a browser tool", "Stopped by the person."],
  ] as const) {
    it(`${what}: the browser's immediate failure ends the tool at once, not at the timeout`, async () => {
      h = await harness(FIXTURE, { AGENT_CLIENT_TOOL_TIMEOUT_S: "60" });
      const runId = await start(h, "wait");
      const t0 = Date.now();
      const events: AgentEvent[] = await h.drive(runId, async (e) => {
        if (e.type === "client-tool") expect((await h!.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, { ok: false, output: { error } })).status).toBe(200);
      });
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(events.find((e) => e.type === "tool-result")).toMatchObject({ ok: false });
      expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    });
  }

  it("an expired approval can't be approved afterwards", async () => {
    h = await harness(FIXTURE, { AGENT_APPROVAL_TIMEOUT_S: "1" });
    const runId = await start(h, "run beats");
    let approvalId = "";
    const events = await h.drive(runId, (e) => {
      if (e.type === "approval") approvalId = e.approvalId;
    });
    expect(approvalId).not.toBe("");
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ ok: false });
    // The web keeps the card pending until this POST succeeds; a 404 marks it expired.
    expect((await h.json("POST", `/v1/approvals/${approvalId}`, { decision: "approve" })).status).toBe(404);
  });
});
