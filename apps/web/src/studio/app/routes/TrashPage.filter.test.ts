import { describe, expect, it } from "vitest";
import { projectTrashUrl } from "@/studio/lib/routes";
import { initialTrashFilter } from "./TrashPage";

describe("todo18: Sources › Trash is a filter of the one Trash", () => {
  it("links with the Sources chip preselected", () => {
    expect(projectTrashUrl("p 1", "sources")).toBe("/projects/p%201/trash?kind=sources");
    expect(projectTrashUrl("p")).toBe("/projects/p/trash");
    expect(initialTrashFilter("sources")).toBe("sources");
    expect(initialTrashFilter("bogus")).toBe("all");
    expect(initialTrashFilter(null)).toBe("all");
  });
});
