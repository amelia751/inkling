import { describe, expect, it } from "vitest";
import type { TrayFile, TraySession } from "@/studio/stores/uploads";
import { chatUploadsGate } from "./chat-uploads";

const file = (relPath: string, state: TrayFile["state"]): TrayFile => ({ clientFileId: relPath, relPath, size: 1, received: 0, state, reason: null });
const session = (p: Partial<TraySession>): TraySession => ({ key: "upload-1", projectId: "p1", title: "x", phase: "uploading", total: 2, prepared: 2, skippedJunk: 0, files: [], ...p });

describe("chatUploadsGate", () => {
  it("waits while any upload still moves", () => {
    expect(chatUploadsGate([session({ phase: "done", files: [file("a.png", "uploaded")] }), session({ phase: "uploading" })]).ready).toBe(false);
  });

  it("says what arrived and what didn't, by count and extension only", () => {
    const g = chatUploadsGate([
      session({ phase: "done", files: [file("scans/a.png", "uploaded"), file("b.PNG", "skipped_duplicate")] }),
      session({ phase: "done", total: 2, files: [file("ecg.csv", "uploaded"), file("bad.xyz", "rejected")] }),
    ]);
    expect(g.ready).toBe(true);
    expect(g.note).toBe("(Attached 3 files, now in Sources: 2 .png, 1 .csv.)\n(1 of 2 files didn't upload: 1 .xyz.)");
    expect(g.note).not.toContain("scans");
  });

  it("todo28 D8: goes once uploads land, with how many are still being checked", () => {
    const g = chatUploadsGate([session({ phase: "checking", total: 2, files: [file("a.png", "uploaded"), file("b.png", "uploaded")] })]);
    expect(g).toEqual({ ready: true, note: "(Attached 2 files, now in Sources: 2 .png.)\n(2 files still being checked)" });
  });

  it("goes with no note when the uploads were dismissed", () => {
    expect(chatUploadsGate([undefined])).toEqual({ ready: true, note: "" });
  });
});
