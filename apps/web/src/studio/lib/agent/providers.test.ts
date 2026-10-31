import { describe, expect, it } from "vitest";
import type { ProjectOverview, SourceNode } from "@studio/contracts/types";
import { runCardTool } from "./card-tools";
import { currentProvider, overviewContext, proposalContext, sectionContext, sourceNodeContext, useAgentContextStore } from "./providers";

/** todo6 Phase 6: what each section lets the assistant see, and open_location's card. */

const project = { id: "prj-1", title: "Knee MRI" };
const node = (over: Partial<SourceNode> = {}): SourceNode => ({
  id: "nod-1",
  sourceId: "src-1",
  parentId: null,
  name: "patient_002",
  displayPath: "MRI / patient_002",
  kind: "folder",
  detectedKind: "folder",
  size: null,
  sha256: null,
  childCount: 2,
  descendantCount: 240,
  facts: { series: 2, protocol: "T1 knee" },
  flags: {},
  status: "ready",
  importSessionId: null,
  createdAt: null,
  ...over,
});

describe("agent context providers", () => {
  it("Sources: the selected node and its facts, labelled for the chip", () => {
    const p = sourceNodeContext(project, node());
    expect(p.label).toBe("Data › MRI / patient_002");
    expect(p.turnContext()).toContain("T1 knee");
    expect(p.turnContext()).toContain("240 files");
  });

  it("never shares anything about a privacy-held node", () => {
    const p = sourceNodeContext(project, node({ name: "John_Doe.pdf", displayPath: undefined, kind: "file", status: "privacy", flags: { privacy: { reason: "name" } } }));
    expect(p.label).toBe("Data › a held file");
    expect(p.turnContext()).not.toMatch(/John_Doe|T1 knee/);
  });

  it("restricted projects share kinds and numbers, not names", () => {
    const p = sourceNodeContext({ ...project, restricted: true }, node());
    expect(p.label).toBe("Data › a folder");
    expect(p.turnContext()).not.toMatch(/patient_002|T1 knee/);
    expect(p.turnContext()).toContain('"series":2');
  });

  it("Overview counts held files without naming them", () => {
    const o = {
      project: { id: "prj-1", title: "Knee MRI" },
      tasks: [],
      data: [{ type: "source", id: "src-1", title: "upload", count: 3, kind: "table", kindLabel: "Tables" }],
      attention: [{ id: "privacy:n", type: "privacy", severity: "high", title: "Held for privacy review", detail: "John_Doe.pdf: name", target: { section: "sources" }, at: null }],
      empty: false,
    } as unknown as ProjectOverview;
    const text = overviewContext(o).turnContext();
    expect(text).toContain("3 tables");
    expect(text).toContain("1 file held for privacy review");
    expect(text).not.toContain("John_Doe");
  });

  it("Explore: the selected proposal", () => {
    const p = proposalContext(project, { id: "prp-1", projectId: "prj-1", kind: "relationship", payload: { rule: "id ↔ folder" }, evidence: {}, strength: "possible", status: "proposed", importSessionId: null, createdBy: "worker:inspect", createdAt: null, decidedBy: null, decidedAt: null });
    expect(p.label).toBe("Explore › Proposed relationship");
    expect(p.turnContext()).toContain("Only the user can confirm");
  });

  it("falls back to the section when the page registered nothing (or another section's)", () => {
    expect(currentProvider(null, "sources", project).label).toBe("Data");
    const overview = sectionContext(project, "overview");
    expect(currentProvider(overview, "sources", project).label).toBe("Data");
    expect(currentProvider(overview, "overview", project)).toBe(overview);
  });

  it("a removed chip stays removed for that context only", () => {
    const s = useAgentContextStore.getState();
    s.register(sectionContext(project, "sources"));
    s.dismiss();
    expect(useAgentContextStore.getState().dismissed).toBe("prj-1:sources");
    s.register(sourceNodeContext(project, node()));
    expect(useAgentContextStore.getState().dismissed).not.toBe(useAgentContextStore.getState().provider?.key);
  });
});

describe("open_location", () => {
  it("builds a location card from ids", () => {
    const r = runCardTool("open_location", { section: "sources", nodeId: "nod-1", label: "Sources › MRI/patient_002" });
    expect(r).toMatchObject({ ok: true, card: { kind: "location", label: "Sources › MRI/patient_002", target: { section: "sources", nodeId: "nod-1" } } });
  });
  it("rejects paths and unknown sections", () => {
    expect(runCardTool("open_location", { section: "sources", nodeId: "MRI/patient 002", label: "x" }).ok).toBe(false);
    expect(runCardTool("open_location", { section: "settings-danger", label: "x" }).ok).toBe(false);
  });
  it("Studio-only cards say so outside the Studio", () => {
    expect(runCardTool("show_items", { title: "t", itemIds: ["a"] })).toMatchObject({ ok: false, summary: "Needs the Studio" });
  });
});
