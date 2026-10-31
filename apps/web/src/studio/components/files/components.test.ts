import { act, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsConflict, SourceNode, TrashItem } from "@studio/contracts/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { TooltipProvider } from "@studio/ui/ui/tooltip";
import { ConflictDialog } from "./conflict-dialog";
import { FilesMenuItems, menuItems } from "./files-menus";
import { RenameableTitle } from "./inspector-sections";
import { MoveDialog } from "./move-dialog";
import { PathBar } from "./path-bar";
import { SelectionBar } from "./selection-bar";
import { TrashView } from "./trash-view";
import { ReorgDiff } from "./reorg-diff";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lacks these; Radix and the list call them.
Element.prototype.scrollIntoView ??= function () {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function render(el: ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(MemoryRouter, null, h(TooltipProvider, null, el))));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
});
const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const tid = (id: string) => $(`[data-testid="${id}"]`);
const key = async (el: Element, k: string, opts: KeyboardEventInit = {}) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts })));
const click = async (el: Element) => act(async () => void (el as HTMLElement).click());

const folder = (id: string, name: string, extra: Partial<SourceNode> = {}): SourceNode => ({
  id,
  sourceId: "s",
  parentId: null,
  name,
  kind: "folder",
  detectedKind: "folder",
  size: null,
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

describe("MoveDialog", () => {
  it("lists folders, opens with Enter, goes up with Backspace, and explains a refused target", async () => {
    const tree: Record<string, SourceNode[]> = { root: [folder("mri", "MRI"), folder("ct", "CT"), { ...folder("f", "a.csv"), kind: "file" }], mri: [folder("p2", "patient_002")] };
    const loadFolders = vi.fn(async (id: string) => tree[id] ?? []);
    const onConfirm = vi.fn();
    await render(
      h(MoveDialog, {
        open: true,
        onOpenChange: () => {},
        mode: "move",
        itemCount: 3,
        root: { id: "root", name: "Files" },
        loadFolders,
        validate: (id) => (id === "root" ? "They're already here" : null),
        onConfirm,
      }),
    );
    expect(tid("move-dialog")?.textContent).toContain("Move 3 items to…");
    expect($$('[data-testid="move-dialog-folder"]').map((e) => e.textContent)).toEqual(["CT", "MRI"]);
    expect(tid("move-dialog-reason")?.textContent).toBe("They're already here");
    expect(tid("move-dialog-confirm")?.getAttribute("aria-disabled")).toBe("true");

    const list = tid("move-dialog-list")!;
    expect(document.activeElement).toBe(list);
    await key(list, "ArrowDown");
    await key(list, "Enter");
    expect(loadFolders).toHaveBeenLastCalledWith("mri");
    expect($$('[data-testid="move-dialog-crumb"]').map((e) => e.textContent)).toEqual(["Files", "MRI"]);
    expect(tid("move-dialog-confirm")?.getAttribute("aria-disabled")).toBeNull();
    await key(list, "Enter", { metaKey: true });
    expect(onConfirm).toHaveBeenCalledWith("mri");

    await key(list, "Backspace");
    expect($$('[data-testid="move-dialog-crumb"]').map((e) => e.textContent)).toEqual(["Files"]);
    // Coming back up, the folder we left is the active row.
    expect($('[role="option"][aria-selected="true"]')?.textContent).toBe("MRI");
  });

  it("copy mode words, and a locked folder can't take items", async () => {
    await render(h(MoveDialog, { open: true, onOpenChange: () => {}, mode: "copy", itemCount: 1, itemName: "scan.dcm", root: { id: "root", name: "Files" }, initialPath: [{ id: "seed", name: "Sample", locked: true }], loadFolders: async () => [], onConfirm: () => {} }));
    expect(tid("move-dialog")?.textContent).toContain("Copy “scan.dcm” to…");
    expect(tid("move-dialog-confirm")?.textContent).toBe("Copy here");
    expect(tid("move-dialog-reason")?.textContent).toContain("Sample data can't be changed");
  });
});

describe("ConflictDialog", () => {
  it("applies one choice to the other conflicts and reports identical skips", async () => {
    const c = (id: string, identical = false): FsConflict => ({ nodeId: id, name: `${id}.dcm`, parentId: "p", parentName: "MRI", existingId: "x", kind: "file", identical });
    const onDone = vi.fn();
    await render(h(ConflictDialog, { open: true, conflicts: [c("a"), c("b"), c("c"), c("d", true)], onDone, onCancel: () => {} }));
    expect(tid("conflict-message")?.textContent).toBe("An item named “a.dcm” already exists in MRI.");
    expect(tid("conflict-identical")?.textContent).toBe("1 identical file skipped");
    expect(tid("conflict-dialog")?.textContent).toContain("Do this for the other 2 conflicts");
    await click(tid("conflict-apply-all")!);
    await click(tid("conflict-keep-both")!);
    expect(onDone).toHaveBeenCalledWith({ a: "keep_both", b: "keep_both", c: "keep_both", d: "skip" });
  });
});

describe("SelectionBar", () => {
  it("says how many are selected and keeps disabled actions focusable with a reason", async () => {
    const onTrash = vi.fn();
    await render(h(SelectionBar, { count: 3, onMove: () => {}, onCopy: () => {}, onDownload: () => {}, onStar: () => {}, onTrash, onClear: () => {}, disabled: { trash: "Sample data can't be changed. Copy it to make your own" } }));
    expect(tid("selection-count")?.textContent).toBe("3 selected");
    const trash = tid("selection-trash")!;
    expect(trash.getAttribute("aria-disabled")).toBe("true");
    await click(trash);
    expect(onTrash).not.toHaveBeenCalled();
  });
});

describe("TrashView", () => {
  it("empty state, and rows with restore", async () => {
    await render(h(TrashView, { items: [], total: 0, selectedIds: [], onSelectionChange: () => {}, onRestore: () => {}, onDeleteForever: () => {}, onEmptyTrash: () => {} }));
    expect(tid("trash-empty-state")).not.toBeNull();
    expect(tid("trash-banner")?.textContent).toContain("Items in Trash are deleted after 30 days.");
  });

  it("restores a row", async () => {
    const item: TrashItem = { ...folder("t1", "old scans"), trashedAt: new Date().toISOString(), trashedBy: "Lam", originalLocation: "MRI", purgeInDays: 29 };
    const onRestore = vi.fn();
    await render(h(TrashView, { items: [item], total: 1, selectedIds: [], onSelectionChange: () => {}, onRestore, onDeleteForever: () => {}, onEmptyTrash: () => {} }));
    await click(tid("trash-restore")!);
    expect(onRestore).toHaveBeenCalledWith(["t1"]);
  });
});

describe("RenameableTitle", () => {
  it("selects the stem, shows a live error, saves on Enter", async () => {
    const onRename = vi.fn();
    await render(h(RenameableTitle, { name: "scan001.dcm", kind: "file", validate: (n) => (n === "taken.dcm" ? "A file named taken.dcm is already here" : null), onRename }));
    await click(tid("inspector-rename")!);
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const input = tid("inspector-rename-input") as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 7]);
    const setValue = async (v: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await setValue("taken.dcm");
    expect(tid("rename-error")?.textContent).toBe("A file named taken.dcm is already here");
    await setValue("scan002.dcm");
    expect(tid("rename-error")).toBeNull();
    await key(input, "Enter");
    expect(onRename).toHaveBeenCalledWith("scan002.dcm");
  });
});

describe("PathBar", () => {
  it("keeps today's test ids and collapses the middle of long paths", async () => {
    const segs = ["A", "B", "C", "D", "E", "F"].map((n) => ({ id: n.toLowerCase(), name: n }));
    await render(h(PathBar, { rootLabel: "Files", segments: segs, hrefFor: (id) => `/f/${id ?? ""}`, onCopyPath: () => {} }));
    expect(tid("path-bar")).not.toBeNull();
    expect(tid("path-current")?.textContent).toBe("F");
    expect(tid("path-more")).not.toBeNull();
    expect(tid("path-collapsed")).not.toBeNull();
    expect($$('[data-testid="path-segment"]').map((e) => e.textContent)).toEqual(["A", "E"]);
  });
});

describe("FilesMenuItems", () => {
  it("renders entries with their reasons inside a menu", async () => {
    await render(h(DropdownMenu, { open: true }, h(DropdownMenuTrigger, null, "menu"), h(DropdownMenuContent, null, h(FilesMenuItems, { entries: menuItems("sample", { sampleKind: "file" }), onAction: () => {}, shortcutFor: () => "" }))));
    const rename = tid("files-menu-rename")!;
    expect(rename.dataset.disabledReason).toBe("Sample data can't be changed. Copy it to make your own");
    expect(rename.closest('[role="menuitem"]')?.getAttribute("aria-disabled")).toBe("true");
    expect($$('[role="separator"]').length).toBe(1);
  });
});

describe("ReorgDiff", () => {
  it("draws both trees and applies", async () => {
    const onApply = vi.fn();
    await render(
      h(ReorgDiff, {
        tree: { id: "r", name: "MRI", kind: "folder", children: [{ id: "a", name: "a.dcm", kind: "file" }, { id: "b", name: "b.dcm", kind: "file" }] },
        ops: [
          { kind: "mkdir", id: "n1", parentId: "r", name: "patient_001", reason: "Group by patient" },
          { kind: "move", nodeIds: ["a"], parentId: "n1", reason: "Patient 1" },
        ],
        onApply,
        onDismiss: () => {},
      }),
    );
    expect(tid("reorg-counts")?.textContent).toBe("1 new folder · 1 move");
    expect($$('[data-testid="reorg-after"] [data-change="new"]').length).toBe(1);
    expect($$('[data-testid="reorg-before"] [data-change="moved"]').length).toBe(1);
    await click(tid("reorg-apply")!);
    expect(onApply).toHaveBeenCalled();
  });
});
