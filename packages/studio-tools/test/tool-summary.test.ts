import { describe, expect, it } from "vitest";
import { toolSummaryText } from "../src/tool-summary.ts";

const refused = JSON.stringify({
  error: "The change doesn't validate. Fix each error at its path (use search_catalog for ids) and try again.",
  status: 422,
  errors: [{ path: "/labels/0/control", code: "schema", message: "/labels/0/control: 'Classification' is not one of ['Labels', 'Choices']" }],
});

describe("toolSummaryText (todo24 W6)", () => {
  it("turns a refused label set into a sentence", () => {
    expect(toolSummaryText(refused)).toBe("Label set needed a fix");
    expect(toolSummaryText(`Error: ${refused}`)).toBe("Label set needed a fix");
  });

  it("reads a patch-op error about labels", () => {
    const body = JSON.stringify({ error: "x", status: 422, errors: [{ path: "/0", code: "patch", message: "Patch op 0 (replace /labels): can't replace a non-existent object 'labels'" }] });
    expect(toolSummaryText(body)).toBe("Label set needed a fix");
  });

  it("counts other path errors", () => {
    const body = JSON.stringify({ error: "x", errors: [{ path: "/title", message: "a" }, { path: "/layout", message: "b" }] });
    expect(toolSummaryText(body)).toBe("The change needed 2 fixes");
  });

  it("uses the first sentence of an error with no paths", () => {
    expect(toolSummaryText(JSON.stringify({ error: "Unknown preset preset:foo. Use one from the preset index: a, b." }))).toBe("Unknown preset preset:foo");
    expect(toolSummaryText(JSON.stringify({ status: 403, error: "Outside what…" }))).toBe("Outside what the assistant may change");
  });

  it("reads JSON cut off by an earlier clip", () => {
    expect(toolSummaryText('{"error":"The change doesn\'t validate. Fix each error at its path and try again.","status":422,"errors":[{"path":"/labels/0/cla')).toBe("Label set needed a fix");
    expect(toolSummaryText('{"error":"Not allowed here. More','Failed')).toBe("Not allowed here");
    expect(toolSummaryText('{"weird":', "Failed")).toBe("Failed");
  });

  it("never returns JSON", () => {
    for (const s of [refused, '{"a":1}', "[1,2]", '{"error":{"message":"{\\"x\\":1}"}}']) expect(toolSummaryText(s)).not.toMatch(/^[[{]/);
  });

  it("passes plain text through", () => {
    expect(toolSummaryText("Studio ready (preset:image-2d)")).toBe("Studio ready (preset:image-2d)");
    expect(toolSummaryText("")).toBe("");
  });
});
