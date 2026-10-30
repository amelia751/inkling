import * as React from "react"
import { Tree, type NodeApi, type NodeRendererProps, type RowRendererProps, type TreeApi } from "react-arborist"

import { ChevronRightIcon, type IconComponent } from "../icons"
import { cn } from "../utils"

/**
 * A file tree (todo6 D5): react-arborist with a 28px row, 12px indent, virtualization,
 * keyboard, selection and type-ahead. Generic on purpose (`@studio/ui` imports nothing
 * internal): every node brings its own icon, counts and one status icon; the caller loads
 * children on expand and passes them back in `data`.
 *
 * What arborist leaves out is added here: `aria-setsize` / `aria-posinset`, no
 * `aria-expanded` on leaves, the full name and status reason as a tooltip, indent guides on
 * hover and focus, and a one-second reveal flash when the caller asks to show a node.
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
  /** `undefined` is a leaf; an array (possibly empty, not loaded yet) is a folder. */
  children?: FileTreeNode[]
  /** A pseudo row: a skeleton while a folder loads, or "Load more" for the next page. */
  placeholder?: "loading" | "more"
  onMore?: () => void
  /** Where a file drop on this row goes (a folder: itself; a file: its folder). */
  drop?: { id: string; label: string }
}

export interface FileTreeHandle {
  /** Scroll a node into view, select it, and flash it. */
  reveal: (id: string) => void
  focus: () => void
  api: () => TreeApi<FileTreeNode> | null | undefined
}

export interface FileTreeProps {
  data: FileTreeNode[]
  selectedId?: string | null
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
}

const ROW = 28
const INDENT = 12

export const FileTree = React.forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { data, selectedId, initialOpen, onSelect, onActivate, onToggle, onFocusNode, onKey, onContextMenu, className, ...aria },
  ref,
) {
  const box = React.useRef<HTMLDivElement>(null)
  const tree = React.useRef<TreeApi<FileTreeNode> | null | undefined>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })
  const [flash, setFlash] = React.useState<string | null>(null)

  // Height (and width) from the container, as kiwifs's KiwiTree does: arborist virtualizes rows.
  React.useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
  }))

  const initialOpenState = React.useMemo(() => Object.fromEntries((initialOpen ?? []).map((id) => [id, true])), [initialOpen])

  const Node = React.useCallback(
    (props: NodeRendererProps<FileTreeNode>) => <TreeRow {...props} flash={flash === props.node.id} onContextMenu={onContextMenu} />,
    [flash, onContextMenu],
  )

  return (
    <div
      ref={box}
      className={cn("group/tree relative h-full min-h-0 w-full text-body", className)}
      onKeyDownCapture={(e) => {
        if (onKey?.(e)) {
          e.preventDefault()
          e.stopPropagation()
        }
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
          selection={selectedId ?? undefined}
          disableDrag
          disableDrop
          disableEdit
          onSelect={(nodes: NodeApi<FileTreeNode>[]) => onSelect?.(nodes.filter((n) => !n.data.placeholder).map((n) => n.id))}
          onActivate={(node: NodeApi<FileTreeNode>) => {
            if (node.data.placeholder === "more") return node.data.onMore?.()
            if (!node.data.placeholder) onActivate?.(node.id)
          }}
          onToggle={(id: string) => onToggle?.(id, !!tree.current?.get(id)?.isOpen)}
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

function TreeRow({ node, style, flash, onContextMenu }: NodeRendererProps<FileTreeNode> & { flash: boolean; onContextMenu?: (id: string, e: React.MouseEvent) => void }) {
  const d = node.data
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
  return (
    <div
      style={style}
      title={d.title ?? d.name}
      onContextMenu={onContextMenu ? (e) => onContextMenu(node.id, e) : undefined}
      onDoubleClick={() => node.isInternal && node.activate()}
      className={cn(
        "relative flex h-7 cursor-default select-none items-center gap-1.5 rounded-md pr-2",
        node.isSelected ? "bg-selection" : "hover:bg-generic",
        node.isFocused && "ring-1 ring-ring ring-inset",
        flash && "tree-reveal-flash",
      )}
      data-node-id={node.id}
      data-drop-id={d.drop?.id}
      data-drop-label={d.drop?.label}
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
      <span className="min-w-0 flex-1 truncate">{d.name}</span>
      {d.count !== undefined && <span className="tnum shrink-0 text-xs text-hint">{d.count}</span>}
      {d.status && <span className="flex shrink-0 items-center">{d.status}</span>}
    </div>
  )
}
