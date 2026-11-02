import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateFor, keysFor } from "./invalidate";

describe("invalidateFor (todo18 D1)", () => {
  it("fs.changed refreshes Files, Trash, Overview and Activity", () => {
    expect(keysFor("p1", "fs.changed")).toEqual(expect.arrayContaining([["files", "p1"], ["projects", "p1", "trash"], ["projects", "p1", "activity"]]));
  });
  it("undoing a turn refreshes more than Activity", () => {
    const keys = keysFor("p1", "turn.undone").map((k) => JSON.stringify(k));
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(["projects", "p1"]), JSON.stringify(["files", "p1"]), JSON.stringify(["tasks"])]));
  });
  it("trash.changed marks Studio and dataset queries stale", () => {
    const qc = new QueryClient();
    qc.setQueryData(["tasks", "t1"], { id: "t1" });
    qc.setQueryData(["datasets", "p1"], []);
    qc.setQueryData(["other"], 1);
    invalidateFor(qc, "p1", "trash.changed");
    expect(qc.getQueryState(["tasks", "t1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["datasets", "p1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["other"])?.isInvalidated).toBe(false);
  });
  it("unknown events do nothing", () => expect(keysFor("p1", "nope")).toEqual([]));
});
