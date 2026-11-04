import { describe, expect, it } from "vitest";
import type { Drop } from "@studio/contracts/drops";
import { chipsOf } from "./hooks";
import { pastedFiles } from "./start";
import type { LocalDrop } from "./store";

const local: LocalDrop = { id: "drp-0123456789ab", projectId: "prj-1", origin: "chat", conversationId: "conv-1", files: [{ relPath: "a.png", size: 100, preview: "blob:a" }, { relPath: "b.dcm", size: 50 }], uploadKeys: ["upload-1"], createdAt: 1 };

const drop = (files: Partial<Drop["files"][number]>[]): Drop =>
  ({
    id: local.id,
    projectId: "prj-1",
    origin: "chat",
    conversationId: "conv-1",
    messageId: null,
    taskId: null,
    datasetId: null,
    folderNodeId: "nod-f",
    state: "uploading",
    declared: {},
    createdBy: "user:a",
    createdAt: "",
    updatedAt: "",
    importIds: ["imp-1"],
    files: files.map((f, i) => ({ clientFileId: `f${i}`, importId: "imp-1", nodeId: null, name: "x", relPath: "x", size: 1, received: 0, sha256: "", uploadState: "pending", state: "uploading", reason: null, kind: null, looksLike: null, flags: [], ...f })),
    summary: { dropId: local.id, origin: "chat", state: "uploading", total: 0, byKind: {}, bytes: 0, states: {}, groups: [], files: [] },
  }) as Drop;

describe("drop chips", () => {
  it("shows the browser's files while they hash, then their upload progress", () => {
    expect(chipsOf(local, undefined, []).map((c) => [c.name, c.state])).toEqual([
      ["a.png", "preparing"],
      ["b.dcm", "preparing"],
    ]);
    const tray = { phase: "uploading", files: [{ clientFileId: "f0", relPath: "a.png", size: 100, received: 50, state: "pending" as const, reason: null }] };
    const [a, b] = chipsOf(local, undefined, [tray]);
    expect(a).toMatchObject({ state: "uploading", progress: 0.5, preview: "blob:a" });
    expect(b!.state).toBe("preparing");
  });

  it("follows the kernel once it knows the files, with live progress and its states", () => {
    const server = drop([
      { relPath: "a.png", name: "a.png", size: 100, state: "uploading", received: 0 },
      { relPath: "b.dcm", name: "b.dcm", size: 50, state: "kept", nodeId: "nod-b", kind: "archive", looksLike: "a ZIP" },
      { relPath: "c.png", name: "c.png", size: 5, state: "duplicate", reason: "Already in Sources" },
    ]);
    const tray = { phase: "uploading", files: [{ clientFileId: "f0", relPath: "a.png", size: 100, received: 25, state: "pending" as const, reason: null }] };
    const chips = chipsOf(local, server, [tray]);
    expect(chips[0]).toMatchObject({ state: "uploading", progress: 0.25, preview: "blob:a" });
    expect(chips[1]).toMatchObject({ state: "kept", looksLike: "a ZIP", nodeId: "nod-b" });
    expect(chips[2]).toMatchObject({ state: "duplicate", reason: "Already in Sources" });
  });
});

describe("pasted files", () => {
  it("names pasted screenshots so two never collide", () => {
    const shot = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
    const named = new File([new Uint8Array([1])], "scan.png", { type: "image/png" });
    const [a, b, c] = pastedFiles([shot, shot, named]);
    expect(a!.name).toMatch(/^Screenshot \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
    expect(b!.name).toMatch(/\(2\)\.png$/);
    expect(c!.name).toBe("scan.png");
  });
});

describe("an interrupted drop (failed before the kernel had its files)", () => {
  it("says Not uploaded on every file, never Preparing, when the drop failed", async () => {
    const { dropInterrupted } = await import("./hooks");
    const failed = { ...local, error: "Failed to fetch", uploadKeys: [] };
    expect(dropInterrupted(failed, undefined, [])).toBe(true);
    expect(chipsOf(failed, undefined, []).map((c) => [c.state, c.reason])).toEqual([
      ["failed", "Not uploaded"],
      ["failed", "Not uploaded"],
    ]);
  });
  it("after a reload, once the kernel answered with nothing (the File handles are gone)", async () => {
    const { dropInterrupted } = await import("./hooks");
    const restored = { ...local, uploadKeys: [], restored: true };
    expect(dropInterrupted(restored, undefined, [], true)).toBe(false); // still loading: no flash
    expect(chipsOf(restored, undefined, [], true)[0]!.state).toBe("preparing");
    expect(dropInterrupted(restored, undefined, [])).toBe(true);
    expect(chipsOf(restored, drop([]), [])[0]).toMatchObject({ state: "failed", reason: "Not uploaded" });
    // The kernel has its files: the kernel's states (and "Upload paused"), not "interrupted".
    expect(dropInterrupted(restored, drop([{ relPath: "a.png", state: "uploading" }]), [])).toBe(false);
  });
  it("when every upload session of it failed or was cancelled", async () => {
    const { dropInterrupted } = await import("./hooks");
    expect(dropInterrupted(local, undefined, [{ phase: "failed", files: [] }])).toBe(true);
    expect(dropInterrupted(local, undefined, [{ phase: "preparing", files: [] }])).toBe(false);
  });
  it("not while a fresh drop is still being created", async () => {
    const { dropInterrupted } = await import("./hooks");
    expect(dropInterrupted({ ...local, uploadKeys: [] }, undefined, [])).toBe(false);
  });
});

describe("failed upload sessions in words", () => {
  it("turn a network error into a plain headline and their files into Not uploaded", async () => {
    const { failureText, notUploaded, trayLine } = await import("@/studio/stores/uploads");
    const { fileRowText } = await import("@/studio/components/uploads/uploads");
    expect(failureText("Failed to fetch", [])).toBe("Upload interrupted. Nothing was saved.");
    expect(failureText("Load failed", [{ state: "uploaded" }])).toBe("Upload interrupted. Some files were saved.");
    expect(failureText("A drop holds at most 10,000 files", [])).toBe("A drop holds at most 10,000 files");
    const files = notUploaded([{ relPath: "a.png", size: 3 }]);
    expect(files[0]).toMatchObject({ state: "failed", reason: "Not uploaded" });
    const s = { key: "u", projectId: "p", title: "35 files", phase: "failed" as const, total: 35, prepared: 0, skippedJunk: 0, files, error: "Failed to fetch" };
    expect(trayLine(s)).toBe("Upload interrupted. Nothing was saved.");
    expect(fileRowText(s, { state: "pending", reason: null })).toBe("Not uploaded");
    expect(fileRowText({ phase: "uploading" }, { state: "pending", reason: null })).toBe("Waiting");
  });
});
