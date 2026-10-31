import { describe, expect, it } from "vitest";
import type { StudioItem } from "@studio/contracts/types";
import { nextTodoIndex } from "./items";

const items = ["a", "b", "c", "d"].map((id) => ({ id, name: id }) as StudioItem);

describe("nextTodoIndex", () => {
  it("walks forward to the next item without annotations, wrapping around", () => {
    expect(nextTodoIndex(items, [{ itemId: "b" }], 0)).toBe(2);
    expect(nextTodoIndex(items, [{ itemId: "d" }], 2)).toBe(0);
  });
  it("skips the current item and is undefined when nothing else is left", () => {
    expect(nextTodoIndex(items, [{ itemId: "a" }, { itemId: "b" }, { itemId: "d" }], 2)).toBeUndefined();
  });
});
