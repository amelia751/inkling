import { describe, expect, it } from "vitest";
import type { AgentCard } from "@studio/agent-protocol";
import { runCardTool } from "./card-tools";
import { applyErrorText, nameProblem, parseReorgPlan, planNodeIds, planSummary, planToFsOps } from "./reorg";

/** todo7 Phase 8: propose_reorganization becomes a plan card; Apply sends one fs/ops batch. */

const input = {
  title: "Group by patient",
  ops: [
    { kind: "mkdir", ref: "p1", parentId: "nod-scans", name: "patient_001", reason: "Scans of P001" },
    { kind: "mkdir", ref: "new:p2", parentId: "nod-scans", name: "patient_002 ", reason: "Scans of P002" },
    { kind: "move", nodeIds: ["nod-a", "nod-b", "nod-c"], parentId: "p1", reason: "Named p001_*" },
    { kind: "move", nodeIds: ["nod-d", "nod-e", "nod-f", "nod-f"], parentId: "new:p2", reason: "Named p002_*" },
    { kind: "rename", nodeId: "nod-g", name: "notes.csv", reason: "Drop the date" },
  ],
};

describe("reorganization plans", () => {
  it("parses refs into new:<handle>, dedupes ids, trims names", () => {
    const r = parseReorgPlan(input, "plan-1");
    if ("error" in r) throw new Error(r.error);
    expect(r.plan.id).toBe("plan-1");
    expect(r.plan.ops[0]).toMatchObject({ kind: "mkdir", ref: "new:p1" });
    expect(r.plan.ops[1]).toMatchObject({ ref: "new:p2", name: "patient_002" });
    expect(r.plan.ops[2]).toMatchObject({ kind: "move", parentId: "new:p1" });
    expect(r.plan.ops[3]).toMatchObject({ nodeIds: ["nod-d", "nod-e", "nod-f"], parentId: "new:p2" });
    expect(planSummary(r.plan)).toBe("2 new folders · 6 items moved · 1 rename");
    expect(planNodeIds(r.plan).sort()).toEqual(["nod-a", "nod-b", "nod-c", "nod-d", "nod-e", "nod-f", "nod-g", "nod-scans"]);
  });

  it("refuses paths, unknown refs, bad names and folders into themselves", () => {
    const bad = (ops: unknown[]) => parseReorgPlan({ title: "t", ops });
    expect(bad([{ kind: "move", nodeIds: ["MRI/scan 1.dcm"], parentId: "nod-x" }])).toMatchObject({ error: expect.stringContaining("node id") });
    expect(bad([{ kind: "move", nodeIds: ["nod-a"], parentId: "new:nope" }])).toMatchObject({ error: expect.stringContaining("earlier mkdir") });
    expect(bad([{ kind: "mkdir", ref: "a", parentId: "nod-x", name: "a/b" }])).toMatchObject({ error: expect.stringContaining('"/"') });
    expect(bad([{ kind: "move", nodeIds: ["nod-a"], parentId: "nod-a" }])).toMatchObject({ error: expect.stringContaining("into itself") });
    expect(bad([{ kind: "delete", nodeIds: ["nod-a"] }])).toMatchObject({ error: expect.stringContaining("mkdir, move or rename") });
    expect(parseReorgPlan({ title: "t", ops: [] })).toMatchObject({ error: "The plan has no ops." });
    expect(nameProblem("..")).toBeTruthy();
    expect(nameProblem("x".repeat(256))).toMatch(/255/);
    expect(nameProblem("ok name.csv")).toBeNull();
  });

  it("becomes one fs/ops batch with client ids for new folders", () => {
    const r = parseReorgPlan(input, "plan-1");
    if ("error" in r) throw new Error(r.error);
    let n = 0;
    const body = planToFsOps(r.plan, { newId: () => `nod-new${++n}` });
    expect(body.ops).toEqual([
      { kind: "mkdir", parentId: "nod-scans", name: "patient_001", id: "nod-new1" },
      { kind: "mkdir", parentId: "nod-scans", name: "patient_002", id: "nod-new2" },
      { kind: "move", nodeIds: ["nod-a", "nod-b", "nod-c"], parentId: "nod-new1" },
      { kind: "move", nodeIds: ["nod-d", "nod-e", "nod-f"], parentId: "nod-new2" },
      { kind: "rename", nodeId: "nod-g", name: "notes.csv" },
    ]);
    // Edit in Files: a subset; a move whose new folder was unticked is refused in words.
    expect(planToFsOps(r.plan, { include: new Set([4]) }).ops).toEqual([{ kind: "rename", nodeId: "nod-g", name: "notes.csv" }]);
    expect(() => planToFsOps(r.plan, { include: new Set([2]) })).toThrow(/include that folder/);
  });

  it("names conflicts from a 409 in a sentence", () => {
    const text = applyErrorText(409, { message: "x", conflicts: [{ nodeId: "a", name: "patient_001", parentId: "p", parentName: "scans", existingId: "e", kind: "folder", identical: false }] });
    expect(text).toBe('An item named "patient_001" in scans already exists. Edit the plan in Sources to decide.');
    expect(applyErrorText(403, "agents can't")).toMatch(/can't change files/);
  });

  it("the card tool builds a reorg-plan card, and works outside the Studio", () => {
    const r = runCardTool("propose_reorganization", input);
    expect(r.ok).toBe(true);
    const card = r.card as Extract<AgentCard, { kind: "reorg-plan" }>;
    expect(card.kind).toBe("reorg-plan");
    expect(card.plan.id).toMatch(/^plan-/);
    expect(r.summary).toBe("2 new folders · 6 items moved · 1 rename");
    expect(runCardTool("propose_reorganization", { title: "t", ops: [{ kind: "move", nodeIds: ["a/b"], parentId: "nod-x" }] })).toMatchObject({ ok: false, summary: "Plan not valid" });
  });
});
