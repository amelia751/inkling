import { beforeEach, describe, expect, it, vi } from "vitest";

const decideApproval = vi.fn();
vi.mock("@/studio/lib/agent/client", async (orig) => ({ ...(await orig<object>()), decideApproval: (...a: unknown[]) => decideApproval(...a) }));

import { AgentHttpError } from "@/studio/lib/agent/client";
import { RES } from "@studio/contracts/naming";
import { findItem, runCardTool } from "@/studio/lib/agent/card-tools";
import { secondsLeft } from "@/studio/lib/agent/approval";
import { BLOCKED_PREFIX, raceAbort, reduce, TOOL_STOPPED, useAgent, type ChatMessage } from "./agent";

const approval = (expiresAt: number): ChatMessage => ({
  id: "m1",
  role: "assistant",
  parts: [{ type: "approval", id: "a1", toolName: "t", summary: "s", inputPreview: "{}", state: "pending", expiresAt }],
});
const stateOf = () => (useAgent.getState().threads.p![0]!.parts[0] as { state: string }).state;

describe("todo18 D assistant store", () => {
  beforeEach(() => {
    decideApproval.mockReset();
    useAgent.setState({ threads: {}, running: null, active: null, blockedBy: null });
  });

  it("Stop / panel closed: a browser tool in flight fails at once", async () => {
    const ctl = new AbortController();
    const never = new Promise<{ ok: boolean; output: unknown }>(() => {});
    const p = raceAbort(never, ctl.signal, () => ({ ok: false, output: { error: TOOL_STOPPED } }));
    ctl.abort();
    await expect(p).resolves.toEqual({ ok: false, output: { error: TOOL_STOPPED } });
  });

  it("send in project B while A runs says so instead of doing nothing", async () => {
    useAgent.setState({ running: "A" });
    await useAgent.getState().send("B", "hi", { profile: "default" } as never);
    const t = useAgent.getState().threads.B!;
    expect(t.at(-1)!.error).toContain(`${BLOCKED_PREFIX}A`);
    expect(useAgent.getState().blockedBy).toEqual({ projectId: "B", waitingOn: "A" });
  });

  it("approval stays pending until the POST succeeds", async () => {
    let resolve!: () => void;
    decideApproval.mockReturnValue(new Promise<void>((r) => (resolve = r)));
    useAgent.setState({ threads: { p: [approval(Date.now() + 60_000)] } });
    const done = useAgent.getState().decide("p", "m1", "a1", "approve");
    expect(stateOf()).toBe("pending");
    resolve();
    await done;
    expect(stateOf()).toBe("approved");
  });

  it("an expired approval is not posted; a 409 marks it expired; a network error keeps it pending", async () => {
    useAgent.setState({ threads: { p: [approval(Date.now() - 1)] } });
    await useAgent.getState().decide("p", "m1", "a1", "approve");
    expect(decideApproval).not.toHaveBeenCalled();
    expect(stateOf()).toBe("expired");

    useAgent.setState({ threads: { p: [approval(Date.now() + 60_000)] } });
    decideApproval.mockRejectedValueOnce(new AgentHttpError(409, "gone"));
    await useAgent.getState().decide("p", "m1", "a1", "approve");
    expect(stateOf()).toBe("expired");

    useAgent.setState({ threads: { p: [approval(Date.now() + 60_000)] } });
    decideApproval.mockRejectedValueOnce(new TypeError("offline"));
    await useAgent.getState().decide("p", "m1", "a1", "approve");
    expect(stateOf()).toBe("pending");
  });

  it("countdown seconds from expiresAt", () => {
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(9_000, 10_000)).toBe(0);
  });

  it("findItem: exact id or exact name only; several → ask", () => {
    const ctx = { items: [{ id: "i1", name: "scan" }, { id: "i2", name: "Scan" }, { id: "i3", name: "scan-02" }, { id: "i4", name: "liver" }] } as never;
    expect(findItem(ctx, "i3")).toEqual({ id: "i3" });
    expect(findItem(ctx, "LIVER")).toEqual({ id: "i4" });
    expect(findItem(ctx, "liv")).toBeUndefined();
    expect(findItem(ctx, "scan")).toEqual({ ambiguous: ["i1", "i2"] });
    const r = runCardTool("show_items", { itemIds: ["scan"] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("Which item?");
  });

  it("approved, then the tool failed: the card is patched with the failure", () => {
    let m: ChatMessage = { id: "m", role: "assistant", parts: [] };
    m = reduce(m, { type: "approval", approvalId: "a1", toolCallId: "c1", toolName: "trash", summary: "s", inputPreview: "{}", expiresAt: Date.now() + 1e5 } as never);
    m = reduce(m, { type: "approval-resolved", approvalId: "a1", decision: "approve" } as never);
    m = reduce(m, { type: "tool-result", id: "c1", ok: false, summary: "Target is gone", input: {} } as never);
    expect(m.parts[0]).toMatchObject({ state: "approved", failed: "Target is gone" });
  });

  it("second tab: another tab following the run shows Take over here; its end clears this tab", async () => {
    useAgent.setState({ running: "p", active: { projectId: "p", runId: "r1", messageId: "m", lastSeq: 0, answered: [] } as never });
    const other = new BroadcastChannel(`${RES}-agent-follow`);
    other.postMessage({ type: "follow", runId: "r1", tab: "other" });
    await vi.waitFor(() => expect(useAgent.getState().followedElsewhere).toBe("r1"));
    other.postMessage({ type: "ended", runId: "r1", tab: "other" });
    await vi.waitFor(() => expect(useAgent.getState().active).toBeNull());
    expect(useAgent.getState().running).toBeNull();
    other.close();
  });
});
