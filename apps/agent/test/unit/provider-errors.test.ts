import { describe, expect, it } from "vitest";
import { providerErrorMessage } from "../../src/runtime/events.ts";

describe("todo18 D provider errors in plain words", () => {
  it("bad key → check the key", () => {
    expect(providerErrorMessage("401 invalid_api_key: Incorrect API key provided")).toMatch(/Check the key/);
  });
  it("429 → wait n s", () => {
    expect(providerErrorMessage("429 rate_limit_error: please try again in 12.4s")).toMatch(/Wait 13 s/);
    expect(providerErrorMessage("429 Too Many Requests")).toMatch(/Wait a minute/);
  });
  it("context length → new chat", () => {
    expect(providerErrorMessage("400 prompt is too long: 210000 tokens > 200000 maximum")).toMatch(/Start a new chat/);
  });
  it("anything else passes through, scrubbed", () => {
    expect(providerErrorMessage("socket hang up")).toBe("socket hang up");
  });
});
