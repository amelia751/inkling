import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { filesKeys } from "./api";
import { beginLocalOp, resetGuard } from "./guard";
import { actorName, applyFsChanged, isOwnEvent, noticeText, noticesFor, type FsChangedEvent } from "./live";
import { useTabUndo } from "./undo";

const ev = (over: Partial<FsChangedEvent> = {}): FsChangedEvent => ({ projectId: "p", parentIds: ["f1"], batchId: "b1", actor: "user:lam", summary: "Moved 2 items to MRI", ...over });

describe("live sync (fs.changed)", () => {
  beforeEach(() => {
    resetGuard();
    useTabUndo.getState().clear();
  });

  it("invalidates only the changed folders' children (every sort)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyFsChanged(qc, ev({ parentIds: ["f1", "f2"], nodeIds: ["n1"] }));
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(filesKeys.children("p", "f1")));
    expect(keys).toContain(JSON.stringify(filesKeys.children("p", "f2")));
    expect(keys).toContain(JSON.stringify(["source-nodes", "n1"]));
    expect(keys).not.toContain(JSON.stringify(filesKeys.childrenAll("p")));
  });

  it("recognises this tab's own batches and folders it's changing", () => {
    expect(isOwnEvent(ev())).toBe(false);
    useTabUndo.getState().record({ batchId: "b1", projectId: "p", label: "x" });
    expect(isOwnEvent(ev())).toBe(true);
    const settle = beginLocalOp("p", ["f9"]);
    expect(isOwnEvent(ev({ batchId: "b2", parentIds: ["f9"] }))).toBe(true);
    settle();
    expect(isOwnEvent(ev({ batchId: "b2", parentIds: ["f9"] }))).toBe(false);
    expect(isOwnEvent(ev({ batchId: "b3" }), { self: "user:lam" })).toBe(true);
  });

  it("says who did what", () => {
    expect(actorName("user:lam")).toBe("Lam");
    expect(actorName("system:seed")).toBe("Sample data");
    expect(noticeText("user:lam", "Moved 2 items to MRI")).toBe("Lam moved 2 items to MRI");
    const n = [{ id: "1", batchId: "b", actor: "a", text: "t", parentIds: ["f1"], at: 0 }];
    expect(noticesFor(n, "f1")).toHaveLength(1);
    expect(noticesFor(n, "f2")).toHaveLength(0);
  });
});
