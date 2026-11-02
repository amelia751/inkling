import { describe, expect, it } from "vitest";
import { ApiError } from "@/studio/lib/projects-api";
import { toProblem } from "@/studio/lib/problem";
import { retryLine } from "./drop-card";

describe("todo18 429 Retry-After countdown", () => {
  it("counts down in whole seconds", () => {
    expect(retryLine(10_000, 0)).toBe("Too many drops at once. Try again in 10 s");
    expect(retryLine(10_000, 9_100)).toBe("Too many drops at once. Try again in 1 s");
    expect(retryLine(10_000, 10_000)).toBe("Too many drops at once. Try again now");
  });
  it("reads Retry-After carried in the ApiError body", () => {
    const p = toProblem(new ApiError(429, "slow down", { detail: "slow down", retryAfter: 12 }));
    expect(p.kind).toBe("rate-limited");
    expect(p.retryAfter).toBe(12);
  });
});
