import type { ComponentType, ReactNode } from "react";
import {
  AnnotateIcon,
  CopyIcon,
  CutIcon,
  DownloadIcon,
  ExploreIcon,
  FolderIcon,
  MoveIcon,
  NewFolderIcon,
  PasteIcon,
  QuickLookIcon,
  RedoIcon,
  RenameIcon,
  RestoreIcon,
  StarFillIcon,
  StarIcon,
  TrashIcon,
  UndoIcon,
  UploadIcon,
  VersionsIcon,
  type IconComponent,
} from "@studio/ui/icons";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from "@studio/ui/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from "@studio/ui/ui/dropdown-menu";
import { shortcutLabel } from "@studio/ui/shortcuts";
import { cn } from "@studio/ui/utils";

/**
 * The Files context menus (todo7 §2 Context menus) as data: `menuItems(rowType, ctx)` says what a
 * row's menu holds, in which groups, with which command's shortcut and, for an item that can't
 * run, the reason it shows. `FilesMenuItems` renders the entries with whatever menu primitives it
 * is given: DropdownMenu pieces today (the `⋯` buttons), Radix ContextMenu pieces once
 * `packages/ui/src/ui/context-menu.tsx` lands. The model knows nothing about React Query or the
 * clipboard; the caller passes what it knows in `MenuContext` and handles `onAction(id)`.
 */

export type FilesRowType = "folder" | "file" | "run" | "sample" | "trash" | "multi";

export type FilesMenuAction =
  | "open"
  | "quickLook"
  | "openInStudio"
  | "newFolder"
  | "uploadFiles"
  | "uploadFolder"
  | "rename"
  | "moveTo"
  | "copyTo"
  | "duplicate"
  | "cut"
  | "copy"
  | "paste"
  | "star"
  | "unstar"
  | "download"
  | "downloadZip"
  | "replaceVersion"
  | "versionHistory"
  | "copyPath"
  | "showInExplore"
  | "selectAll"
  | "trash"
  | "restore"
  | "deleteForever"
  | "undo"
  | "redo";

export interface MenuEntry {
  id: FilesMenuAction;
  label: string;
  icon?: IconComponent;
  /** The command whose binding is shown as the shortcut (a core command name, e.g. `rename`). */
  command?: string;
  /** Set: the item is shown disabled with this sentence under its label. */
  disabled?: string | null;
  /** Entries with different groups get a separator between them. */
  group: number;
  destructive?: boolean;
}

export interface MenuContext {
  /** The namespace accepts writes (D12). False on the seed stand-in: edit items say "Needs the full stack". */
  writable?: boolean;
  /** Sample data (D2), or inside it. A `folder`/`file` row with `locked` gets the Sample menu. */
  locked?: boolean;
  /** Is this row a folder or a file? Only for `sample` rows (folders download as a ZIP). */
  sampleKind?: "folder" | "file" | "sequence";
  starred?: boolean;
  /** How many items the clipboard holds (0 or undefined: nothing to paste). */
  clipboardCount?: number;
  /** Numbered runs: how many files the run holds ("Select all 120 files"). */
  runCount?: number;
  /** Several selected: how many. */
  selectionCount?: number;
  /** Files: a task uses this file, so "Open in Studio" is offered. */
  usedInTask?: boolean;
  /** Files: more than one version exists (Version history is offered either way; this only enables it). */
  hasVersions?: boolean;
  /** The project's root folder ("Files"): can't be renamed, moved or trashed. */
  isRoot?: boolean;
  /** Several selected: something in the selection is sample data. */
  selectionLocked?: boolean;
}

export const NEEDS_FULL_STACK = "Needs the full stack";
export const SAMPLE_LOCKED = "Sample data can't be changed. Copy it to make your own";
const ROOT_FIXED = "The project's top folder stays where it is";

/** Core command names (declared in the core manifest with `when: section == files`). */
export const FILES_COMMANDS = {
  open: "openItem",
  quickLook: "quickLook",
  newFolder: "newFolder",
  rename: "rename",
  duplicate: "duplicate",
  cut: "cut",
  copy: "copy",
  paste: "paste",
  selectAll: "selectAll",
  trash: "moveToTrash",
} as const;

const ICONS = {
  open: FolderIcon,
  quickLook: QuickLookIcon,
  openInStudio: AnnotateIcon,
  newFolder: NewFolderIcon,
  upload: UploadIcon,
  rename: RenameIcon,
  moveTo: MoveIcon,
  copy: CopyIcon,
  cut: CutIcon,
  paste: PasteIcon,
  star: StarIcon,
  unstar: StarFillIcon,
  download: DownloadIcon,
  versions: VersionsIcon,
  explore: ExploreIcon,
  trash: TrashIcon,
  restore: RestoreIcon,
  undo: UndoIcon,
  redo: RedoIcon,
} satisfies Record<string, IconComponent | undefined>;

const items = (s: number) => (s === 1 ? "1 item" : `${s.toLocaleString()} items`);

/** The menu for one row type. Pure: same input, same entries. */
export function menuItems(rowType: FilesRowType, ctx: MenuContext = {}): MenuEntry[] {
  const writable = ctx.writable !== false;
  const type: FilesRowType = (rowType === "folder" || rowType === "file" || rowType === "run") && ctx.locked ? "sample" : rowType;
  // Why an edit can't happen here (locked beats read-only: it's the more specific reason).
  const editReason = (extra?: string | null): string | null => extra ?? (type === "sample" ? SAMPLE_LOCKED : !writable ? NEEDS_FULL_STACK : null);
  const rootReason = ctx.isRoot ? ROOT_FIXED : null;
  const clip = ctx.clipboardCount ?? 0;
  const paste = (group: number): MenuEntry => ({
    id: "paste",
    label: clip > 0 ? `Paste (${items(clip)})` : "Paste",
    icon: ICONS.paste,
    command: FILES_COMMANDS.paste,
    disabled: clip > 0 ? editReason() : "Nothing to paste",
    group,
  });
  const star = (group: number): MenuEntry =>
    ctx.starred ? { id: "unstar", label: "Remove from Starred", icon: ICONS.unstar, group } : { id: "star", label: "Star", icon: ICONS.star, group };
  const trash = (group: number, extra?: string | null): MenuEntry => ({
    id: "trash",
    label: "Move to Trash",
    icon: ICONS.trash,
    command: FILES_COMMANDS.trash,
    disabled: editReason(extra),
    group,
    destructive: true,
  });

  switch (type) {
    case "folder":
      return [
        { id: "open", label: "Open", icon: ICONS.open, command: FILES_COMMANDS.open, group: 0 },
        { id: "newFolder", label: "New folder inside", icon: ICONS.newFolder, command: FILES_COMMANDS.newFolder, disabled: editReason(), group: 0 },
        { id: "uploadFiles", label: "Upload files here", icon: ICONS.upload, group: 0 },
        { id: "uploadFolder", label: "Upload folder here", icon: ICONS.upload, group: 0 },
        { id: "rename", label: "Rename", icon: ICONS.rename, command: FILES_COMMANDS.rename, disabled: editReason(rootReason), group: 1 },
        { id: "moveTo", label: "Move to…", icon: ICONS.moveTo, disabled: editReason(rootReason), group: 1 },
        { id: "duplicate", label: "Duplicate", command: FILES_COMMANDS.duplicate, disabled: editReason(rootReason), group: 1 },
        { id: "cut", label: "Cut", icon: ICONS.cut, command: FILES_COMMANDS.cut, disabled: editReason(rootReason), group: 1 },
        { id: "copy", label: "Copy", icon: ICONS.copy, command: FILES_COMMANDS.copy, group: 1 },
        paste(1),
        star(2),
        { id: "downloadZip", label: "Download as ZIP", icon: ICONS.download, group: 2 },
        { id: "copyPath", label: "Copy path", group: 2 },
        { id: "showInExplore", label: "Show in Explore", icon: ICONS.explore, group: 2 },
        trash(3, rootReason),
      ];
    case "file":
      return [
        { id: "open", label: "Open", command: FILES_COMMANDS.open, group: 0 },
        { id: "quickLook", label: "Quick Look", icon: ICONS.quickLook, command: FILES_COMMANDS.quickLook, group: 0 },
        ...(ctx.usedInTask ? [{ id: "openInStudio", label: "Open in Studio", icon: ICONS.openInStudio, group: 0 } satisfies MenuEntry] : []),
        { id: "rename", label: "Rename", icon: ICONS.rename, command: FILES_COMMANDS.rename, disabled: editReason(), group: 1 },
        { id: "moveTo", label: "Move to…", icon: ICONS.moveTo, disabled: editReason(), group: 1 },
        { id: "duplicate", label: "Duplicate", command: FILES_COMMANDS.duplicate, disabled: editReason(), group: 1 },
        { id: "cut", label: "Cut", icon: ICONS.cut, command: FILES_COMMANDS.cut, disabled: editReason(), group: 1 },
        { id: "copy", label: "Copy", icon: ICONS.copy, command: FILES_COMMANDS.copy, group: 1 },
        star(2),
        { id: "download", label: "Download", icon: ICONS.download, group: 2 },
        { id: "replaceVersion", label: "Replace with new version…", disabled: editReason(), group: 2 },
        { id: "versionHistory", label: "Version history", icon: ICONS.versions, disabled: ctx.hasVersions === false ? "Only the version as uploaded" : null, group: 2 },
        { id: "copyPath", label: "Copy path", group: 2 },
        trash(3),
      ];
    case "run": {
      const n = ctx.runCount;
      return [
        { id: "open", label: "Open", icon: ICONS.open, command: FILES_COMMANDS.open, group: 0 },
        { id: "selectAll", label: n ? `Select all ${n.toLocaleString()} files` : "Select all files", command: FILES_COMMANDS.selectAll, group: 0 },
        { id: "moveTo", label: "Move to…", icon: ICONS.moveTo, disabled: editReason(), group: 1 },
        { id: "cut", label: "Cut", icon: ICONS.cut, command: FILES_COMMANDS.cut, disabled: editReason(), group: 1 },
        { id: "copy", label: "Copy", icon: ICONS.copy, command: FILES_COMMANDS.copy, group: 1 },
        { id: "downloadZip", label: "Download as ZIP", icon: ICONS.download, group: 1 },
        trash(2),
      ];
    }
    case "sample": {
      const folderish = (ctx.sampleKind ?? (rowType === "file" ? "file" : "folder")) !== "file";
      return [
        { id: "open", label: "Open", icon: folderish ? ICONS.open : undefined, command: FILES_COMMANDS.open, group: 0 },
        { id: "copyTo", label: "Copy to…", icon: ICONS.copy, disabled: writable ? null : NEEDS_FULL_STACK, group: 0 },
        folderish ? { id: "downloadZip", label: "Download as ZIP", icon: ICONS.download, group: 0 } : { id: "download", label: "Download", icon: ICONS.download, group: 0 },
        { id: "copyPath", label: "Copy path", group: 0 },
        // Edit items stay visible, disabled with the reason (D2).
        { id: "rename", label: "Rename", icon: ICONS.rename, command: FILES_COMMANDS.rename, disabled: SAMPLE_LOCKED, group: 1 },
        { id: "moveTo", label: "Move to…", icon: ICONS.moveTo, disabled: SAMPLE_LOCKED, group: 1 },
        { id: "cut", label: "Cut", icon: ICONS.cut, command: FILES_COMMANDS.cut, disabled: SAMPLE_LOCKED, group: 1 },
        { id: "trash", label: "Move to Trash", icon: ICONS.trash, command: FILES_COMMANDS.trash, disabled: SAMPLE_LOCKED, group: 1, destructive: true },
      ];
    }
    case "trash":
      return [
        { id: "restore", label: "Restore", icon: ICONS.restore, disabled: writable ? null : NEEDS_FULL_STACK, group: 0 },
        { id: "deleteForever", label: "Delete forever", icon: ICONS.trash, disabled: writable ? null : NEEDS_FULL_STACK, group: 1, destructive: true },
      ];
    case "multi": {
      const locked = ctx.selectionLocked ? SAMPLE_LOCKED : null;
      const n = ctx.selectionCount;
      return [
        { id: "moveTo", label: n ? `Move ${items(n)} to…` : "Move to…", icon: ICONS.moveTo, disabled: editReason(locked), group: 0 },
        { id: "copy", label: "Copy", icon: ICONS.copy, command: FILES_COMMANDS.copy, group: 0 },
        { id: "cut", label: "Cut", icon: ICONS.cut, command: FILES_COMMANDS.cut, disabled: editReason(locked), group: 0 },
        ...(clip > 0 ? [paste(0)] : []),
        { id: "download", label: "Download", icon: ICONS.download, group: 1 },
        star(1),
        trash(2, locked),
      ];
    }
  }
}

/** The props a menu item primitive must take (DropdownMenuItem and ContextMenuItem both do). */
export interface MenuItemPrimitiveProps {
  disabled?: boolean;
  onSelect?: (event: Event) => void;
  className?: string;
  children?: ReactNode;
}

export interface MenuPrimitives {
  Item: ComponentType<MenuItemPrimitiveProps>;
  Separator: ComponentType<{ className?: string }>;
  Shortcut: ComponentType<{ className?: string; children?: ReactNode }>;
}

/** DropdownMenu pieces (the `⋯` buttons). */
export const dropdownMenuPrimitives: MenuPrimitives = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
};

/** Radix ContextMenu pieces (right-click, Shift+F10 / the Menu key). */
export const contextMenuPrimitives: MenuPrimitives = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

/** "Undo: moved 3 items to MRI" / "Redo: …" entries for the end of a menu (the Edit hint, Phase 4). */
export function editHistoryEntries({ undo, redo }: { undo?: string | null; redo?: string | null }): MenuEntry[] {
  const out: MenuEntry[] = [];
  if (undo) out.push({ id: "undo", label: undo, icon: ICONS.undo, command: "undo", group: 9 });
  if (redo) out.push({ id: "redo", label: redo, icon: ICONS.redo, command: "redo", group: 9 });
  return out;
}

export interface FilesMenuItemsProps {
  entries: MenuEntry[];
  onAction: (id: FilesMenuAction) => void;
  /** Menu pieces to render with; DropdownMenu by default. */
  primitives?: MenuPrimitives;
  /** A command's display shortcut ("⌘C"); the registry's binding by default. */
  shortcutFor?: (command: string) => string;
  /** Overrides a label at render time (e.g. "Undo move of 3 items" hints). */
  labelFor?: (entry: MenuEntry) => string;
}

/**
 * Renders menu entries into a menu's content (the caller owns the Root, Trigger and Content).
 * Disabled items keep their place and say why on a second line, like today's "Remove upload…".
 * Each item carries `data-testid="files-menu-<id>"`.
 */
export function FilesMenuItems({ entries, onAction, primitives = dropdownMenuPrimitives, shortcutFor = shortcutLabel, labelFor }: FilesMenuItemsProps) {
  const { Item, Separator, Shortcut } = primitives;
  return (
    <>
      {entries.map((e, i) => {
        const Icon = e.icon;
        const keys = e.command ? shortcutFor(e.command) : "";
        return (
          <MenuRow key={e.id} sep={i > 0 && entries[i - 1].group !== e.group} Separator={Separator}>
            <Item disabled={!!e.disabled} onSelect={() => onAction(e.id)} className={cn(e.disabled && "items-start", e.destructive && !e.disabled && "text-danger focus:text-danger")}>
              <span className="contents" data-testid={`files-menu-${e.id}`} data-disabled-reason={e.disabled ?? undefined}>
                {Icon ? <Icon aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{labelFor?.(e) ?? e.label}</span>
                  {e.disabled && <span className="text-xs text-hint">{e.disabled}</span>}
                </span>
                {keys && <Shortcut>{keys}</Shortcut>}
              </span>
            </Item>
          </MenuRow>
        );
      })}
    </>
  );
}

function MenuRow({ sep, Separator, children }: { sep: boolean; Separator: MenuPrimitives["Separator"]; children: ReactNode }) {
  return (
    <>
      {sep && <Separator />}
      {children}
    </>
  );
}
