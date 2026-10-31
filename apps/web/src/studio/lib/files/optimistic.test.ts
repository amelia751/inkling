import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ChildrenPage, SourceNode } from "@studio/contracts/types";
import { ApiError } from "@/studio/lib/projects-api";
import { applyOptimistic, filesKeys, FsConflictApiError, LockedError, rollback, toFsError } from "./api";
import { hasPendingOp, resetGuard } from "./guard";
import { COPY_PREFIX, compareNodes, foldersTouched, insertSorted, patchFolder, rowsOf, type ChildrenData } from "./optimistic";
import { dropVerdict, type FsDragItem } from "./dnd";

const node = (id: string, name: string, parentId: string, kind: SourceNode["kind"] = "file", extra: Partial<SourceNode> = {}): SourceNode => ({
  id,
  sourceId: "src",
  parentId,
  name,
  kind,
  detectedKind: null,
  size: 1,
  sha256: null,
  childCount: 0,
  descendantCount: 0,
  facts: {},
  flags: {},
  status: "ready",
  importSessionId: null,
  createdAt: null,
  ...extra,
});

const data = (items: SourceNode[], nextCursor: string | null = null): ChildrenData => ({ pages: [{ items, total: items.length, nextCursor } as ChildrenPage], pageParams: [null] });
const names = (d: ChildrenData | undefined) => rowsOf(d).map((x) => x.name);

describe("optimistic patches of children pages (kiwifs applyOptimisticTreeMove)", () => {
  const a = data([node("f1", "MRI", "root", "folder"), node("x1", "scan2.dcm", "root"), node("x2", "scan10.dcm", "root")]);
  const lookup = (id: string) => rowsOf(a).find((x) => x.id === id);

  it("sorts folders first, naturally", () => {
    expect(compareNodes(node("1", "b", "r", "folder"), node("2", "a", "r"))).toBeLessThan(0);
    expect(compareNodes(node("1", "scan2", "r"), node("2", "scan10", "r"))).toBeLessThan(0);
    expect(compareNodes(node("1", "scan2", "r"), node("2", "scan10", "r"), { by: "name", dir: "desc" })).toBeGreaterThan(0);
  });

  it("inserts a new folder at its place; never past an unloaded page", () => {
    const out = patchFolder("root", a, [{ kind: "mkdir", parentId: "root", name: "Untitled folder", id: "nod-new" }], lookup);
    expect(names(out)).toEqual(["MRI", "Untitled folder", "scan2.dcm", "scan10.dcm"]);
    expect(out.pages[0].total).toBe(4);
    expect(rowsOf(out)[1]).toMatchObject({ id: "nod-new", kind: "folder", parentId: "root" });
    const paged = insertSorted(data([node("x1", "a.dcm", "root")], "c2"), node("z", "zz.dcm", "root"));
    expect(names(paged)).toEqual(["a.dcm"]);
    expect(paged.pages[0].total).toBe(2);
  });

  it("renames in place and re-sorts", () => {
    const out = patchFolder("root", a, [{ kind: "rename", nodeId: "x2", name: "scan1.dcm" }], lookup);
    expect(names(out)).toEqual(["MRI", "scan1.dcm", "scan2.dcm"]);
  });

  it("moves out of one folder and into another", () => {
    const move = [{ kind: "move" as const, nodeIds: ["x1", "x2"], parentId: "f1" }];
    expect(names(patchFolder("root", a, move, lookup))).toEqual(["MRI"]);
    const into = patchFolder("f1", data([node("y", "b.dcm", "f1")]), move, lookup);
    expect(names(into)).toEqual(["b.dcm", "scan2.dcm", "scan10.dcm"]);
    expect(rowsOf(into).every((x) => x.parentId === "f1")).toBe(true);
    expect(into.pages[0].total).toBe(3);
  });

  it("copies with temporary ids; trash hides", () => {
    const copied = patchFolder("f1", data([]), [{ kind: "copy", nodeIds: ["x1"], parentId: "f1" }], lookup);
    expect(rowsOf(copied)[0].id).toBe(`${COPY_PREFIX}x1`);
    expect(names(patchFolder("root", a, [{ kind: "trash", nodeIds: ["f1"] }], lookup))).toEqual(["scan2.dcm", "scan10.dcm"]);
  });

  it("leaves untouched folders as the same object", () => {
    expect(patchFolder("other", a, [{ kind: "rename", nodeId: "zzz", name: "q" }], lookup)).toBe(a);
  });

  it("knows which folders a batch touches", () => {
    const parentOf = (id: string) => ({ x1: "root", x2: "root", y: "f1" })[id];
    expect(foldersTouched([{ kind: "move", nodeIds: ["x1", "y"], parentId: "f2" }], parentOf).sort()).toEqual(["f1", "f2", "root"]);
    expect(foldersTouched([{ kind: "rename", nodeId: "y", name: "n" }], parentOf)).toEqual(["f1"]);
  });
});

describe("applyOptimistic / rollback on the React Query cache", () => {
  let qc: QueryClient;
  beforeEach(() => {
    resetGuard();
    qc = new QueryClient();
    qc.setQueryData(filesKeys.children("p", "root", { by: "name", dir: "asc" }), data([node("f1", "MRI", "root", "folder"), node("x1", "scan.dcm", "root")]));
    qc.setQueryData(filesKeys.children("p", "root", { by: "size", dir: "desc" }), data([node("x1", "scan.dcm", "root"), node("f1", "MRI", "root", "folder")]));
    qc.setQueryData(filesKeys.children("p", "f1", { by: "name", dir: "asc" }), data([]));
  });
  afterEach(() => qc.clear());

  it("patches every sort of the touched folders, marks them pending, and rolls back exactly", async () => {
    const before = qc.getQueriesData({ queryKey: filesKeys.childrenAll("p") });
    const ctx = await applyOptimistic(qc, "p", [{ kind: "move", nodeIds: ["x1"], parentId: "f1" }]);
    expect(ctx.folders.sort()).toEqual(["f1", "root"]);
    expect(names(qc.getQueryData(filesKeys.children("p", "root", { by: "name", dir: "asc" })))).toEqual(["MRI"]);
    expect(names(qc.getQueryData(filesKeys.children("p", "root", { by: "size", dir: "desc" })))).toEqual(["MRI"]);
    expect(names(qc.getQueryData(filesKeys.children("p", "f1", { by: "name", dir: "asc" })))).toEqual(["scan.dcm"]);
    expect(hasPendingOp("p", "root")).toBe(true);
    rollback(qc, ctx);
    ctx.settle();
    expect(qc.getQueriesData({ queryKey: filesKeys.childrenAll("p") })).toEqual(before);
    expect(hasPendingOp("p", "root")).toBe(false);
  });

  it("renames the inspector's detail too", async () => {
    qc.setQueryData(["source-nodes", "x1"], { ...node("x1", "scan.dcm", "root"), path: [] });
    const ctx = await applyOptimistic(qc, "p", [{ kind: "rename", nodeId: "x1", name: "case.dcm" }]);
    expect(qc.getQueryData<SourceNode>(["source-nodes", "x1"])?.name).toBe("case.dcm");
    rollback(qc, ctx);
    expect(qc.getQueryData<SourceNode>(["source-nodes", "x1"])?.name).toBe("scan.dcm");
  });

  it("cancels in-flight loads of the touched folders", async () => {
    const cancel = vi.spyOn(qc, "cancelQueries");
    await applyOptimistic(qc, "p", [{ kind: "mkdir", parentId: "f1", name: "New" }]);
    expect(cancel).toHaveBeenCalledWith({ queryKey: filesKeys.children("p", "f1") });
  });
});

describe("typed errors", () => {
  it("parses 409 conflicts and 423 locks", () => {
    const conflict = { nodeId: "x1", name: "scan.dcm", parentId: "f1", parentName: "MRI", existingId: "x9", kind: "file", identical: false };
    const e = toFsError(new ApiError(409, "1 conflict", { detail: { message: "An item named “scan.dcm” already exists in MRI.", conflicts: [conflict] } }));
    expect(e).toBeInstanceOf(FsConflictApiError);
    expect((e as FsConflictApiError).conflicts).toEqual([conflict]);
    expect((e as FsConflictApiError).message).toMatch(/already exists/);
    expect(toFsError(new ApiError(423, "Sample data can't be changed. Copy it to make your own"))).toBeInstanceOf(LockedError);
    const refused = toFsError(new ApiError(409, "Can't undo: patient_002 changed after that", { detail: "Can't undo: patient_002 changed after that" }));
    expect(refused).not.toBeInstanceOf(FsConflictApiError);
    expect((refused as ApiError).status).toBe(409);
  });
});

describe("drop rules", () => {
  const item = (id: string, kind: FsDragItem["kind"] = "file", parentId = "root", locked = false): FsDragItem => ({ id, name: id, kind, parentId, locked });
  it("refuses with a reason", () => {
    expect(dropVerdict([item("f", "folder")], { id: "f" })).toMatch(/into itself/);
    expect(dropVerdict([item("f", "folder")], { id: "sub", ancestors: ["root", "f"] })).toMatch(/its own folders/);
    expect(dropVerdict([item("a")], { id: "t", trash: true })).toMatch(/Move to Trash/);
    expect(dropVerdict([item("a")], { id: "s", locked: true })).toMatch(/Sample data/);
    expect(dropVerdict([item("a", "file", "root", true)], { id: "mine" })).toMatch(/Hold ⌥/);
    expect(dropVerdict([item("a", "file", "root", true)], { id: "mine" }, { copy: true })).toBe(true);
    expect(dropVerdict([item("a", "file", "mine")], { id: "mine" })).toMatch(/Already/);
    expect(dropVerdict([item("a")], { id: "mine" })).toBe(true);
  });
});
