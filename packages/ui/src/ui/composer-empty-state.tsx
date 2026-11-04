import * as React from "react"

import { AddDataIcon, AiIcon, AttachIcon, FolderIcon, SubmitIcon } from "../icons"
import { cn } from "../utils"
import { Button } from "./button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

/** What a drop, a paste or the attach button hands over: the browser's own objects, unwalked. */
export type ComposerFiles = DataTransfer | FileList | File[]

const hasFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes("Files")

export interface ComposerEmptyStateProps {
  /** "What are you working on?", "No Studio yet". */
  title: React.ReactNode
  /** One or two sentences: what will appear here, and how to get it there. */
  description?: React.ReactNode
  /**
   * `hero`: Home and Projects (large title, wide composer). `page`: a section's empty state
   * (Overview, Files, Datasets, Studio entry). `panel`: a narrow column. `canvas`: over the
   * Studio's empty viewer.
   */
  variant?: "hero" | "page" | "panel" | "canvas"
  /** `hero` only: `center` puts the title and composer in the middle (Home with no projects). */
  align?: "start" | "center"
  /**
   * Show the text composer (a message to the assistant). Without it the state offers the
   * two composer actions as buttons: drop or add files, and ask the assistant.
   */
  composer?: boolean
  placeholder?: string
  /** Controlled text (optional: uncontrolled by default). */
  value?: string
  onValueChange?: (text: string) => void
  /** Enter or the send button, with the trimmed text (empty when only attachments go). */
  onSend?: (text: string) => void
  /**
   * Files attached and waiting for Send (the app's tiles), shown in the composer above the
   * field. While there are some, Send works with no text.
   */
  attachments?: React.ReactNode
  /** Example requests under the composer; picking one fills the field (or calls `onExample`). */
  examples?: string[]
  onExample?: (text: string) => void
  /**
   * Files dropped on the state (anywhere on it), pasted into the field, or picked with the
   * attach button. The caller walks folders and uploads; this component never reads bytes.
   */
  onFiles?: (files: ComposerFiles) => void
  /** Why adding files is off (a viewer: "Ask a contributor to add files"); disables attach and drop. */
  filesDisabledReason?: string
  /** "Ask the assistant": opens the chat (the composer-less variants). */
  onAsk?: () => void
  askLabel?: string
  /** The files button's label without a composer ("Add files", "Drop files"). */
  filesLabel?: string
  /** Extra actions after the composer's two ("Create dataset"). */
  actions?: React.ReactNode
  /** Shown over the state while files are dragged over it ("Drop to start a project"). */
  dropLabel?: string
  /** Disables send while something is in flight (creating the project). */
  busy?: boolean
  /** One line under the composer, in the danger colour. */
  error?: React.ReactNode
  /** Small print under the composer. */
  footnote?: React.ReactNode
  autoFocus?: boolean
  className?: string
  children?: React.ReactNode
  /** Test ids: the root, the composer's field, the drop area, and the two hidden inputs. */
  testId?: string
  inputTestId?: string
  dropTestId?: string
  pickFilesTestId?: string
  pickFolderTestId?: string
}

const VARIANTS = {
  hero: { root: "items-stretch gap-5 py-6", title: "text-display-1 font-semibold", desc: "text-body-2 text-muted-foreground", width: "max-w-3xl" },
  page: { root: "items-center gap-4 px-4 py-12 text-center", title: "text-header-1 font-semibold", desc: "text-sm text-muted-foreground", width: "max-w-xl" },
  panel: { root: "items-center gap-3 px-4 py-6 text-center", title: "text-body-2 font-semibold", desc: "text-sm text-muted-foreground", width: "max-w-sm" },
  canvas: { root: "items-center gap-3 px-6 py-10 text-center", title: "text-body-3 font-semibold", desc: "text-sm text-muted-foreground", width: "max-w-md" },
} as const

/**
 * The one empty state (todo13 §3.1, principle 1): every empty surface says what will appear
 * there and offers the composer's two actions, drop files or ask, the same way on Home, in a
 * project's sections and on the Studio canvas. Presentational only: the app decides what a
 * send or a drop does (create a project, start a drop, open the chat).
 */
function ComposerEmptyState({
  title,
  description,
  variant = "page",
  align = "start",
  composer = false,
  placeholder = "Describe what you're making, or drop files here",
  value,
  onValueChange,
  onSend,
  attachments,
  examples,
  onExample,
  onFiles,
  filesDisabledReason,
  onAsk,
  askLabel = "Ask the assistant",
  filesLabel = "Add files",
  actions,
  dropLabel = "Drop to add these files",
  busy = false,
  error,
  footnote,
  autoFocus,
  className,
  children,
  testId,
  inputTestId,
  dropTestId,
  pickFilesTestId = "pick-files",
  pickFolderTestId = "pick-folder",
}: ComposerEmptyStateProps) {
  const v = VARIANTS[variant]
  // Every variant but a start-aligned hero centres its column.
  const centered = variant !== "hero" || align === "center"
  const [own, setOwn] = React.useState("")
  const text = value ?? own
  const setText = (t: string) => (onValueChange ? onValueChange(t) : setOwn(t))
  const [over, setOver] = React.useState(false)
  const depth = React.useRef(0)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const dirRef = React.useRef<HTMLInputElement>(null)
  const area = React.useRef<HTMLTextAreaElement>(null)
  const canFiles = !!onFiles && !filesDisabledReason

  React.useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const canSend = !!text.trim() || !!attachments
  const send = () => {
    const t = text.trim()
    if (!canSend || busy || !onSend) return
    onSend(t)
  }
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length && canFiles) onFiles!(e.target.files)
    e.target.value = ""
  }
  const inputs = onFiles && (
    <>
      <input ref={fileRef} type="file" multiple hidden onChange={take} data-testid={pickFilesTestId} />
      <input ref={dirRef} type="file" multiple hidden onChange={take} data-testid={pickFolderTestId} {...{ webkitdirectory: "", directory: "" }} />
    </>
  )

  const attach = onFiles && (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span keeps the tooltip on a disabled trigger. */}
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost-secondary" size="icon-lg" disabled={!canFiles} aria-label="Attach files" data-testid="composer-attach">
                <AttachIcon />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{filesDisabledReason ?? "Attach files or a folder"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
          <AddDataIcon /> Files…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => dirRef.current?.click()}>
          <FolderIcon /> Folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // With a composer, only its box takes a drop (and lights up), not the page around it (Home).
  // Without one, the whole empty state is the target (an empty Studio canvas, an empty section).
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!canFiles || !hasFiles(e.dataTransfer)) return
      depth.current++
      setOver(true)
    },
    onDragLeave: () => {
      if (--depth.current <= 0) {
        depth.current = 0
        setOver(false)
      }
    },
    onDragOver: (e: React.DragEvent) => {
      if (canFiles && hasFiles(e.dataTransfer)) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      if (!canFiles || !hasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setOver(false)
      onFiles!(e.dataTransfer)
    },
  }
  const overlay = over && (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-ring bg-background/80" aria-hidden>
      <span className="flex items-center gap-2 rounded-lg bg-float px-3 py-2 text-sm font-medium shadow-float-lg">
        <AddDataIcon className="size-4" /> {dropLabel}
      </span>
    </div>
  )

  return (
    <div
      className={cn("relative flex w-full flex-col", v.root, variant === "hero" && align === "center" && "items-center justify-center text-center", className)}
      data-testid={testId}
      data-variant={variant}
      data-align={variant === "hero" ? align : undefined}
      {...(composer ? {} : dropProps)}
    >
      {inputs}
      <div className={cn("flex w-full flex-col gap-1.5", v.width, centered && "mx-auto items-center")}>
        <h2 className={v.title}>{title}</h2>
        {description && <div className={cn(v.desc, "max-w-prose")}>{description}</div>}
      </div>

      {composer ? (
        <div className={cn("flex w-full flex-col gap-2", v.width, centered && "mx-auto")}>
          <div
            className={cn(
              "relative flex cursor-text flex-col rounded-xl border bg-background p-3 text-left transition-colors focus-within:border-brand-heavy",
              over ? "border-ring bg-selection" : "border-border",
            )}
            onClick={(e) => e.target === e.currentTarget && area.current?.focus()}
            data-testid={dropTestId}
            {...dropProps}
          >
            {overlay}
            {attachments && <div className="mb-2" data-testid="composer-attachments">{attachments}</div>}
            <textarea
              ref={area}
              value={text}
              autoFocus={autoFocus}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
              onPaste={(e) => {
                // A pasted screenshot or copied files are a drop; pasted text stays text.
                const files = [...e.clipboardData.files]
                if (files.length && canFiles) {
                  e.preventDefault()
                  onFiles!(files)
                }
              }}
              rows={2}
              placeholder={placeholder}
              aria-label={typeof title === "string" ? title : "Message"}
              className="block max-h-50 min-h-11 w-full resize-none bg-transparent text-body-2 outline-none placeholder:text-hint focus-visible:outline-none"
              data-testid={inputTestId}
            />
            <div className="mt-2 flex items-center gap-2">
              {attach}
              {filesDisabledReason && <span className="text-caption text-hint" data-testid="composer-files-disabled">{filesDisabledReason}</span>}
              <Button type="button" variant={canSend ? "default" : "secondary"} size="icon-lg" className="ml-auto disabled:text-hint" onClick={send} disabled={!canSend || busy || !onSend} loading={busy} aria-label="Send" data-testid="composer-send">
                <SubmitIcon />
              </Button>
            </div>
          </div>
          {error && <p className="px-1 text-sm text-danger" role="alert">{error}</p>}
          {examples && examples.length > 0 && (
            <div className={cn("flex flex-wrap gap-2", centered && "justify-center")} aria-label="Examples">
              <span className="py-1 text-sm text-hint">Examples:</span>
              {examples.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => (onExample ? onExample(g) : (setText(g), area.current?.focus()))}
                  className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-generic hover:text-foreground"
                  data-testid="goal-example"
                >
                  {g}
                </button>
              ))}
            </div>
          )}
          {actions && <div className={cn("flex flex-wrap items-center gap-2", centered && "justify-center")}>{actions}</div>}
          {footnote && <p className={cn("px-1 text-caption text-hint", centered && "text-center")}>{footnote}</p>}
        </div>
      ) : (
        <div
          className={cn(
            "relative flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 transition-colors",
            v.width,
            "mx-auto",
            over ? "border-ring bg-selection" : "border-border-hover",
            !onFiles && "border-none py-2",
          )}
          data-testid={dropTestId}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            {onFiles && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="lg" disabled={!canFiles} title={filesDisabledReason} data-testid="composer-add-files">
                    <AddDataIcon /> {filesLabel}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center">
                  <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                    <AddDataIcon /> Files…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => dirRef.current?.click()}>
                    <FolderIcon /> Folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {onAsk && (
              <Button type="button" variant="outline" size="lg" onClick={onAsk} data-testid="composer-ask">
                <AiIcon className="text-ai-text" /> {askLabel}
              </Button>
            )}
            {actions}
          </div>
          {onFiles && <p className="text-caption text-hint">{filesDisabledReason ?? "Or drop files and folders here."}</p>}
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {footnote && <p className="text-caption text-hint">{footnote}</p>}
        </div>
      )}

      {children}
      {!composer && overlay}
    </div>
  )
}

export { ComposerEmptyState }
