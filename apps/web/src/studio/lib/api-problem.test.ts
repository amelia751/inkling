import { describe, expect, it } from "vitest";
import { ApiError } from "./projects-api";
import { toProblem } from "./problem";

describe("fetch helpers throw decoded problems (todo18 D2)", () => {
  it("ApiError carries its ApiProblem: a 422 lists which label", () => {
    const e = new ApiError(422, "bad", { ok: false, errors: [{ path: "/annotations/0/label", code: "label", message: "label 'x' isn't in this Studio's label set" }] });
    const p = toProblem(e);
    expect(p.kind).toBe("invalid");
    expect(p.violations[0]?.message).toContain("label 'x'");
  });
  it("a 409 keeps the server's current document", () => {
    const p = toProblem(new ApiError(409, "conflict", { detail: { code: "revision_conflict", current: { revision: 3, annotations: [] } } }));
    expect(p.kind).toBe("conflict");
    expect((p.current as { revision: number }).revision).toBe(3);
  });
});
