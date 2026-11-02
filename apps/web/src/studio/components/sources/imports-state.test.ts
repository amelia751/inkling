import { describe, expect, it } from "vitest";
import { stateLine } from "./imports";

describe("todo18 URL import fetching state", () => {
  const totals = { files: 0, bytes: 0, receivedBytes: 0, byState: {} };
  it("has a label, never blank", () => expect(stateLine({ state: "fetching", totals })).toBe("Fetching from the link"));
  it("shows bytes fetched of the total", () => expect(stateLine({ state: "fetching", totals: { ...totals, fetchedBytes: 1024 * 1024, fetchTotalBytes: 4 * 1024 * 1024 } })).toMatch(/^Fetching · 1(\.0)? MB of 4(\.0)? MB$/));
});
