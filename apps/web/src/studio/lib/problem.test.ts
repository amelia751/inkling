import { describe, expect, it } from "vitest";
import { ProblemError, problemFrom, problemMessage, toProblem } from "./problem";
import { can } from "./use-can";

describe("problem decoder (todo18 D2)", () => {
  it("reads problem JSON, legacy errors and FastAPI detail", () => {
    const p = problemFrom(422, { type: "https://x/problems/label.unknown", title: "Invalid", violations: [{ code: "label.unknown", path: "/annotations/0/label", message: "Label 'cat' isn't in the label set" }] });
    expect(p.kind).toBe("invalid");
    expect(p.code).toBe("label.unknown");
    expect(p.violations[0].path).toBe("/annotations/0/label");
    expect(problemFrom(400, { errors: ["bad name"] }).violations[0].message).toBe("bad name");
    expect(problemFrom(422, { detail: [{ loc: ["body", "name"], msg: "too long", type: "value_error" }] }).violations[0]).toMatchObject({ path: "body.name", message: "too long" });
    expect(problemFrom(403, { detail: "You can view this project but not delete from it" }).detail).toBe("You can view this project but not delete from it");
  });
  it("maps statuses to kinds and retry hints", () => {
    expect(problemFrom(429, {}, new Headers({ "Retry-After": "7" }))).toMatchObject({ kind: "rate-limited", retryAfter: 7, retryable: true });
    expect(problemFrom(409, { detail: { message: "stale", current: { revision: 4 } } })).toMatchObject({ kind: "conflict", detail: "stale", current: { revision: 4 } });
    expect(toProblem(new TypeError("Failed to fetch")).kind).toBe("offline");
    expect(toProblem(new Error("404 Not Found")).kind).toBe("gone");
    expect(toProblem(new ProblemError(problemFrom(410, { trashBatchId: "b1" }))).trashBatchId).toBe("b1");
    expect(problemMessage(new ProblemError(problemFrom(500, { detail: "internal error: x" })))).toMatch(/our side/);
  });
});

describe("can (todo18 D3)", () => {
  it("follows the role", () => {
    expect(can("viewer", "trash")).toEqual({ ok: false, reason: "You can view this project but not delete from it." });
    expect(can("editor", "trash").ok).toBe(true);
    expect(can("editor", "destroy").ok).toBe(false);
    expect(can("owner", "destroy").ok).toBe(true);
    expect(can(undefined, "destroy").ok).toBe(true);
  });
});
