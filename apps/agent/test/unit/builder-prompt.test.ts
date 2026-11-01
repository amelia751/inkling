import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// todo10 Phase 6: the builder prompt follows the ladder, lowest rung first, and reports the rung.
const prompt = readFileSync(new URL("../../src/agent/prompts/builder.md", import.meta.url), "utf8");

describe("builder prompt ladder", () => {
  it("orders the rungs: configuration, converter, declarative panel, sandboxed viewer, first-party", () => {
    const at = ["1. Configuration", "2. Converter", "3. Declarative panel", "4. Sandboxed viewer", "5. First-party"].map((s) => prompt.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("asks the agent to report the rung it chose and why", () => {
    expect(prompt).toContain('"Rung N (<name>): <why the lower rungs didn\'t work>"');
  });

  it("keeps sandboxed viewers on the typed geometry API and approval", () => {
    expect(prompt).toContain("studio.sandbox-frame.v1");
    expect(prompt).toContain("host.annotations.propose");
    expect(prompt).toMatch(/needs the user's approval/);
  });
});
