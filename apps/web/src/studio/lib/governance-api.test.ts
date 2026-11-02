import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/studio/lib/projects-api";
import { fieldOf, isMissingRoute, parseProblem, problemText, violationsAt } from "./problem";
import { actorName, authorLine, changeRequestOf, diffValue, fetchChanges, fetchFindings, groupFindings, labelId, mergeChange, rulesSourceLine, wouldHaveRejectedRows, writesLine } from "./governance-api";
import { fromDraft, newLabel, toDraft } from "./rules-draft";
import { changesUrl, connectedAgentsUrl, settingsUrl, targetUrl } from "./routes";

const WRITE_REJECTED = {
  type: "/docs/lint-rules#write_rejected",
  title: "The write breaks 2 project rules",
  status: 422,
  code: "write_rejected",
  violations: [
    { rule: "label.unknown", severity: "error", path: "/labels/0/name", message: "Labels are normal, pneumonia", fix: "Use pneumonia" },
    { rule: "layout.misplaced", severity: "warn", path: "/layout/folderPatterns", message: "Put it under images/" },
  ],
  retryable: false,
};

describe("problem JSON", () => {
  it("turns JSON pointers and loc arrays into dotted fields", () => {
    expect(fieldOf("/labels/0/name")).toBe("labels.0.name");
    expect(fieldOf("labels/0/name")).toBe("labels.0.name");
    expect(fieldOf("/a~1b/c~0d")).toBe("a/b.c~d");
    expect(fieldOf(["body", "labels", 1, "colour"])).toBe("labels.1.colour");
    expect(fieldOf("")).toBe("");
    expect(fieldOf(undefined)).toBe("");
  });

  it("reads write_rejected into violations by field", () => {
    const p = parseProblem(WRITE_REJECTED);
    expect(p?.code).toBe("write_rejected");
    expect(p?.status).toBe(422);
    expect(p?.violations.map((v) => v.field)).toEqual(["labels.0.name", "layout.folderPatterns"]);
    expect(violationsAt(p, "labels.0")).toHaveLength(1);
    expect(violationsAt(p, "labels")).toHaveLength(1);
    expect(violationsAt(p, "labels", true)).toHaveLength(0);
    expect(violationsAt(p, "layout.maxDepth")).toHaveLength(0);
    expect(violationsAt(null, "labels")).toEqual([]);
  });

  it("reads the rules validator's detail.issues and a stale 409", () => {
    const err = new ApiError(422, "x", { detail: { error: "invalid rules", issues: [{ path: "labels/0/colour", message: "bad colour" }] } });
    const p = parseProblem(err);
    expect(p?.title).toBe("invalid rules");
    expect(p?.violations[0]).toMatchObject({ field: "labels.0.colour", message: "bad colour" });
    const stale = parseProblem(new ApiError(409, "stale revision", { detail: { error: "stale revision", revision: 4 } }));
    expect(stale).toMatchObject({ status: 409, code: "stale", title: "stale revision", violations: [] });
  });

  it("reads FastAPI's own 422 and plain errors", () => {
    expect(parseProblem({ detail: [{ loc: ["body", "rules"], msg: "field required" }] }, 422)?.violations[0]).toMatchObject({ field: "rules", message: "field required" });
    expect(parseProblem({ detail: "Not found" }, 404)).toMatchObject({ status: 404, title: "Not found" });
    expect(parseProblem(null)).toBeNull();
    expect(parseProblem(new ApiError(500, "500 Internal"))).toMatchObject({ status: 500, title: "500 Internal" });
  });

  it("says one thing for any error", () => {
    expect(problemText(new ApiError(422, "x", { ...WRITE_REJECTED, violations: [WRITE_REJECTED.violations[0]] }))).toBe("Labels are normal, pneumonia");
    expect(problemText(new ApiError(422, "x", WRITE_REJECTED))).toBe("The write breaks 2 project rules");
    expect(problemText(new Error("boom"))).toBe("boom");
    expect(problemText(undefined)).toBe("Something went wrong");
  });

  it("knows when a route isn't there yet", () => {
    expect(isMissingRoute(new ApiError(404, "nope"))).toBe(true);
    expect(isMissingRoute(new ApiError(501, "nope"))).toBe(true);
    expect(isMissingRoute(new ApiError(500, "boom"))).toBe(false);
    expect(isMissingRoute(new Error("x"))).toBe(false);
  });
});

describe("change requests", () => {
  it("names authors and agents", () => {
    expect(actorName("agent:Claude Code")).toBe("Claude Code");
    expect(actorName("amelia")).toBe("amelia");
    expect(actorName(null)).toBe("Someone");
    expect(authorLine({ actor: "agent:Cursor", agent: "Cursor", onBehalfOf: "amelia" })).toBe("Cursor for amelia");
    expect(authorLine({ actor: "agent:Cursor", agent: null, onBehalfOf: null })).toBe("Cursor");
    expect(authorLine({ actor: "amelia", agent: null, onBehalfOf: null })).toBe("amelia");
  });

  it("prints diff values short", () => {
    expect(diffValue(undefined)).toBe("—");
    expect(diffValue(null)).toBe("—");
    expect(diffValue("pneumonia")).toBe("pneumonia");
    expect(diffValue({ a: 1 })).toBe('{"a":1}');
    expect(diffValue("x".repeat(200), 10)).toHaveLength(10);
  });

  it("finds a change request in a tool result", () => {
    expect(changeRequestOf(JSON.stringify({ changeRequest: { id: "cr1", title: "Add PNA" } }))).toEqual({ id: "cr1", title: "Add PNA" });
    expect(changeRequestOf({ changeRequest: { id: "cr2" } })).toEqual({ id: "cr2", title: "Untitled change" });
    expect(changeRequestOf("not json")).toBeNull();
    expect(changeRequestOf(JSON.stringify({ ok: true }))).toBeNull();
    expect(changeRequestOf(undefined)).toBeNull();
  });
});

describe("health", () => {
  const f = (rule: string, severity: "error" | "warn" | "info") => ({ rule, severity, path: "", message: rule });

  it("groups findings by rule, worst first, with catalogue titles", () => {
    const groups = groupFindings([f("layout.misplaced", "warn"), f("label.unknown", "error"), f("layout.misplaced", "warn"), f("custom.rule", "info")]);
    expect(groups.map((g) => g.rule)).toEqual(["label.unknown", "layout.misplaced", "custom.rule"]);
    expect(groups[0].title).toBe("Label isn't in the project's rules");
    expect(groups[1].findings).toHaveLength(2);
    expect(groups[2].title).toBe("custom.rule");
  });

  it("lists would-have-rejected counts", () => {
    expect(wouldHaveRejectedRows({ "layout.misplaced": 3, "name.pattern": 0, "dataset.metadata-missing": 5 }).map((r) => [r.rule, r.count])).toEqual([
      ["dataset.metadata-missing", 5],
      ["layout.misplaced", 3],
    ]);
    expect(writesLine(1)).toBe("Would have rejected 1 write");
    expect(writesLine(3)).toBe("Would have rejected 3 writes");
  });

  it("says where the rules come from", () => {
    expect(rulesSourceLine({ source: "preset", preset: "chest-xray" })).toBe("Using the chest-xray rules");
    expect(rulesSourceLine({ source: "default", preset: null })).toBe("Using the default rules");
    expect(rulesSourceLine({ source: "project", preset: "chest-xray" })).toBeNull();
    expect(rulesSourceLine(undefined)).toBeNull();
  });
});

describe("fetchers", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => {
    const fetch = vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("lists changes and fills findings defaults", async () => {
    const fetch = stub(200, { changes: [{ id: "c1", title: "t" }] });
    expect(await fetchChanges("p 1", "all")).toEqual([{ id: "c1", title: "t" }]);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("/v1/projects/p%201/changes?state=all");
    stub(200, { findings: [] });
    expect(await fetchFindings("p")).toEqual({ findings: [], counts: { error: 0, warn: 0, info: 0 }, wouldHaveRejected: {} });
  });

  it("surfaces a 409 merge as a needs-update problem", async () => {
    stub(409, { detail: { error: "needs update", code: "needs-update" } });
    const err = await mergeChange("p", "c1").catch((e: unknown) => e);
    expect(parseProblem(err)).toMatchObject({ status: 409, code: "needs-update", title: "needs update" });
  });
});

describe("rules draft", () => {
  const rules = {
    version: 1 as const,
    labels: [{ id: "pneumonia", name: "pneumonia", synonyms: ["PNA"], colour: "#ff0000", allowedGeometries: ["box"], attributes: { type: "object" } }],
    layout: { folderPatterns: ["images/**"], forbiddenCharacters: ":", maxDepth: 3 },
    datasets: { requiredMetadata: ["modality" as const], oneModalityPerDataset: true, uniqueNames: true },
    annotations: { insideImage: true, requiredAttributes: [] },
    imaging: { checks: {} },
    severityOverrides: { "layout.misplaced": "error" as const },
    merge: { auto: "never" as const },
  };

  it("round-trips and keeps what the form doesn't edit", () => {
    const out = fromDraft(toDraft(rules), rules);
    expect(out).toEqual(rules);
  });

  it("adds labels with ids from their names and parses lists", () => {
    const d = toDraft(rules);
    d.labels.push({ ...newLabel(), name: "Pleural Effusion", synonyms: "effusion, , PE", geometries: "polygon" });
    d.folderPatterns = "images/**\n\nmasks/**";
    d.maxDepth = "";
    d.requiredMetadata = ["license", "modality"];
    const out = fromDraft(d, rules);
    expect(out.labels[1]).toEqual({ id: "pleural-effusion", name: "Pleural Effusion", synonyms: ["effusion", "PE"], allowedGeometries: ["polygon"] });
    expect(out.layout.folderPatterns).toEqual(["images/**", "masks/**"]);
    expect(out.layout.maxDepth).toBeUndefined();
    expect(out.datasets.requiredMetadata).toEqual(["modality", "license"]);
  });

  it("makes unique label ids", () => {
    expect(labelId("Nodule", ["nodule"])).toBe("nodule-2");
    expect(labelId("  ")).toBe("label");
  });
});

describe("urls", () => {
  it("routes changes, rules and connected agents", () => {
    expect(changesUrl("p")).toBe("/projects/p/changes");
    expect(changesUrl("p", "c 1")).toBe("/projects/p/changes/c%201");
    expect(settingsUrl("p", "rules")).toBe("/projects/p/settings/rules");
    expect(connectedAgentsUrl()).toBe("/settings/connected-agents");
    expect(targetUrl("p", { section: "changes", changeId: "c1" })).toBe("/projects/p/changes/c1");
    expect(targetUrl("p", { section: "settings", tab: "rules" })).toBe("/projects/p/settings/rules");
  });
});
