/** todo15 D3: `boot_studio` in a project without a Studio, from a described task or a drop-only message. */
import { describe, expect, it } from "vitest";
import { isCreationIntent, namesTask } from "@studio/studio-tools";
import { loadStudioCatalog } from "../../src/agent/catalog.ts";
import { type Budgets, type PolicyState, bootAllowed, decide } from "../../src/tools/policy.ts";

const { intents } = loadStudioCatalog({ studioFiles: { catalog: undefined, intents: undefined } });
const budgets: Budgets = { maxToolCalls: 80, maxRunSeconds: 900, maxSpendUsd: 2 };
const state = (s: Partial<PolicyState>): PolicyState => ({
  toolCalls: 0,
  startedAt: 0,
  spendUsd: 0,
  restricted: false,
  egressContained: false,
  userText: "",
  creationIntent: (t) => isCreationIntent(t, intents),
  namesTask: (t) => namesTask(t, intents),
  ...s,
});
const boot = (s: Partial<PolicyState>) => decide({ toolName: "boot_studio", input: {} }, state(s), budgets, {}, 0);

describe("boot policy (todo15 D3)", () => {
  it("a described task boots in a project without a Studio", () => {
    expect(boot({ userText: "Chest X-ray classification with five labels", projectHasTask: false }).kind).toBe("allow");
    expect(boot({ userText: "segment the lungs on these CTs", projectHasTask: false }).kind).toBe("allow");
  });

  it("a drop-only first message (no text) may boot in a project without a Studio", () => {
    expect(boot({ userText: "", projectHasTask: false }).kind).toBe("allow");
  });

  it("the same text is still denied (soft) when the project has a Studio, or when unknown", () => {
    for (const projectHasTask of [true, undefined]) {
      const d = boot({ userText: "Chest X-ray classification with five labels", projectHasTask });
      expect(d.kind).toBe("deny");
      expect(d.kind === "deny" && d.soft).toBe(true);
    }
    expect(boot({ userText: "", projectHasTask: true }).kind).toBe("deny");
  });

  it("an explicit create boots whether or not the project has a Studio", () => {
    for (const projectHasTask of [true, false, undefined]) expect(boot({ userText: "Create a chest X-ray Studio with five labels", projectHasTask }).kind).toBe("allow");
  });

  it("small talk, unrelated questions and negations don't boot even in an empty project", () => {
    expect(boot({ userText: "hello there", projectHasTask: false }).kind).toBe("deny");
    expect(boot({ userText: "don't create a chest x-ray studio yet", projectHasTask: false }).kind).toBe("deny");
  });

  it("profiles without the Studio intent check are not gated", () => {
    expect(bootAllowed({ ...state({}), creationIntent: undefined })).toBe(true);
  });

  it("a described task in a project that already has a Studio is told to patch it, not to offer another", () => {
    const d = boot({ userText: "Chest X-ray classification with five labels: normal, pneumonia", projectHasTask: true });
    expect(d.kind).toBe("deny");
    expect(JSON.stringify(d)).toContain("patch_studio");
    expect(JSON.stringify(boot({ userText: "hello", projectHasTask: true }))).toContain("offer_studio");
  });
});
