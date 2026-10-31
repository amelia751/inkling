import * as React from "react"
import { Tree, type DragPreviewProps, type NodeApi, type NodeRendererProps, type RowRendererProps, type TreeApi } from "react-arborist"

import { ChevronRightIcon, type IconComponent } from "../icons"
import { DROP_TARGET_CLASS, SPRING_LOAD_MS, edgeAutoScroll } from "../drag"
import { nameStem } from "../file-names"
import { cn } from "../utils"
import { DragChip, dragLabel } from "./drag-chip"

/**
 * A file tree (todo6 D5, todo7 Phases 2, 3 and 5): react-arborist with a 28px row, 12px
 * indent, virtualization, keyboard, selection and type-ahead. Generic on purpose
 * (`@studio/ui` imports nothing internal): every node brings its own icon, counts and one
 * status icon; the caller loads children on expand and passes them back in `data`.
 *
 * What arborist leaves out is added here: `aria-setsize` / `aria-posinset`, no
 * `aria-expanded` on leaves, the full name and status reason as a tooltip, indent guides on
 * hover and focus, and a one-second reveal flash when the caller asks to show a node.
 *
 * todo7 adds, all opt-in so a read-only tree behaves as before:
 * - inline rename (`editable`, `onRename`, `validate`, `handle.edit(id)`): the stem is
 *   selected on focus, Enter saves, Esc cancels, blur saves; the error shows under the field;
 * - multi-selection (`selectedIds`; ⇧/⌘ click, ⇧↑↓ and ⌘A come from arborist);
 * - hover/focus row actions (`rowActions`: the `+` and `⋯`);
 * - drag and drop *into folders only* (`canDrag`, `canDrop`, `onMove`; ⌥ copies; a refused
 *   target says why; closed folders spring open after 700ms; the list autoscrolls near its
 *   edges), plus `dropTargetId` for drags that start outside the tree (the listing, OS files);
 * - a filter of the loaded tree (`searchTerm`, `searchMatch`), `handle.closeAll()` and
 *   `handle.openRecursive(id, cap)`;
 * - cut rows at 50% opacity (`cutIds`).
 */
export interface FileTreeNode {
  id: string
  /** What the row says (a compact chain like `MRI / patient_002`, or a name). */
  name: string
  /** Tooltip: the full name, plus the status reason. */
  title?: string
  icon: IconComponent
  openIcon?: IconComponent
  /** Right-aligned hint, e.g. a child count. */
  count?: React.ReactNode
  /** At most one status icon (checking, privacy, warning, error). */
  status?: React.ReactNode
  /** Small marks after the name (e.g. a star, a lock). */
  badges?: React.ReactNode
  /** `undefined` is a leaf; an array (possibly empty, not loaded yet) is a folder. */
  children?: FileTreeNode[]
  /** A pseudo row: a skeleton while a folder loads, or "Load more" for the next page. */
  placeholder?: "loading" | "more"
  onMore?: () => void
  /** Where a file drop on this row goes (a folder: itself; a file: its folder). */
  drop?: { id: string; label: string }
  /** The name the rename field starts with (default: `name`; a compact chain's last segment). */
  editName?: string
}

export interface FileTreeHandle {
  /** Scroll a node into view, select it, and flash it. */
  reveal: (id: string) => void
  focus: () => void
  api: () => TreeApi<FileTreeNode> | null | undefined
  /** Open the rename field on a node (no-op when the tree or the node isn't editable). */
  edit: (id: string) => void
  /** Collapse every folder (`onToggle` reports each). */
  closeAll: () => void
  /**
   * Open a folder and every loaded folder below it, stopping once `cap` rows are showing
   * under it. Folders whose children load later keep opening (until the cap, a collapse of
   * `id`, or `closeAll`). Returns true when it stopped at the cap.
   */
  openRecursive: (id: string, cap?: number) => boolean
}

export interface FileTreeMoveArgs {
  dragIds: string[]
  /** The folder dropped into. */
  parentId: string
  /** ⌥ (Alt) held at the drop: copy instead of move. */
  copy: boolean
}

export interface FileTreeProps {
  data: FileTreeNode[]
  /** Single selection (todo6). Ignored when `selectedIds` is given. */
  selectedId?: string | null
  /** Controlled multi-selection: the tree follows it, and reports changes through `onSelect`. */
  selectedIds?: readonly string[]
  /** Folders open at mount (later, `onToggle` reports changes; the tree owns open state). */
  initialOpen?: string[]
  onSelect?: (ids: string[]) => void
  /** Enter on a folder or a double click: open it in the listing. */
  onActivate?: (id: string) => void
  onToggle?: (id: string, open: boolean) => void
  /** Keyboard focus moved to a row (arrows, type-ahead). */
  onFocusNode?: (id: string) => void
  /** Keys the tree must not take (commands such as Quick Look): return true when handled. */
  onKey?: (e: React.KeyboardEvent) => boolean
  onContextMenu?: (id: string, e: React.MouseEvent) => void
  "aria-label": string
  className?: string

  // ---- Rename (Phase 2) ----
  /** Rows that can be renamed (default: none). */
  editable?: boolean | ((node: FileTreeNode) => boolean)
  /** Commit a rename (the name is trimmed and differs from the current one). */
  onRename?: (id: string, name: string) => void | Promise<void>
  /** The rename was cancelled (Esc, or blur with nothing changed): e.g. drop an untouched new folder. */
  onRenameCancel?: (id: string) => void
  /** Live validation: an error sentence shown under the field (Enter is refused), or null. */
  validate?: (name: string, node: FileTreeNode) => string | null
  /** Hover / focus actions at the end of a row (the `+` and `⋯`); clicks don't select the row. */
  rowActions?: (node: FileTreeNode) => React.ReactNode

  // ---- Drag and drop (Phase 3) ----
  /** Rows that can be dragged (default: none, unless `onMove` is given: every real row). */
  canDrag?: (node: FileTreeNode) => boolean
  /** Whether the dragged rows may go into `parentId`: true, or the reason it can't. */
  canDrop?: (args: { dragIds: string[]; parentId: string }) => true | string
  onMove?: (args: FileTreeMoveArgs) => void
  /** A drag from outside the tree (the listing, OS files) is over this folder: highlight and spring-load it. */
  dropTargetId?: string | null
  /** A drag started in the tree (ids) or ended (null), for drop targets outside it. */
  onDragChange?: (dragIds: string[] | null) => void

  // ---- Find your way (Phase 5) ----
  /** Narrow the loaded tree (arborist `searchTerm`); drops are off while filtered. */
  searchTerm?: string
  /** Default: the row's name or title contains the term, so a compact chain matches on any segment. */
  searchMatch?: (node: FileTreeNode, term: string) => boolean
  /** A recursive expand stopped at its cap after more children loaded. */
  onOpenCap?: (id: string) => void

  /** Rows cut to the clipboard: drawn at 50% opacity until pasted. */
  cutIds?: ReadonlySet<string> | readonly string[]
}

const ROW = 28
const INDENT = 12

/** Default filter (kiwifs `treeSearchMatch`): name, compact chain or title contains the term. */
export function treeSearchMatch(node: FileTreeNode, term: string): boolean {
  const q = term.trim().toLowerCase()
  if (!q) return true
  if (node.placeholder) return false
  return node.name.toLowerCase().includes(q) || (node.title?.toLowerCase().includes(q) ?? false) || (node.editName?.toLowerCase().includes(q) ?? false)
}

interface RowExtras {
  flash: string | null
  dropTargetId: string | null | undefined
  cut: ReadonlySet<string>
  onContextMenu?: (id: string, e: React.MouseEvent) => void
  rowActions?: (node: FileTreeNode) => React.ReactNode
  validate?: (name: string, node: FileTreeNode) => string | null
  onRenameCancel?: (id: string) => void
  dropRefusal: { id: string; reason: string } | null
  /** Drag and drop is on (`onMove`): rows get arborist's drag handle. */
  dndOn: boolean
}

export const FileTree = React.forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  {
    data,
    selectedId,
    selectedIds,
    initialOpen,
    onSelect,
    onActivate,
    onToggle,
    onFocusNode,
    onKey,
    onContextMenu,
    className,
    editable,
    onRename,
    onRenameCancel,
    validate,
    rowActions,
    canDrag,
    canDrop,
    onMove,
    dropTargetId,
    onDragChange,
    searchTerm,
    searchMatch,
    onOpenCap,
    cutIds,
    ...aria
  },
  ref,
) {
  const box = React.useRef<HTMLDivElement>(null)
  const tree = React.useRef<TreeApi<FileTreeNode> | null | undefined>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [flash, setFlash] = React.useState<string | null>(null)
  // Drag state: ⌥ for copy, and the reason the hovered folder refuses the drop.
  const alt = React.useRef(false)
  const [copying, setCopying] = React.useState(false)
  const refusalRef = React.useRef<{ id: string; reason: string } | null>(null)
  const [refusal, setRefusal] = React.useState<{ id: string; reason: string } | null>(null)
  const dragging = React.useRef<string[] | null>(null)
  const pointerInside = React.useRef(true)
  const [inside, setInside] = React.useState(true)
  // Recursive expands still waiting for children to load: root id → row cap.
  const recursive = React.useRef(new Map<string, number>())

  // Height (and width) from the container, as kiwifs's KiwiTree does: arborist virtualizes rows.
  React.useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const isEditable = React.useCallback((d: FileTreeNode) => !!onRename && !d.placeholder && (typeof editable === "function" ? editable(d) : !!editable), [editable, onRename])

  /** Open loaded folders under `id`, breadth first, until `cap` rows show below it. */
  const expand = React.useCallback((id: string, cap: number): boolean => {
    const t = tree.current
    const root = t?.get(id)
    if (!t || !root || !root.isInternal) return false
    t.open(id)
    let rows = 0
    let queue: NodeApi<FileTreeNode>[] = [root]
    while (queue.length) {
      const next: NodeApi<FileTreeNode>[] = []
      for (const n of queue) {
        const kids = (n.children ?? []).filter((c) => !c.data.placeholder)
        rows += n.children?.length ?? 0
        if (rows > cap) return true
        for (const c of kids) {
          if (!c.isInternal) continue
          if (!c.isOpen) t.open(c.id)
          next.push(c)
        }
      }
      queue = next
    }
    return false
  }, [])

  // Keep a recursive expand going as children arrive.
  React.useEffect(() => {
    for (const [id, cap] of recursive.current) {
      if (!tree.current?.get(id)?.isOpen) {
        recursive.current.delete(id)
        continue
      }
      if (expand(id, cap)) {
        recursive.current.delete(id)
        onOpenCap?.(id)
      }
    }
  }, [data, expand, onOpenCap])

  React.useImperativeHandle(ref, () => ({
    reveal: (id) => {
      const t = tree.current
      if (!t) return
      t.openParents(id)
      t.select(id, { focus: false })
      t.scrollTo(id, "center")
      setFlash(id)
      window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 1000)
    },
    focus: () => {
      const t = tree.current
      if (t && !t.focusedNode && t.firstNode) t.focus(t.firstNode)
      box.current?.querySelector<HTMLElement>("[role=tree]")?.focus()
    },
    api: () => tree.current,
    edit: (id) => {
      const t = tree.current
      const n = t?.get(id)
      if (!t || !n || !isEditable(n.data)) return
      t.openParents(id)
      void t.edit(id)
    },
    closeAll: () => {
      recursive.current.clear()
      tree.current?.closeAll()
    },
    openRecursive: (id, cap = 2000) => {
      const hit = expand(id, cap)
      if (hit) recursive.current.delete(id)
      else recursive.current.set(id, cap)
      return hit
    },
  }))

  // Controlled multi-selection: follow `selectedIds` without echoing it back as a change.
  const selectedKey = selectedIds?.join("\n")
  React.useEffect(() => {
    const t = tree.current
    if (!t || selectedIds === undefined) return
    const now = t.selectedIds
    if (now.size === selectedIds.length && selectedIds.every((id) => now.has(id))) return
    const ids = selectedIds.filter((id) => t.get(id))
    t.setSelection({ ids, anchor: ids[0] ?? null, mostRecent: ids[ids.length - 1] ?? null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, size.height > 0])

  // During a drag: remember ⌥ (copy), autoscroll near the edges, and report the end.
  React.useEffect(() => {
    const over = (e: DragEvent) => {
      if (alt.current !== e.altKey) {
        alt.current = e.altKey
        setCopying(e.altKey)
      }
      // The tree's ghost only over the tree; outside it, the page's drop targets draw their own.
      const r = box.current?.getBoundingClientRect()
      const inside = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      if (inside !== pointerInside.current) {
        pointerInside.current = inside
        setInside(inside)
      }
      // Any drag near the tree's edges (its rows, the listing's, OS files): bounded by the tree's box.
      edgeAutoScroll(scrollerOf(box.current), e.clientX, e.clientY)
    }
    const end = () => {
      pointerInside.current = true
      setInside(true)
      alt.current = false
      setCopying(false)
      refusalRef.current = null
      setRefusal(null)
      if (dragging.current) {
        dragging.current = null
        onDragChange?.(null)
      }
    }
    window.addEventListener("dragover", over, true)
    window.addEventListener("dragend", end, true)
    window.addEventListener("drop", end)
    return () => {
      window.removeEventListener("dragover", over, true)
      window.removeEventListener("dragend", end, true)
      window.removeEventListener("drop", end)
    }
  }, [onDragChange])

  const dndOn = !!onMove
  const cut = React.useMemo(() => new Set(cutIds ?? []), [cutIds])
  const initialOpenState = React.useMemo(() => Object.fromEntries((initialOpen ?? []).map((id) => [id, true])), [initialOpen])

  const extras: RowExtras = { flash, dropTargetId, cut, onContextMenu, rowActions, validate, onRenameCancel, dropRefusal: refusal, dndOn }
  const Node = React.useCallback(
    (props: NodeRendererProps<FileTreeNode>) => <TreeRow {...props} {...extras} />,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flash, dropTargetId, cut, onContextMenu, rowActions, validate, onRenameCancel, refusal, dndOn],
  )

  const Preview = React.useCallback(
    ({ mouse, id, dragIds, isDragging }: DragPreviewProps) => {
      if (!isDragging || !mouse || !inside) return null
      const first = id ? tree.current?.get(id)?.data : undefined
      return (
        <div style={{ position: "fixed", pointerEvents: "none", zIndex: 100, left: 0, top: 0, transform: `translate(${mouse.x + 12}px, ${mouse.y + 8}px)` }}>
          <DragChip icon={first?.icon} label={dragLabel(dragIds.length, first?.name)} copy={copying} reason={refusal?.reason} />
        </div>
      )
    },
    [copying, refusal, inside],
  )

  const setRefusalSoon = (r: { id: string; reason: string } | null) => {
    const prev = refusalRef.current
    if (prev?.id === r?.id && prev?.reason === r?.reason) return
    refusalRef.current = r
    queueMicrotask(() => setRefusal(refusalRef.current))
  }

  return (
    <div
      ref={box}
      className={cn("group/tree relative h-full min-h-0 w-full text-body", className)}
      onKeyDownCapture={(e) => {
        const t = tree.current
        if (t?.isEditing) return
        if (onKey?.(e)) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        // Enter stays "open" (todo6); renaming is F2 (a command calling `edit`), never Enter.
        if (e.key === "Enter" && onRename && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const n = t?.focusedNode
          e.preventDefault()
          e.stopPropagation()
          if (n?.data.placeholder === "more") n.data.onMore?.()
          else if (n && !n.data.placeholder) onActivate?.(n.id)
        }
      }}
      onDragStartCapture={(e) => {
        if (!dndOn) return
        const row = (e.target as Element).closest?.("[data-node-id]") as HTMLElement | null
        const id = row?.dataset.nodeId
        const t = tree.current
        if (!id || !t) return
        const ids = t.isSelected(id) ? Array.from(t.selectedIds) : [id]
        dragging.current = ids
        onDragChange?.(ids)
      }}
    >
      {size.height > 0 && (
        <Tree<FileTreeNode>
          ref={tree}
          data={data}
          width={size.width}
          height={size.height}
          rowHeight={ROW}
          indent={INDENT}
          openByDefault={false}
          initialOpenState={initialOpenState}
          selection={selectedIds ? undefined : (selectedId ?? undefined)}
          disableDrag={(d: FileTreeNode) => !dndOn || !!d.placeholder || (canDrag ? !canDrag(d) : false)}
          disableDrop={
            dndOn
              ? ({ parentNode, dragNodes }) => {
                  // Into a folder only: arborist's between-row targets have an index.
                  const target = (tree.current as unknown as { hoverTarget?: { parentId: string | null; index: number | null } } | null)?.hoverTarget
                  if (!target || target.index !== null || !parentNode || parentNode.isRoot || parentNode.data.placeholder) {
                    setRefusalSoon(null)
                    return true
                  }
                  const dragIds = dragNodes.map((n) => n.id)
                  const verdict = dragIds.includes(parentNode.id) ? "Can't move a folder into itself" : (canDrop?.({ dragIds, parentId: parentNode.id }) ?? true)
                  setRefusalSoon(verdict === true ? null : { id: parentNode.id, reason: verdict })
                  return verdict !== true
                }
              : true
          }
          disableEdit={(d: FileTreeNode) => !isEditable(d)}
          onMove={({ dragIds, parentId }) => {
            if (!parentId) return
            onMove?.({ dragIds, parentId, copy: alt.current })
          }}
          onRename={({ id, name }) => {
            const n = tree.current?.get(id)
            const trimmed = name.trim()
            if (!n || !trimmed || trimmed === (n.data.editName ?? n.data.name)) return onRenameCancel?.(id)
            return onRename?.(id, trimmed)
          }}
          renderDragPreview={Preview}
          searchTerm={searchTerm?.trim() || undefined}
          searchMatch={(node: NodeApi<FileTreeNode>, term: string) => (searchMatch ?? treeSearchMatch)(node.data, term)}
          onSelect={(nodes: NodeApi<FileTreeNode>[]) => onSelect?.(nodes.filter((n) => !n.data.placeholder).map((n) => n.id))}
          onActivate={(node: NodeApi<FileTreeNode>) => {
            if (node.data.placeholder === "more") return node.data.onMore?.()
            if (!node.data.placeholder) onActivate?.(node.id)
          }}
          onToggle={(id: string) => {
            const open = !!tree.current?.get(id)?.isOpen
            if (!open) recursive.current.delete(id)
            onToggle?.(id, open)
          }}
          onFocus={(node: NodeApi<FileTreeNode>) => !node.data.placeholder && onFocusNode?.(node.id)}
          renderRow={AccessibleRow}
          className="thin-scrollbar outline-none"
          aria-label={aria["aria-label"]}
        >
          {Node}
        </Tree>
      )}
    </div>
  )
})

/** The element arborist scrolls (react-window's outer div, the one with overflow). */
function scrollerOf(box: HTMLElement | null): HTMLElement | null {
  const tree = box?.querySelector<HTMLElement>("[role=tree]")
  if (!tree) return null
  for (let el: HTMLElement | null = tree; el && el !== box; el = el.firstElementChild as HTMLElement | null) {
    if (el.scrollHeight > el.clientHeight + 1) return el
  }
  return tree.querySelector<HTMLElement>("div")
}

/** Arborist's row plus what it leaves out of the treeitem pattern. */
function AccessibleRow({ node, attrs, innerRef, children }: RowRendererProps<FileTreeNode>) {
  const siblings = node.parent?.children ?? []
  const { "aria-expanded": expanded, ...rest } = attrs as typeof attrs & { "aria-expanded"?: boolean }
  return (
    <div
      {...rest}
      ref={innerRef}
      aria-expanded={node.isInternal ? expanded : undefined}
      aria-setsize={siblings.length || undefined}
      aria-posinset={node.childIndex + 1}
      onFocus={(e) => e.stopPropagation()}
      onClick={node.handleClick}
      className={cn("outline-none", rest.className)}
    >
      {children}
    </div>
  )
}

function TreeRow({
  node,
  style,
  dragHandle,
  flash,
  dropTargetId,
  cut,
  onContextMenu,
  rowActions,
  validate,
  onRenameCancel,
  dropRefusal,
  dndOn,
}: NodeRendererProps<FileTreeNode> & RowExtras) {
  const d = node.data
  const externalTarget = !!dropTargetId && dropTargetId === node.id
  const receiving = node.willReceiveDrop || externalTarget

  // Spring-loaded folders: hovering a closed folder during a drag opens it after 700ms.
  React.useEffect(() => {
    if (!receiving || !node.isInternal || node.isOpen) return
    const t = window.setTimeout(() => node.open(), SPRING_LOAD_MS)
    return () => window.clearTimeout(t)
  }, [receiving, node])

  if (d.placeholder === "loading") {
    return (
      // Shown only after 150ms, so a fast folder doesn't flicker a skeleton.
      <div style={style} className="tree-skeleton-delay flex h-7 items-center gap-2 pr-2" aria-busy>
        <span className="ml-5 size-4 shrink-0 animate-pulse rounded-sm bg-generic" />
        <span className="h-3 w-2/3 animate-pulse rounded-sm bg-generic" />
      </div>
    )
  }
  if (d.placeholder === "more") {
    return (
      <div style={style} className="flex h-7 items-center pl-5 pr-2 text-sm text-brand">
        <button type="button" tabIndex={-1} className="hover:underline" onClick={(e) => (e.stopPropagation(), d.onMore?.())}>{d.name}</button>
      </div>
    )
  }
  const Icon = node.isOpen && d.openIcon ? d.openIcon : d.icon
  const actions = rowActions && !node.isEditing ? rowActions(d) : null
  const refused = dropRefusal?.id === node.id
  return (
    <div
      ref={dndOn ? dragHandle : undefined}
      style={style}
      title={node.isEditing ? undefined : (refused ? dropRefusal!.reason : (d.title ?? d.name))}
      onContextMenu={onContextMenu ? (e) => onContextMenu(node.id, e) : undefined}
      onDoubleClick={() => node.isInternal && !node.isEditing && node.activate()}
      className={cn(
        "group/row relative flex h-7 cursor-default select-none items-center gap-1.5 rounded-md pr-2",
        node.isSelected ? "bg-selection" : "hover:bg-generic",
        node.isFocused && "ring-1 ring-ring ring-inset",
        receiving && DROP_TARGET_CLASS,
        refused && "cursor-not-allowed",
        flash === node.id && "tree-reveal-flash",
        cut.has(node.id) && "opacity-50",
        node.isDragging && "opacity-60",
      )}
      data-node-id={node.id}
      data-folder-id={node.isInternal ? node.id : undefined}
      data-drop-id={d.drop?.id}
      data-drop-label={d.drop?.label}
      data-cut={cut.has(node.id) || undefined}
    >
      {/* Indent guides: 1px lines in --g-line, shown on hover and focus only. */}
      {Array.from({ length: node.level }, (_, i) => (
        <span key={i} aria-hidden className="pointer-events-none absolute top-0 bottom-0 w-px bg-border opacity-0 transition-opacity group-hover/tree:opacity-100 group-focus-within/tree:opacity-100" style={{ left: -(node.level - i) * INDENT + 7 }} />
      ))}
      <span
        className={cn("flex size-4 shrink-0 items-center justify-center text-hint", node.isLeaf && "invisible")}
        onClick={(e) => {
          e.stopPropagation()
          node.toggle()
        }}
        aria-hidden
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", node.isOpen && "rotate-90")} />
      </span>
      <Icon className={cn("size-4 shrink-0", node.isSelected ? "icon-gradient" : "text-hint")} aria-hidden />
      {node.isEditing ? (
        <RenameInput node={node} validate={validate} onCancel={onRenameCancel} />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{d.name}</span>
          {d.badges && <span className="flex shrink-0 items-center gap-1 text-hint">{d.badges}</span>}
          {d.count !== undefined && <span className={cn("tnum shrink-0 text-xs text-hint", actions && "group-hover/row:hidden group-focus-within/row:hidden", actions && node.isFocused && "hidden")}>{d.count}</span>}
          {d.status && <span className="flex shrink-0 items-center">{d.status}</span>}
          {actions && (
            <span
              className={cn("hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex", node.isFocused && "flex")}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              data-testid="tree-row-actions"
            >
              {actions}
            </span>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The inline rename field (kiwifs `RenameInput`, todo7 §2 Rename): the stem is selected on
 * focus (Finder), Enter saves, Esc cancels, blur saves (or cancels when the name is invalid
 * or unchanged). Validation runs as you type, with the sentence under the field.
 */
function RenameInput({ node, validate, onCancel }: { node: NodeApi<FileTreeNode>; validate?: RowExtras["validate"]; onCancel?: (id: string) => void }) {
  const input = React.useRef<HTMLInputElement>(null)
  const initial = node.data.editName ?? node.data.name
  const [value, setValue] = React.useState(initial)
  const done = React.useRef(false)
  const errorId = React.useId()
  const error = value.trim() === initial ? null : (validate?.(value, node.data) ?? null)

  React.useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, node.isInternal ? el.value.length : nameStem(el.value).length)
  }, [node.isInternal])

  const cancel = () => {
    if (done.current) return
    done.current = true
    node.reset()
    onCancel?.(node.id)
  }
  const save = () => {
    if (done.current) return
    const v = value.trim()
    if (!v || v === initial || error) return cancel()
    done.current = true
    node.submit(v)
  }

  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={input}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Rename ${initial}`}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errorId : undefined}
        spellCheck={false}
        autoComplete="off"
        data-testid="tree-rename-input"
        className={cn("h-6 w-full min-w-0 rounded-sm border bg-background px-1 text-body outline-none", error ? "border-destructive" : "border-ring")}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Escape") {
            e.preventDefault()
            cancel()
          } else if (e.key === "Enter") {
            e.preventDefault()
            if (!error) save()
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      {error && (
        <span id={errorId} role="alert" className="absolute left-0 top-full z-10 mt-0.5 max-w-72 whitespace-normal rounded-md bg-popover px-2 py-1 text-xs text-destructive shadow-popup" data-testid="tree-rename-error">
          {error}
        </span>
      )}
    </span>
  )
}
