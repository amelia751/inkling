import { afterEach, describe, expect, it, vi } from "vitest";
import { dropTimeline, resetTimeline } from "@/studio/lib/drop-timeline";
import { useUploads, type TraySession } from "@/studio/stores/uploads";
import { dropFiles } from "./drop-adapter";

const file = (name: string) => ({ relPath: name, file: new File(["x"], name) });

describe("drop adapter (todo13 entry → today's uploader)", () => {
  afterEach(() => resetTimeline());
  it("hands the files to the uploader and marks the upload on the timeline", async () => {
    let session: TraySession | undefined;
    const add = vi.fn((projectId: string) => {
      session = { key: "upload-x", projectId, title: "2 files", phase: "attesting", total: 2, prepared: 0, skippedJunk: 0, files: [] };
      useUploads.setState({ sessions: [session] });
      return new Promise<TraySession | undefined>(() => undefined);
    });
    useUploads.setState({ add } as never);
    void dropFiles({ projectId: "p1", picked: { files: [file("a.png"), file("b.png")], skipped: 0 }, origin: "home", taskId: "t1" });
    expect(add).toHaveBeenCalledWith("p1", expect.objectContaining({ files: expect.any(Array) }), expect.objectContaining({ taskId: "t1" }));
    const files = [{ clientFileId: "f0", relPath: "a.png", size: 1, received: 1, state: "uploaded" as const, reason: null }];
    useUploads.setState({ sessions: [{ ...session!, phase: "uploading", files }] });
    useUploads.setState({ sessions: [{ ...session!, phase: "checking", files }] });
    expect(dropTimeline().steps.map((s) => s.step)).toEqual(["gesture", "upload-start", "first-file-uploaded", "upload-done"]);
  });
});
