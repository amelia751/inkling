import * as React from "react"

/**
 * Empty-state and error art in the Nebius console's style: one object per kind of thing, drawn
 * with a 2px gradient outline (`--ill-line-from` → `--ill-line-to`), a muted body
 * (`--ill-body`, `--ill-body-strong`) and at most one solid accent (`--ill-accent`); errors put a
 * warning/danger/positive glyph on a browser window. Every colour is a token in the studio
 * globals.css, so the art follows the theme. 160×160 viewBox; size it with CSS.
 */
type Props = React.SVGProps<SVGSVGElement>

const LineCtx = React.createContext("var(--ill-line-from)")
const useLine = () => React.useContext(LineCtx)

function Art({ children, backdrop, ...props }: Props & { backdrop?: boolean }) {
  const id = React.useId()
  return (
    <svg viewBox="0 0 160 160" fill="none" aria-hidden {...props}>
      <defs>
        <linearGradient id={id} x1="16" y1="16" x2="144" y2="144" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--ill-line-from)" />
          <stop offset="1" stopColor="var(--ill-line-to)" />
        </linearGradient>
      </defs>
      {backdrop && <rect x="30" y="38" width="108" height="104" rx="16" transform="rotate(-12 84 90)" fill="var(--ill-panel)" />}
      <LineCtx.Provider value={`url(#${id})`}>{children}</LineCtx.Provider>
    </svg>
  )
}

/** Outlined shape: gradient stroke over a body fill. */
function Shape({ as: Tag = "path", fill = "var(--ill-body)", ...props }: { as?: "path" | "rect" | "circle" } & React.SVGProps<SVGElement>) {
  const line = useLine()
  return React.createElement(Tag, { stroke: line, strokeWidth: 2, strokeLinejoin: "round", fill, ...props })
}

const Bar = (props: React.SVGProps<SVGRectElement>) => <rect height="6" rx="3" fill="var(--ill-body-strong)" {...props} />

/** A filled shape with a glyph cut out of it (the cut shows whatever is behind). */
function Cutout({ shape, cut }: { shape: React.ReactElement; cut: React.ReactNode }) {
  const id = React.useId()
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="160">
        <rect width="160" height="160" fill="white" />
        <g fill="black" stroke="black">{cut}</g>
      </mask>
      <g mask={`url(#${id})`}>{shape}</g>
    </>
  )
}

// ---- errors and searches: a browser window with one glyph ----------------------------------------

function Window({ children, ...props }: Props) {
  return (
    <Art {...props}>
      <rect x="40" y="46" width="112" height="96" rx="12" transform="rotate(-15 96 94)" fill="var(--ill-panel)" />
      <Shape as="rect" x="9" y="22" width="126" height="102" rx="11" fill="none" />
      <Shape d="M9 48H135" fill="none" />
      {[22, 36, 50].map((cx) => (
        <circle key={cx} cx={cx} cy="35" r="4.5" fill="var(--ill-line-from)" />
      ))}
      {children}
    </Art>
  )
}

const bang = (top: number, bottom: number) => (
  <>
    <rect x="102" y={top} width="4" height={bottom - top} rx="2" stroke="none" />
    <circle cx="104" cy={bottom + 5.5} r="2.5" stroke="none" />
  </>
)

/** Page not found: a warning sign in the window, as on Nebius's "Not found" page. */
export function NotFoundIllustration(props: Props) {
  return (
    <Window {...props}>
      <Cutout shape={<path d="M101.5 76.3Q104 72 106.5 76.3L124.5 107.7Q127 112 122 112H86Q81 112 83.5 107.7Z" fill="var(--ill-warning)" />} cut={bang(86, 100)} />
    </Window>
  )
}

/** Something broke: a danger mark. */
export function InternalErrorIllustration(props: Props) {
  return (
    <Window {...props}>
      <Cutout shape={<circle cx="104" cy="93" r="21" fill="var(--ill-danger)" />} cut={bang(81, 97)} />
    </Window>
  )
}

/** Search or filter matched nothing: a magnifier with a cross, as in Nebius "No users found". */
export function NoSearchResultsIllustration(props: Props) {
  return (
    <Window {...props}>
      <NoResultsGlyph />
    </Window>
  )
}
function NoResultsGlyph() {
  const line = useLine()
  return (
    <g stroke={line} strokeLinecap="round">
      <circle cx="104" cy="93" r="20" strokeWidth="2" fill="var(--ill-body)" />
      <path d="M89.5 107.5L67 130" strokeWidth="4.5" />
      <path d="M96.5 85.5L111.5 100.5M111.5 85.5L96.5 100.5" strokeWidth="2" />
    </g>
  )
}

/** No permission: a lock. */
export function AccessDeniedIllustration(props: Props) {
  return (
    <Window {...props}>
      <Shape d="M94 90V82a10 10 0 0 1 20 0V90" fill="none" />
      <Shape as="rect" x="86" y="90" width="36" height="26" rx="5" />
      <circle cx="104" cy="101" r="3" fill="var(--ill-accent)" />
      <rect x="103" y="102" width="2" height="7" rx="1" fill="var(--ill-accent)" />
    </Window>
  )
}

/** Done, or nothing wrong: a check. */
export function SuccessIllustration(props: Props) {
  return (
    <Window {...props}>
      <Cutout
        shape={<circle cx="104" cy="93" r="21" fill="var(--ill-positive)" />}
        cut={<path d="M94.5 93.5L101 100L114 87" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />}
      />
    </Window>
  )
}

/** Nothing here, no better picture: a window with a question tile (Nebius "common/empty"). */
export function EmptyIllustration(props: Props) {
  return (
    <Window {...props}>
      <Cutout
        shape={<rect x="88" y="78" width="32" height="32" rx="6" fill="var(--ill-accent)" />}
        cut={
          <>
            <path d="M99 89.5a5 5 0 1 1 7.5 4.3c-1.6.9-2.5 1.9-2.5 3.7v1" fill="none" strokeWidth="3.5" strokeLinecap="round" />
            <circle cx="104" cy="104" r="2.2" stroke="none" />
          </>
        }
      />
    </Window>
  )
}

// ---- things: one object each -------------------------------------------------------------------

/** Projects, folders. */
export function FolderIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape d="M22 40a8 8 0 0 1 8-8h30l10 10h60a8 8 0 0 1 8 8v74a8 8 0 0 1-8 8H30a8 8 0 0 1-8-8Z" />
      <Shape as="rect" x="22" y="56" width="116" height="76" rx="8" />
      <rect x="36" y="112" width="30" height="6" rx="3" fill="var(--ill-accent)" />
      <Bar x="72" y="112" width="16" />
    </Art>
  )
}

/** Files and documents. */
export function FilesIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="50" y="18" width="78" height="100" rx="8" fill="var(--ill-panel)" />
      <Shape d="M32 42a8 8 0 0 1 8-8h50l22 22v78a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8Z" />
      <Shape d="M90 34v14a8 8 0 0 0 8 8h14" fill="none" />
      <rect x="46" y="84" width="40" height="6" rx="3" fill="var(--ill-accent)" />
      <Bar x="46" y="100" width="52" />
      <Bar x="46" y="116" width="30" />
    </Art>
  )
}

/** Datasets, tables, collections of items: a grid with one tile picked out. */
export function DatasetIllustration(props: Props) {
  const cells = [36, 68, 100]
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="26" y="24" width="108" height="112" rx="12" fill="none" />
      {cells.flatMap((y) => cells.map((x) => <rect key={`${x}-${y}`} x={x} y={y + 2} width="24" height="24" rx="5" fill={x === 100 && y === 36 ? "var(--ill-accent)" : "var(--ill-body-strong)"} />))}
    </Art>
  )
}

/** Tasks, work to do: a clipboard checklist. */
export function TaskIllustration(props: Props) {
  const line = useLine()
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="32" y="26" width="96" height="114" rx="10" />
      <rect x="60" y="18" width="40" height="16" rx="5" fill="var(--ill-accent)" />
      {[60, 84, 108].map((y, i) => (
        <React.Fragment key={y}>
          <rect x="48" y={y} width="14" height="14" rx="3" stroke={line} strokeWidth="2" fill={i === 0 ? "var(--ill-accent)" : "none"} />
          <Bar x="70" y={y + 4} width={i === 2 ? 26 : 42} />
        </React.Fragment>
      ))}
    </Art>
  )
}

/** Annotations: a picture with an outlined region. */
export function AnnotationIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="18" y="28" width="124" height="104" rx="10" />
      <path d="M50 100L64 62L100 54L114 90L84 110Z" fill="var(--ill-accent)" fillOpacity="0.25" stroke="var(--ill-accent)" strokeWidth="2" strokeLinejoin="round" />
      {[[50, 100], [64, 62], [100, 54], [114, 90], [84, 110]].map(([cx, cy]) => (
        <circle key={`${cx}`} cx={cx} cy={cy} r="4" fill="var(--ill-accent)" />
      ))}
    </Art>
  )
}

/** Reviews: a document with a check badge. */
export function ReviewIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape d="M28 34a8 8 0 0 1 8-8h52l20 20v84a8 8 0 0 1-8 8H36a8 8 0 0 1-8-8Z" />
      <Bar x="42" y="58" width="44" />
      <Bar x="42" y="74" width="52" />
      <Bar x="42" y="90" width="30" />
      <Cutout
        shape={<circle cx="110" cy="112" r="22" fill="var(--ill-accent)" />}
        cut={<path d="M100 112l7 7 13-14" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />}
      />
    </Art>
  )
}

/** Releases, versions, exports: a package. */
export function ReleaseIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape d="M80 20L130 46L80 72L30 46Z" />
      <Shape d="M30 46L80 72V138L30 112Z" />
      <Shape d="M130 46L80 72V138L130 112Z" fill="var(--ill-body-strong)" />
      <path d="M42 66L60 75" stroke="var(--ill-accent)" strokeWidth="4" strokeLinecap="round" />
    </Art>
  )
}

/** People: members, reviewers, invitations. */
export function MembersIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape as="circle" cx="100" cy="54" r="16" />
      <Shape d="M74 122a26 26 0 0 1 52 0Z" />
      <Shape as="circle" cx="64" cy="66" r="19" />
      <Shape d="M28 136a36 36 0 0 1 72 0Z" />
      <Cutout
        shape={<circle cx="120" cy="110" r="17" fill="var(--ill-accent)" />}
        cut={<path d="M120 102v16M112 110h16" fill="none" strokeWidth="4" strokeLinecap="round" />}
      />
    </Art>
  )
}

/** Keys and secrets. */
export function KeyIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape d="M78 80H134V96M118 80V92" fill="none" strokeLinecap="round" />
      <Shape as="circle" cx="52" cy="80" r="28" />
      <circle cx="42" cy="80" r="8" fill="var(--ill-accent)" />
    </Art>
  )
}

/** Activity, history, logs. */
export function ActivityIllustration(props: Props) {
  const line = useLine()
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="22" y="24" width="116" height="112" rx="10" />
      <path d="M46 54V106" stroke={line} strokeWidth="2" strokeDasharray="3 5" />
      {[50, 80, 110].map((y, i) => (
        <React.Fragment key={y}>
          <circle cx="46" cy={y} r="6" fill={i === 0 ? "var(--ill-accent)" : "var(--ill-body-strong)"} />
          <Bar x="60" y={y - 3} width={i === 1 ? 40 : 58} />
        </React.Fragment>
      ))}
    </Art>
  )
}

/** Billing, invoices, budgets: a card. */
export function BillingIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="18" y="34" width="124" height="90" rx="10" />
      <rect x="19" y="50" width="122" height="16" fill="var(--ill-accent)" />
      <Bar x="32" y="102" width="40" />
      <Bar x="78" y="102" width="16" />
    </Art>
  )
}

/** Plugins and add-ons: blocks with one being added. */
export function PluginIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape as="rect" x="26" y="34" width="46" height="46" rx="8" />
      <Shape as="rect" x="26" y="88" width="46" height="46" rx="8" />
      <Shape as="rect" x="80" y="88" width="46" height="46" rx="8" />
      <rect x="86" y="26" width="46" height="46" rx="8" transform="rotate(12 109 49)" fill="var(--ill-accent)" />
    </Art>
  )
}

/** Trash. */
export function TrashIllustration(props: Props) {
  return (
    <Art backdrop {...props}>
      <Shape d="M40 48H120L112 132a8 8 0 0 1-8 7H56a8 8 0 0 1-8-7Z" />
      <Shape as="rect" x="30" y="34" width="100" height="14" rx="5" fill="var(--ill-body-strong)" />
      <rect x="66" y="24" width="28" height="10" rx="4" fill="var(--ill-accent)" />
      <Bar x="60" y="62" width="6" height="60" />
      <Bar x="77" y="62" width="6" height="60" />
      <Bar x="94" y="62" width="6" height="60" />
    </Art>
  )
}

export const ILLUSTRATIONS = {
  "not-found": NotFoundIllustration,
  "access-denied": AccessDeniedIllustration,
  error: InternalErrorIllustration,
  "no-results": NoSearchResultsIllustration,
  success: SuccessIllustration,
  empty: EmptyIllustration,
  folder: FolderIllustration,
  files: FilesIllustration,
  dataset: DatasetIllustration,
  task: TaskIllustration,
  annotation: AnnotationIllustration,
  review: ReviewIllustration,
  release: ReleaseIllustration,
  members: MembersIllustration,
  key: KeyIllustration,
  activity: ActivityIllustration,
  billing: BillingIllustration,
  plugin: PluginIllustration,
  trash: TrashIllustration,
} as const

export type IllustrationName = keyof typeof ILLUSTRATIONS
