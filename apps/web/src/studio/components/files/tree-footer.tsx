import { useState } from "react";
import type { FsShortcut, SourceNode } from "@studio/contracts/types";
import { RES } from "@studio/contracts/naming";
import { ChevronDownIcon, ChevronRightIcon, DeleteIcon, ImportedIcon } from "@studio/ui/icons";
import { cn } from "@studio/ui/utils";
import { nodeIcon } from "@/studio/lib/file-kinds";
import { DROP_HIGHLIGHT, relativeTime } from "./shared";

/**
 * The tree footer (todo7 §2, kiwifs `AppSidebar` sections): collapsible Starred and Recent
 * sections (at most 8 rows each; open or closed is remembered per viewer), then links to Imports
 * and **Trash (count)**. A row click calls `onReveal(node)` (the page reveals it in the tree).
 * Starred folders take drops (`onDropOnNode`), with the tree's drop look.
 */

export interface TreeFooterProps {
  starred: FsShortcut[];
  recent: FsShortcut[];
  onReveal: (node: SourceNode) => void;
  trashCount: number;
  onOpenTrash: () => void;
  /** The Trash view is showing. */
  trashActive?: boolean;
  /** Imports link; left out when not given. */
  onOpenImports?: () => void;
  importsCount?: number;
  importsActive?: boolean;
  /** A drop on a starred folder (the page's drag controller decides what it means). */
  onDropOnNode?: (node: SourceNode, dataTransfer: DataTransfer) => void;
  /** May this drag drop here? (Only types are readable during a drag.) Default: yes, for folders. */
  acceptsDrop?: (node: SourceNode, e: React.DragEvent) => boolean;
  /** Attributes that make a starred folder a target of the page's drag controller (instead of `onDropOnNode`). */
  dropAttrs?: (node: SourceNode) => Record<string, string> | undefined;
  /** The starred folder the page's drag controller has under the pointer (highlighted). */
  dropHighlightId?: string | null;
}

const MAX_ROWS = 8;
const KEY = `${RES}-files-footer`;
type Open = { starred: boolean; recent: boolean };

function readOpen(): Open {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { starred: true, recent: true, ...(JSON.parse(raw) as Partial<Open>) };
  } catch {
    // Private window or blocked storage: open by default.
  }
  return { starred: true, recent: true };
}

function writeOpen(o: Open) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

export function TreeFooter({ starred, recent, onReveal, trashCount, onOpenTrash, trashActive, onOpenImports, importsCount, importsActive, onDropOnNode, acceptsDrop, dropAttrs, dropHighlightId }: TreeFooterProps) {
  const [open, setOpen] = useState<Open>(readOpen);
  const toggle = (k: keyof Open) =>
    setOpen((o) => {
      const n = { ...o, [k]: !o[k] };
      writeOpen(n);
      return n;
    });
  return (
    <div className="shrink-0 border-t border-border px-2 pb-2 pt-1" data-testid="tree-footer">
      {starred.length > 0 && (
        <Section id="starred" title="Starred" open={open.starred} onToggle={() => toggle("starred")}>
          {starred.slice(0, MAX_ROWS).map((s) => (
            <ShortcutRow key={s.node.id} s={s} onReveal={onReveal} onDropOnNode={onDropOnNode} acceptsDrop={acceptsDrop} attrs={s.node.kind === "folder" ? dropAttrs?.(s.node) : undefined} highlighted={dropHighlightId === s.node.id} />
          ))}
        </Section>
      )}
      {recent.length > 0 && (
        <Section id="recent" title="Recent" open={open.recent} onToggle={() => toggle("recent")}>
          {recent.slice(0, MAX_ROWS).map((s) => (
            <ShortcutRow key={s.node.id} s={s} onReveal={onReveal} showWhen />
          ))}
        </Section>
      )}
      <div className="mt-1 space-y-px">
        {onOpenImports && (
          <LinkRow active={importsActive} onClick={onOpenImports} testid="tree-footer-imports">
            <ImportedIcon className="size-4 shrink-0 text-hint" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Imports</span>
            {!!importsCount && <span className="tnum text-xs text-muted-foreground">{importsCount.toLocaleString()}</span>}
          </LinkRow>
        )}
        <LinkRow active={trashActive} onClick={onOpenTrash} testid="tree-footer-trash">
          <DeleteIcon className="size-4 shrink-0 text-hint" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Trash</span>
          {trashCount > 0 && (
            <span className="tnum text-xs text-muted-foreground" data-testid="trash-count">
              {trashCount.toLocaleString()}
            </span>
          )}
        </LinkRow>
      </div>
    </div>
  );
}

function Section({ id, title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <section aria-label={title} className="pt-1" data-testid={`tree-footer-${id}`} data-open={open}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-6 w-full items-center gap-1 rounded-sm px-2 text-left text-xs font-semibold uppercase tracking-wide text-hint hover:text-foreground">
        <Chevron className="size-3 shrink-0" aria-hidden />
        {title}
      </button>
      {open && <ul>{children}</ul>}
    </section>
  );
}

function ShortcutRow({ s, onReveal, showWhen, onDropOnNode, acceptsDrop, attrs, highlighted }: { s: FsShortcut; onReveal: (n: SourceNode) => void; showWhen?: boolean; onDropOnNode?: TreeFooterProps["onDropOnNode"]; acceptsDrop?: TreeFooterProps["acceptsDrop"]; attrs?: Record<string, string>; highlighted?: boolean }) {
  const [over, setOver] = useState(false);
  const n = s.node;
  const Icon = nodeIcon(n);
  const droppable = !!onDropOnNode && n.kind === "folder";
  const accepts = (e: React.DragEvent) => droppable && (acceptsDrop ? acceptsDrop(n, e) : true);
  return (
    <li>
      <button
        type="button"
        onClick={() => onReveal(n)}
        title={n.folderPath ? `${n.folderPath}/${n.name}` : n.name}
        className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-generic", (over || highlighted) && DROP_HIGHLIGHT)}
        data-testid="tree-footer-row"
        data-node-id={n.id}
        {...attrs}
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          setOver(false);
          onDropOnNode!(n, e.dataTransfer);
        }}
      >
        <Icon className="size-4 shrink-0 text-hint" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{n.displayPath ?? n.name}</span>
        {showWhen && s.at && <span className="shrink-0 text-xs text-hint">{relativeTime(s.at)}</span>}
      </button>
    </li>
  );
}

function LinkRow({ active, onClick, testid, children }: { active?: boolean; onClick: () => void; testid: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? "page" : undefined} className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm", active ? "bg-selection" : "hover:bg-generic")} data-testid={testid}>
      {children}
    </button>
  );
}
