import { describe, expect, it } from "vitest";
import { menuItems, NEEDS_FULL_STACK, SAMPLE_LOCKED, type FilesMenuAction, type MenuEntry } from "./files-menus";

const ids = (es: MenuEntry[]) => es.map((e) => e.id);
const get = (es: MenuEntry[], id: FilesMenuAction) => {
  const e = es.find((x) => x.id === id);
  if (!e) throw new Error(`no ${id} in ${ids(es).join(", ")}`);
  return e;
};
/** Ids per group, in order: the separators of the spec's tables. */
const groups = (es: MenuEntry[]) => {
  const out: FilesMenuAction[][] = [];
  es.forEach((e, i) => (i === 0 || es[i - 1].group !== e.group ? out.push([e.id]) : out.at(-1)!.push(e.id)));
  return out;
};

describe("menuItems", () => {
  it("folder: the spec's four groups, in order", () => {
    expect(groups(menuItems("folder"))).toEqual([
      ["open", "newFolder", "uploadFiles", "uploadFolder"],
      ["rename", "moveTo", "duplicate", "cut", "copy", "paste"],
      ["star", "downloadZip", "copyPath", "showInExplore"],
      ["trash"],
    ]);
  });

  it("file: Open in Studio only when a task uses it", () => {
    expect(ids(menuItems("file"))).not.toContain("openInStudio");
    expect(groups(menuItems("file", { usedInTask: true }))[0]).toEqual(["open", "quickLook", "openInStudio"]);
    expect(groups(menuItems("file"))[2]).toEqual(["star", "download", "replaceVersion", "versionHistory", "copyPath"]);
  });

  it("paste names how many items the clipboard holds, and is disabled when empty", () => {
    expect(get(menuItems("folder", { clipboardCount: 3 }), "paste")).toMatchObject({ label: "Paste (3 items)", disabled: null });
    expect(get(menuItems("folder", { clipboardCount: 1 }), "paste").label).toBe("Paste (1 item)");
    expect(get(menuItems("folder"), "paste")).toMatchObject({ label: "Paste", disabled: "Nothing to paste" });
  });

  it("several selected: paste appears only when the clipboard has something", () => {
    expect(ids(menuItems("multi", { selectionCount: 3 }))).not.toContain("paste");
    expect(get(menuItems("multi", { selectionCount: 3, clipboardCount: 2 }), "paste").label).toBe("Paste (2 items)");
    expect(get(menuItems("multi", { selectionCount: 3 }), "moveTo").label).toBe("Move 3 items to…");
  });

  it("locked rows get the Sample menu: edit items shown disabled with the reason", () => {
    for (const es of [menuItems("sample"), menuItems("folder", { locked: true }), menuItems("file", { locked: true })]) {
      for (const id of ["rename", "moveTo", "cut", "trash"] as const) expect(get(es, id).disabled).toBe(SAMPLE_LOCKED);
      for (const id of ["open", "copyTo", "copyPath"] as const) expect(get(es, id).disabled ?? null).toBeNull();
      expect(SAMPLE_LOCKED).toBe("Sample data can't be changed. Copy it to make your own");
    }
    expect(ids(menuItems("file", { locked: true }))).toContain("download");
    expect(ids(menuItems("folder", { locked: true }))).toContain("downloadZip");
  });

  it("read-only namespace: edits say 'Needs the full stack', reads stay enabled", () => {
    const es = menuItems("folder", { writable: false, clipboardCount: 2 });
    for (const id of ["newFolder", "rename", "moveTo", "duplicate", "cut", "paste", "trash"] as const) expect(get(es, id).disabled).toBe(NEEDS_FULL_STACK);
    for (const id of ["open", "copy", "star", "downloadZip", "copyPath"] as const) expect(get(es, id).disabled ?? null).toBeNull();
    expect(get(menuItems("trash", { writable: false }), "restore").disabled).toBe(NEEDS_FULL_STACK);
  });

  it("the root folder can't be renamed, moved or trashed", () => {
    const es = menuItems("folder", { isRoot: true });
    for (const id of ["rename", "moveTo", "cut", "trash"] as const) expect(get(es, id).disabled).toBeTruthy();
    expect(get(es, "newFolder").disabled ?? null).toBeNull();
  });

  it("numbered run and trash item", () => {
    expect(get(menuItems("run", { runCount: 120 }), "selectAll").label).toBe("Select all 120 files");
    expect(groups(menuItems("run"))).toEqual([["open", "selectAll"], ["moveTo", "cut", "copy", "downloadZip"], ["trash"]]);
    expect(groups(menuItems("trash"))).toEqual([["restore"], ["deleteForever"]]);
  });

  it("star toggles to 'Remove from Starred'", () => {
    expect(ids(menuItems("file", { starred: true }))).toContain("unstar");
    expect(ids(menuItems("file", { starred: true }))).not.toContain("star");
  });

  it("shortcuts come from command names", () => {
    const es = menuItems("file");
    expect(get(es, "rename").command).toBe("rename");
    expect(get(es, "trash").command).toBe("moveToTrash");
    expect(get(es, "copyPath").command).toBeUndefined();
  });
});
