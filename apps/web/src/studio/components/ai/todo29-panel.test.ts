import { describe, expect, it } from "vitest";
import { reduce, type ChatMessage, type MessagePart } from "@/studio/stores/agent";
import { appliedCopy } from "@/studio/core/drops/PlanCard";
import { actionLabel, wentIn } from "@/studio/core/drops/plans";
import { composerBusy, composerButton, composerEnter, dropSettled } from "./composer-state";
import { groupParts } from "./thread";
import { toolDoneLabel, toolGroupLabel, toolRowSummary } from "./tool-rows";
import { bootLine } from "./boot-card";

type Tool = Extract<MessagePart, { type: "tool" }>;
const tool = (p: Partial<Tool> & { id: string }): Tool => ({ type: "tool", name: "x", title: "Reading files", status: "done", ...p });

describe("todo29 D6: tool rows", () => {
  it("copies pastTitle and progress from the tool-call event onto the part", () => {
    const m: ChatMessage = { id: "a", role: "assistant", parts: [] };
    const next = reduce(m, { type: "tool-call", id: "c1", name: "get_drop", title: "Reading dropped files", pastTitle: "Looked at your files", progress: true } as never);
    const part = next.parts[0] as Tool;
    expect(part.pastTitle).toBe("Looked at your files");
    expect(part.progress).toBe(true);
    expect(typeof part.startedAt).toBe("number");
  });

  it("a done row shows pastTitle, else the title in the past tense", () => {
    expect(toolDoneLabel({ title: "Reading dropped files", pastTitle: "Looked at your files" })).toBe("Looked at your files");
    expect(toolDoneLabel({ title: "Reading environment" })).toBe("Read environment");
  });

  it("never shows a progress summary or a live count; a failure keeps its reason", () => {
    expect(toolRowSummary({ status: "done", summary: "12 images", progress: true })).toBe("");
    expect(toolRowSummary({ status: "done", summary: "0 ready · 35 checking" })).toBe("");
    expect(toolRowSummary({ status: "done", summary: "3 ready" })).toBe("");
    expect(toolRowSummary({ status: "done", summary: "Added 5 labels" })).toBe("Added 5 labels");
    expect(toolRowSummary({ status: "error", summary: "The Studio isn't open", progress: true })).toBe("The Studio isn't open");
  });

  it("folds consecutive tool parts into one group", () => {
    const parts: MessagePart[] = [tool({ id: "1" }), tool({ id: "2" }), { type: "text", text: "hi" }, tool({ id: "3" })];
    const groups = groupParts(parts);
    expect(groups.map((g) => (g.kind === "tools" ? g.parts.length : g.part.type))).toEqual([2, "text", 1]);
  });

  it("labels a group by its time, its step count, or the running row", () => {
    expect(toolGroupLabel([tool({ id: "1", startedAt: 1000, endedAt: 4000 }), tool({ id: "2", startedAt: 4000, endedAt: 13_200 })], false)).toBe("Worked for 12 s");
    expect(toolGroupLabel([tool({ id: "1" }), tool({ id: "2" }), tool({ id: "3" }), tool({ id: "4" })], false)).toBe("Worked through 4 steps");
    expect(toolGroupLabel([tool({ id: "1" }), tool({ id: "2", status: "running", title: "Setting up Studio" })], true)).toBe("Setting up Studio…");
  });
});

describe("todo29 D5: the composer button and the queue", () => {
  it("is Stop while running, even with text or a drop to send", () => {
    expect(composerButton(composerBusy(true, false))).toBe("stop");
    expect(composerButton(composerBusy(false, true))).toBe("stop");
    expect(composerButton(composerBusy(false, false))).toBe("send");
  });

  it("Enter queues while busy and sends when idle", () => {
    expect(composerEnter({ busy: true, text: "and the videos?", canSend: true, queued: ["first"] })).toEqual({ queued: ["first", "and the videos?"] });
    expect(composerEnter({ busy: false, text: "hello", canSend: true, queued: [] })).toEqual({ send: "hello", queued: [] });
    expect(composerEnter({ busy: true, text: "", canSend: false, queued: [] })).toEqual({ queued: [] });
  });

  it("follows a drop until nothing in it moves", () => {
    expect(dropSettled({ chips: [{ state: "in_studio" }, { state: "checking" }] })).toBe(false);
    expect(dropSettled({ chips: [{ state: "uploading" }] })).toBe(false);
    expect(dropSettled({ chips: [], loading: true })).toBe(false);
    expect(dropSettled({ chips: [{ state: "in_studio" }, { state: "kept" }, { state: "failed" }] })).toBe(true);
    expect(dropSettled({ chips: [{ state: "uploading" }], interrupted: true })).toBe(true);
  });
});

describe("todo29 D7/D8: cards say one number, and it agrees", () => {
  const studio = {
    groupId: "g",
    type: "new_dataset" as const,
    name: "Chest X-rays",
    nodeIds: [],
    count: 35,
    members: [
      { groupId: "g-image", kind: "image", count: 12, nodeIds: [] },
      { groupId: "g-volume", kind: "volume", count: 15, nodeIds: [] },
    ],
  };
  const kept = { groupId: "k", type: "keep_reference" as const, nodeIds: [], kind: "video", count: 8 };

  it("the action line and the applied line count what went in, never the drop total", () => {
    expect(actionLabel(studio)).toBe("New Studio · 27 files");
    expect(wentIn([studio, kept])).toBe(27);
    const copy = appliedCopy({ outcome: "add_to_studio", newCount: 35, alreadyHere: 0, plan: { actions: [studio, kept] } });
    expect(copy?.headline).toBe("Added 27 files to Chest X-rays");
    expect(copy?.headline).not.toContain("35");
  });

  it("the Studio card is one line with the item count", () => {
    expect(bootLine("Chest X-rays", 27)).toBe("Chest X-rays · 27 items");
    expect(bootLine("Chest X-rays", 1)).toBe("Chest X-rays · 1 item");
    expect(bootLine("Chest X-rays", undefined)).toBe("Chest X-rays");
  });
});
