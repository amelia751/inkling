import { describe, expect, it } from "vitest";
import type { SourceNode } from "@studio/contracts/types";
import { extensionChange, stemRange, summarize } from "./inspector-sections";

const node = (over: Partial<SourceNode>): SourceNode => ({
  id: "n",
  sourceId: "s",
  parentId: null,
  name: "x",
  kind: "file",
  detectedKind: null,
  size: null,
  sha256: null,
  childCount: 0,
  descendantCount: 0,
  facts: {},
  flags: {},
  status: "ready",
  importSessionId: null,
  createdAt: null,
  ...over,
});

describe("rename helpers", () => {
  it("selects the stem of a file, all of a folder", () => {
    expect(stemRange("scan001.dcm", "file")).toEqual([0, 7]);
    expect(stemRange("brain.nii.gz", "file")).toEqual([0, 5]);
    expect(stemRange(".env", "file")).toEqual([0, 4]);
    expect(stemRange("v1.2 exports", "folder")).toEqual([0, 12]);
  });

  it("notices an extension change on files only", () => {
    expect(extensionChange("a.dcm", "b.dcm", "file")).toBeNull();
    expect(extensionChange("a.dcm", "a.DCM", "file")).toBeNull();
    expect(extensionChange("a.dcm", "a.txt", "file")).toEqual({ from: ".dcm", to: ".txt" });
    expect(extensionChange("a.dcm", "a", "file")).toEqual({ from: ".dcm", to: "" });
    expect(extensionChange("MRI.v1", "MRI.v2", "folder")).toBeNull();
  });
});

describe("summarize", () => {
  it("counts items, bytes (folder totals) and kinds", () => {
    const s = summarize([
      node({ name: "a.dcm", size: 1000, detectedKind: "dicom" }),
      node({ name: "b.dcm", size: 500, detectedKind: "dicom" }),
      node({ name: "t.csv", size: 10 }),
      node({ name: "MRI", kind: "folder", totalBytes: 2000 }),
    ]);
    expect(s).toEqual({ count: 4, bytes: 3510, kinds: 3 });
  });
});
