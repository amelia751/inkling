import { describe, expect, it } from "vitest";
import { problemFrom } from "./problem";
import { retryDelayMs, saveChip } from "./save-problem";

describe("saveChip (todo18 D2)", () => {
  it("a 422 names the label", () => {
    const p = problemFrom(422, { detail: { ok: false, errors: [{ path: "/annotations/0/label", code: "label", message: "label 'tumour' isn't in this Studio's label set" }] } });
    expect(saveChip(p)).toMatchObject({ state: "invalid-label", label: "tumour" });
  });
  it("offline keeps changes and backs off", () => {
    const p = problemFrom(0, undefined);
    expect(saveChip(p)).toMatchObject({ state: "offline", text: "Offline, changes kept" });
    expect(retryDelayMs(p, 1)).toBe(2000);
    expect(retryDelayMs(p, 10)).toBe(60000);
  });
  it("409 and 410 get their own states", () => {
    expect(saveChip(problemFrom(409, {})).state).toBe("conflict");
    expect(saveChip(problemFrom(410, {})).state).toBe("gone");
  });
});
