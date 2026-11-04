import { describe, expect, it } from "vitest";
import type { ChipState } from "./progress";
import { MAX_TILES, tileReason, tileState, visibleTiles } from "./attachment-tiles";

describe("todo29 D2: one look per attached file", () => {
  it("maps every chip state to loading, done or failed (removed is hidden)", () => {
    const want: Record<ChipState, string | null> = {
      confirming: "loading",
      preparing: "loading",
      uploading: "loading",
      checking: "loading",
      ready: "done",
      in_studio: "done",
      kept: "done",
      duplicate: "done",
      waiting_kind: "done",
      failed: "failed",
      held: "failed",
      deleted: "failed",
      removed: null,
    };
    for (const [state, look] of Object.entries(want)) expect(tileState(state as ChipState), state).toBe(look);
  });

  it("a failed tile says why in one line, never a pipeline word", () => {
    expect(tileReason({ state: "failed", reason: null })).toBe("Couldn't read this file");
    expect(tileReason({ state: "failed", reason: "Not uploaded" })).toBe("Not uploaded");
    expect(tileReason({ state: "held", reason: null })).toBe("Held for a privacy check");
    for (const s of ["failed", "held", "deleted"] as const) expect(tileReason({ state: s, reason: null })).not.toMatch(/Checking|Ready|In the Studio|Kept in Sources|Preparing/);
  });

  it("more than 8 tiles fold into +N that expands", () => {
    const t = Array.from({ length: 35 }, (_, i) => i);
    expect(visibleTiles(t.slice(0, MAX_TILES), false)).toEqual({ shown: t.slice(0, MAX_TILES), more: 0 });
    const folded = visibleTiles(t, false);
    expect(folded.shown.length + folded.more).toBe(35);
    expect(folded.shown.length + 1).toBe(MAX_TILES);
    expect(visibleTiles(t, true)).toEqual({ shown: t, more: 0 });
  });
});
