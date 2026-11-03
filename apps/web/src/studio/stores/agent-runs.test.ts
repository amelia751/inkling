import { beforeEach, describe, expect, it, vi } from "vitest";

const decideApproval = vi.fn();
vi.mock("@/studio/lib/agent/client", async (orig) => ({ ...(await orig<object>()), decideApproval: (...a: unknown[]) => decideApproval(...a) }));

import { AgentHttpError } from "@/studio/lib/agent/client";
import { RES } from "@studio/contracts/naming";
import { findItem, runCardTool } from "@/studio/lib/agent/card-tools";
import { secondsLeft } from "@/studio/lib/agent/approval";
import { snapshotTruncation } from "@/studio/lib/agent/context";
import { raceAbort, reduce, TOOL_STOPPED, useAgent, type ChatMessage } from "./agent";

const approval = (expiresAt: number): ChatMessage => ({
  id: "m1",
  role: "assistant",
  parts: [{ type: "approval", id: "a1", toolName: "t", summary: "s", inputPreview: "{}", state: "pending", expiresAt }],
});
const stateOf = () => (useAgent.getState().threads.p![0]!.parts[0] as { state: string }).state;

describe("todo18 D assistant store", () => {
  beforeEach(() => {
    decideApproval.mockReset();
    useAgent.setState({ threads: {}, conversations: {}, runs: {}, streaming: {}, blockedBy: null });
  });

  it("Stop / panel closed: a browser tool in flight fails at once", async () => {
    const ctl = new AbortController();
    const never = new Promise<{ ok: boolean; output: unknown }>(() => {});
    const p = raceAbort(never, ctl.signal, () => ({ ok: false, output: { error: TOOL_STOPPED } }));
    ctl.abort();
    await expect(p).resolves.toEqual({ ok: false, output: { error: TOOL_STOPPED } });
  });

  it("approved, then the tool failed: the card is patched with the failure", () => {
    let m: ChatMessage = { id: "m", role: "assistant", parts: [] };
    m = reduce(m, { type: "approval", approvalId: "a1", toolCallId: "c1", toolName: "trash", summary: "s", inputPreview: "{}", expiresAt: Date.now() + 1e5 } as never);
    m = reduce(m, { type: "approval-resolved", approvalId: "a1", decision: "approve" } as never);
    m = reduce(m, { type: "tool-result", id: "c1", ok: false, summary: "Target is gone", input: {} } as never);
    expect(m.parts[0]).toMatchObject({ state: "approved", failed: "Target is gone" });
  });

  it("second tab: another tab following the run shows Take over here; its end clears this tab", async () => {
    useAgent.setState({ streaming: { c1: true }, runs: { c1: { projectId: "p", chatId: "c1", runId: "r1", messageId: "m", lastSeq: 0, answered: [] } } });
    const other = new BroadcastChannel(`${RES}-agent-follow`);
    other.postMessage({ type: "follow", runId: "r1", tab: "other" });
    await vi.waitFor(() => expect(useAgent.getState().followedElsewhere).toBe("r1"));
    other.postMessage({ type: "ended", runId: "r1", tab: "other" });
    await vi.waitFor(() => expect(useAgent.getState().runs.c1).toBeUndefined());
    expect(useAgent.getState().streaming.c1).toBeUndefined();
    other.close();
  });

  it("context chip says when the snapshot was cut at 3,000 annotations", () => {
    expect(snapshotTruncation(3000)).toBeNull();
    expect(snapshotTruncation(4210)).toBe("Shares the first 3,000 of 4,210 annotations");
  });
});
