import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUploads, type TrayFile, type TraySession } from "@/studio/stores/uploads";
import { uploadGate, usePendingAsk, usePendingAsks, withUploadNote } from "./pending-ask";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (relPath: string, state: TrayFile["state"]): TrayFile => ({ clientFileId: relPath, relPath, size: 1, received: 0, state, reason: null });
const session = (p: Partial<TraySession>): TraySession => ({ key: "upload-1", projectId: "p1", title: "x", phase: "uploading", total: 3, prepared: 3, skippedJunk: 0, files: [], ...p });

describe("todo24 D2: uploadGate", () => {
  it("holds while bytes move or the kernel checks them", () => {
    for (const phase of ["attesting", "preparing", "uploading", "checking"] as const) expect(uploadGate(session({ phase })).ready).toBe(false);
    // absorb's moment between registering and uploading is not a failure.
    expect(uploadGate(session({ phase: "failed" })).ready).toBe(false);
  });

  it("goes when done, failed, cancelled, stalled or gone", () => {
    expect(uploadGate(session({ phase: "done", files: [file("a.jpg", "uploaded")] }))).toEqual({ ready: true, note: "" });
    expect(uploadGate(session({ phase: "failed", error: "Upload interrupted" })).ready).toBe(true);
    expect(uploadGate(session({ phase: "cancelled" })).ready).toBe(true);
    expect(uploadGate(session({ phase: "checking", stalled: true })).ready).toBe(true);
    expect(uploadGate(undefined)).toEqual({ ready: true, note: "" });
  });

  it("names what didn't upload by count and extension, never by name", () => {
    const g = uploadGate(session({ phase: "done", total: 4, files: [file("a.jpg", "uploaded"), file("pat/b.AVI", "failed"), file("c.avi", "pending"), file("d.svs", "rejected")] }));
    expect(g.note).toBe("(3 of 4 files didn't upload: 2 .avi, 1 .svs.)");
    expect(g.note).not.toContain("pat");
    expect(uploadGate(session({ phase: "cancelled", total: 2 })).note).toBe("(None of the 2 files uploaded.)");
    expect(withUploadNote("Label these", g.note)).toBe(`Label these\n\n${g.note}`);
    expect(withUploadNote("Label these", "")).toBe("Label these");
  });
});

describe("todo24 D2: the queued message waits for its upload", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const sent: string[] = [];
  const Probe = () => {
    usePendingAsk("p1", (t) => sent.push(t));
    return null;
  };

  beforeEach(() => {
    sessionStorage.clear();
    sent.length = 0;
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    useUploads.setState({ sessions: [] });
  });

  it("sends only once the session stops moving, with the failures named", () => {
    useUploads.setState({ sessions: [session({ phase: "uploading", total: 2 })] });
    usePendingAsks.getState().queue("p1", "Label these", undefined, { key: "upload-1" });
    act(() => root.render(createElement(Probe)));
    expect(sent).toEqual([]);
    act(() => useUploads.setState({ sessions: [session({ phase: "checking", total: 2 })] }));
    expect(sent).toEqual([]);
    act(() => useUploads.setState({ sessions: [session({ phase: "done", total: 2, files: [file("a.jpg", "uploaded"), file("b.avi", "failed")] })] }));
    expect(sent).toEqual(["Label these\n\n(1 of 2 files didn't upload: 1 .avi.)"]);
    act(() => useUploads.setState({ sessions: [] }));
    expect(sent).toHaveLength(1);
  });

  it("a message without an upload goes at once", () => {
    usePendingAsks.getState().queue("p1", "Hello");
    act(() => root.render(createElement(Probe)));
    expect(sent).toEqual(["Hello"]);
  });
});
