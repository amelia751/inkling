import { describe, expect, it } from "vitest";
import { CARD_TOOL_NAMES, runCardTool } from "./card-tools";
import { clientToolsFor, envProfile, PROFILES } from "./session";
import { KERNEL_SCOPES } from "./kernel-token";

describe("one assistant with specialists", () => {
  it("offers no mode picker profiles beyond the assistant and its two specialists", () => {
    expect(PROFILES.map((p) => p.id)).toEqual(["assistant", "coder", "builder"]);
  });

  it("gives the assistant the environment tools, the hand-off card and the task scopes", () => {
    const names = clientToolsFor("assistant").map((t) => t.name);
    expect(names).toContain("patch_environment");
    expect(names).toContain("offer_specialist");
    expect(envProfile("assistant")).toBe(true);
    expect(KERNEL_SCOPES.assistant).toEqual(expect.arrayContaining(KERNEL_SCOPES.task));
    expect(KERNEL_SCOPES.assistant).not.toContain("plugins.manage");
  });

  it("offer_specialist builds a card only for builder or coder, with the request", () => {
    expect(CARD_TOOL_NAMES.has("offer_specialist")).toBe(true);
    const ok = runCardTool("offer_specialist", { specialist: "builder", request: "Add segmentation", reason: "Needs a plugin install." });
    expect(ok.ok).toBe(true);
    expect(ok.card).toEqual({ kind: "specialist", specialist: "builder", request: "Add segmentation", reason: "Needs a plugin install." });
    expect(runCardTool("offer_specialist", { specialist: "task", request: "x", reason: "y" }).ok).toBe(false);
    expect(runCardTool("offer_specialist", { specialist: "coder", request: " ", reason: "y" }).ok).toBe(false);
  });
});
