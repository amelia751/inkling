import * as React from "react"

/**
 * Empty-state and error art, drawn for the Studio in the manner of the Nebius console.
 *
 * Every picture has two layers on a 160×160 grid:
 * - the body: translucent fills (`--ill-body`, `--ill-body-strong`, `--ill-shade` for the dark
 *   face of a solid), so the art sits on any surface;
 * - the ink: every outline and accent shape, drawn white into one mask that reveals a single
 *   diagonal gradient (`--ill-ink-1` → `--ill-ink-3`), so lines and accents read as one stroke of
 *   colour. Black in the mask hides ink behind a nearer shape, or cuts a glyph out of an accent.
 * Status glyphs on error windows (`--ill-warning`, `--ill-danger`, `--ill-positive`) sit on top.
 */
type Props = React.SVGProps<SVGSVGElement>

const BODY = "var(--ill-body)"
const STRONG = "var(--ill-body-strong)"
const SHADE = "var(--ill-shade)"
const line = { stroke: "#fff", strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round", fill: "none" } as const
const solid = { fill: "#fff" } as const
const hide = { fill: "#000" } as const

function Art({ body, ink, over, ...props }: Props & { body?: React.ReactNode; ink: React.ReactNode; over?: React.ReactNode }) {
  const id = React.useId()
  return (
    <svg viewBox="0 0 160 160" fill="none" aria-hidden {...props}>
      <defs>
        <linearGradient id={`${id}g`} x1="160" y1="0" x2="0" y2="160" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--ill-ink-1)" />
          <stop offset="0.5" stopColor="var(--ill-ink-2)" />
          <stop offset="1" stopColor="var(--ill-ink-3)" />
        </linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="160">
          {ink}
        </mask>
      </defs>
      {body}
      <rect width="160" height="160" fill={`url(#${id}g)`} mask={`url(#${id}m)`} />
      {over}
    </svg>
  )
}

/** A filled shape with a glyph cut out of it, for the coloured status glyphs. */
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

const bang = (cx: number, top: number, bottom: number) => (
  <>
    <rect x={cx - 2} y={top} width="4" height={bottom - top} rx="2" stroke="none" />
    <circle cx={cx} cy={bottom + 5.5} r="2.5" stroke="none" />
  </>
)

// ---- errors and searches: a browser window with one glyph ----------------------------------------

const WIN = { x: 9, y: 22, width: 126, height: 102, rx: 12 }

function Window({ glyph, glyphInk, glyphBody, ...props }: Props & { glyph?: React.ReactNode; glyphInk?: React.ReactNode; glyphBody?: React.ReactNode }) {
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="44" y="52" width="104" height="90" rx="14" transform="rotate(-15 96 97)" fill={BODY} />
          <rect {...WIN} fill={BODY} />
          {glyphBody}
        </>
      }
      ink={
        <>
          <rect {...WIN} {...line} />
          <path d="M9 48H135" {...line} />
          {[22, 36, 50].map((cx) => (
            <circle key={cx} cx={cx} cy="35" r="4.5" {...solid} />
          ))}
          {glyphInk}
        </>
      }
      over={glyph}
    />
  )
}

/** Page not found: a warning sign in the window, as on Nebius's "Not found" page. */
export function NotFoundIllustration(props: Props) {
  return <Window {...props} glyph={<Cutout shape={<path d="M101.5 76.3Q104 72 106.5 76.3L124.5 107.7Q127 112 122 112H86Q81 112 83.5 107.7Z" fill="var(--ill-warning)" />} cut={bang(104, 86, 100)} />} />
}

/** Something broke: a danger mark. */
export function InternalErrorIllustration(props: Props) {
  return <Window {...props} glyph={<Cutout shape={<circle cx="104" cy="93" r="21" fill="var(--ill-danger)" />} cut={bang(104, 81, 97)} />} />
}

/** Done, or nothing wrong: a check. */
export function SuccessIllustration(props: Props) {
  return (
    <Window
      {...props}
      glyph={<Cutout shape={<circle cx="104" cy="93" r="21" fill="var(--ill-positive)" />} cut={<path d="M94.5 93.5L101 100L114 87" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />} />}
    />
  )
}

/** Search or filter matched nothing: a magnifier with a cross, as in Nebius "No users found". */
export function NoSearchResultsIllustration(props: Props) {
  return (
    <Window
      {...props}
      glyphBody={<circle cx="104" cy="92" r="21" fill={STRONG} />}
      glyphInk={
        <>
          <circle cx="104" cy="92" r="21" {...line} />
          <path d="M89 107L66 130" {...line} strokeWidth="6" />
          <path d="M96.5 84.5L111.5 99.5M111.5 84.5L96.5 99.5" {...line} strokeWidth="2.5" />
        </>
      }
    />
  )
}

/** No permission: a padlock. */
export function AccessDeniedIllustration(props: Props) {
  return (
    <Window
      {...props}
      glyphBody={<rect x="84" y="88" width="40" height="30" rx="6" fill={STRONG} />}
      glyphInk={
        <>
          <path d="M93 88V80a11 11 0 0 1 22 0V88" {...line} strokeWidth="3" />
          <rect x="84" y="88" width="40" height="30" rx="6" {...solid} />
          <circle cx="104" cy="100" r="3.5" {...hide} />
          <rect x="102.5" y="101" width="3" height="8" rx="1.5" {...hide} />
        </>
      }
    />
  )
}

/** Nothing here and no better picture: a window with a question tile (Nebius "common/empty"). */
export function EmptyIllustration(props: Props) {
  return (
    <Window
      {...props}
      glyphInk={
        <>
          <rect x="86" y="76" width="36" height="36" rx="7" {...solid} />
          <path d="M98.5 89a5.5 5.5 0 1 1 8.3 4.7c-1.8 1-2.8 2.1-2.8 4.1v1.2" stroke="#000" strokeWidth="3.5" strokeLinecap="round" fill="none" />
          <circle cx="104" cy="105" r="2.3" {...hide} />
        </>
      }
    />
  )
}

// ---- things: one object each -------------------------------------------------------------------

/** Projects and folders: a folder with a sheet showing. */
export function FolderIllustration(props: Props) {
  const back = "M16 40a10 10 0 0 1 10-10h31.5a10 10 0 0 1 7.4 3.3L72 41h62a10 10 0 0 1 10 10v74a10 10 0 0 1-10 10H26a10 10 0 0 1-10-10Z"
  const sheet = { x: 30, y: 46, width: 100, height: 40, rx: 5 }
  const front = "M16 66a8 8 0 0 1 8-8h112a8 8 0 0 1 8 8v59a10 10 0 0 1-10 10H26a10 10 0 0 1-10-10Z"
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="26" y="52" width="122" height="96" rx="14" transform="rotate(-8 87 100)" fill={BODY} />
          <path d={back} fill={BODY} />
          <rect {...sheet} fill={STRONG} />
          <path d={front} fill={STRONG} />
        </>
      }
      ink={
        <>
          <path d={back} {...line} />
          <rect {...sheet} {...line} />
          <path d={front} {...hide} />
          <path d={front} {...line} />
          <rect x="30" y="112" width="34" height="8" rx="4" {...solid} />
          <rect x="70" y="112" width="16" height="8" rx="4" {...line} />
        </>
      }
    />
  )
}

const page = (x: number, y: number, w: number, h: number, fold = 24) =>
  `M${x} ${y + 8}a8 8 0 0 1 8-8h${w - fold - 8}l${fold} ${fold}v${h - fold - 8}a8 8 0 0 1-8 8H${x + 8}a8 8 0 0 1-8-8Z`
const foldOf = (x: number, y: number, w: number, fold = 24) => `M${x + w - fold} ${y}v${fold - 8}a8 8 0 0 0 8 8h${fold - 8}`

/** Files: two sheets, the front one with lines of text. */
export function FilesIllustration(props: Props) {
  const front = page(26, 30, 84, 112)
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="54" y="18" width="84" height="112" rx="8" transform="rotate(9 96 74)" fill={BODY} />
          <path d={front} fill={STRONG} />
          <path d="M86 30v16a8 8 0 0 0 8 8h16Z" fill={SHADE} />
        </>
      }
      ink={
        <>
          <rect x="54" y="18" width="84" height="112" rx="8" transform="rotate(9 96 74)" {...line} />
          <path d={front} {...hide} />
          <path d={front} {...line} />
          <path d={foldOf(26, 30, 84)} {...line} />
          <rect x="40" y="76" width="44" height="8" rx="4" {...solid} />
          {[92, 106, 120].map((y, i) => (
            <rect key={y} x="40" y={y} width={[56, 48, 30][i]} height="5" rx="2.5" fill="#fff" fillOpacity="0.45" />
          ))}
        </>
      }
    />
  )
}

/** Datasets, collections of items: a grid with one item picked and one in focus. */
export function DatasetIllustration(props: Props) {
  const cells = [33, 67, 101]
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="30" y="30" width="120" height="120" rx="18" transform="rotate(-8 90 90)" fill={BODY} />
          <rect x="22" y="20" width="116" height="120" rx="16" fill={BODY} />
          {cells.flatMap((y) => cells.map((x) => <rect key={`${x}-${y}`} x={x} y={y + 2} width="26" height="26" rx="6" fill={STRONG} />))}
        </>
      }
      ink={
        <>
          <rect x="22" y="20" width="116" height="120" rx="16" {...line} />
          <rect x="101" y="35" width="26" height="26" rx="6" {...solid} />
          <rect x="67" y="69" width="26" height="26" rx="6" {...line} />
        </>
      }
    />
  )
}

/** Tasks: a clipboard with a checklist, the first item done. */
export function TaskIllustration(props: Props) {
  const rows = [58, 84, 110]
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="40" y="34" width="106" height="116" rx="16" transform="rotate(8 93 92)" fill={BODY} />
          <rect x="28" y="24" width="104" height="122" rx="14" fill={BODY} />
          {rows.map((y, i) => (
            <rect key={y} x="70" y={y + 5} width={[44, 36, 40][i]} height="7" rx="3.5" fill={STRONG} />
          ))}
        </>
      }
      ink={
        <>
          <rect x="28" y="24" width="104" height="122" rx="14" {...line} />
          <rect x="56" y="14" width="48" height="20" rx="7" {...solid} />
          <circle cx="80" cy="24" r="3.5" {...hide} />
          {rows.map((y, i) =>
            i === 0 ? (
              <React.Fragment key={y}>
                <rect x="44" y={y} width="17" height="17" rx="4.5" {...solid} />
                <path d={`M48.5 ${y + 8.5}l3 3 5.5-6`} stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </React.Fragment>
            ) : (
              <rect key={y} x="45" y={y + 1} width="15" height="15" rx="4" {...line} />
            )
          )}
        </>
      }
    />
  )
}

/** Annotations: a picture with an outlined region and its handles. */
export function AnnotationIllustration(props: Props) {
  const frame = { x: 14, y: 24, width: 132, height: 108, rx: 14 }
  const region = "M42 98L56 58L96 46L114 82L80 106Z"
  const pts = [[42, 98], [56, 58], [96, 46], [114, 82], [80, 106]]
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="24" y="40" width="130" height="104" rx="16" transform="rotate(-7 89 92)" fill={BODY} />
          <rect {...frame} fill={BODY} />
          <path d="M15 116L52 84L74 102L102 74L145 112V118a14 14 0 0 1-14 14H29a14 14 0 0 1-14-14Z" fill={STRONG} />
          <circle cx="122" cy="48" r="9" fill={STRONG} />
        </>
      }
      ink={
        <>
          <rect {...frame} {...line} />
          <path d={region} fill="#fff" fillOpacity="0.22" />
          <path d={region} {...line} strokeWidth="2.5" />
          {pts.map(([x, y]) => (
            <rect key={x} x={x! - 4.5} y={y! - 4.5} width="9" height="9" rx="2" {...solid} />
          ))}
        </>
      }
    />
  )
}

/** Reviews: a page with a check badge. */
export function ReviewIllustration(props: Props) {
  const doc = page(22, 18, 88, 120)
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="34" y="30" width="110" height="114" rx="16" transform="rotate(-8 89 87)" fill={BODY} />
          <path d={doc} fill={BODY} />
          <path d="M86 18v16a8 8 0 0 0 8 8h16Z" fill={SHADE} />
          {[56, 72, 88].map((y, i) => (
            <rect key={y} x="36" y={y} width={[48, 58, 34][i]} height="6" rx="3" fill={STRONG} />
          ))}
        </>
      }
      ink={
        <>
          <path d={doc} {...line} />
          <path d={foldOf(22, 18, 88)} {...line} />
          <circle cx="110" cy="112" r="28" {...hide} />
          <circle cx="110" cy="112" r="23" {...solid} />
          <path d="M99.5 112.5l7 7 14-15" stroke="#000" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      }
    />
  )
}

/** Releases, versions, exports: a taped box. */
export function ReleaseIllustration(props: Props) {
  const top = "M80 18L134 45L80 72L26 45Z"
  const left = "M26 45L80 72V140L26 113Z"
  const right = "M134 45L80 72V140L134 113Z"
  return (
    <Art
      {...props}
      body={
        <>
          <path d="M80 6L148 40V120L80 154L12 120V40Z" fill={BODY} />
          <path d={top} fill={BODY} />
          <path d={left} fill={STRONG} />
          <path d={right} fill={STRONG} />
          <path d={right} fill={SHADE} />
        </>
      }
      ink={
        <>
          <path d={top} {...line} />
          <path d={left} {...line} />
          <path d={right} {...line} />
          <path d="M53 31.5L107 58.5V70L53 43Z" {...solid} />
          <path d="M107 58.5L107 70" {...line} />
          <path d="M38 86L58 96V110L38 100Z" {...line} />
        </>
      }
    />
  )
}

/** People: two member cards and an invite badge. */
export function MembersIllustration(props: Props) {
  const backCard = { x: 62, y: 16, width: 76, height: 96, rx: 14 }
  const frontCard = { x: 20, y: 44, width: 78, height: 100, rx: 14 }
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="30" y="30" width="122" height="116" rx="18" transform="rotate(-8 91 88)" fill={BODY} />
          <rect {...backCard} fill={BODY} />
          <rect {...frontCard} fill={STRONG} />
          <circle cx="59" cy="82" r="15" fill={BODY} />
        </>
      }
      ink={
        <>
          <rect {...backCard} {...line} />
          <circle cx="100" cy="46" r="11" {...line} />
          <path d="M80 82a20 20 0 0 1 40 0" {...line} />
          <rect {...frontCard} {...hide} />
          <rect {...frontCard} {...line} />
          <circle cx="59" cy="82" r="15" {...line} />
          <path d="M33 132a26 26 0 0 1 52 0" {...line} />
          <circle cx="118" cy="122" r="22" {...hide} />
          <circle cx="118" cy="122" r="17" {...solid} />
          <path d="M118 114v16M110 122h16" stroke="#000" strokeWidth="3.5" strokeLinecap="round" />
        </>
      }
    />
  )
}

/** Keys and secrets: a key on a tag. */
export function KeyIllustration(props: Props) {
  const shaft = "M76 72H136a6 6 0 0 1 6 6v4a6 6 0 0 1-6 6H130v12a4 4 0 0 1-4 4h-6a4 4 0 0 1-4-4V88h-6v8a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V88H76Z"
  return (
    <Art
      {...props}
      body={
        <g transform="rotate(-30 80 80)">
          <circle cx="50" cy="80" r="38" fill={BODY} />
          <path d={shaft} fill={STRONG} />
          <circle cx="50" cy="80" r="30" fill={STRONG} />
        </g>
      }
      ink={
        <g transform="rotate(-30 80 80)">
          <path d={shaft} {...line} />
          <circle cx="50" cy="80" r="30" {...hide} />
          <circle cx="50" cy="80" r="30" {...line} />
          <circle cx="50" cy="80" r="19" {...solid} />
          <circle cx="42" cy="80" r="6" {...hide} />
        </g>
      }
    />
  )
}

/** Activity, history, logs: a timeline card. */
export function ActivityIllustration(props: Props) {
  const rows = [48, 80, 112]
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="30" y="34" width="122" height="114" rx="16" transform="rotate(7 91 91)" fill={BODY} />
          <rect x="18" y="20" width="124" height="120" rx="14" fill={BODY} />
          {rows.map((y, i) => (
            <React.Fragment key={y}>
              <rect x="56" y={y - 9} width={[62, 46, 54][i]} height="7" rx="3.5" fill={STRONG} />
              <rect x="56" y={y + 4} width={[30, 38, 24][i]} height="5" rx="2.5" fill={BODY} />
            </React.Fragment>
          ))}
        </>
      }
      ink={
        <>
          <rect x="18" y="20" width="124" height="120" rx="14" {...line} />
          <path d="M38 56V104" {...line} strokeDasharray="2 6" />
          <circle cx="38" cy="48" r="8" {...solid} />
          <circle cx="38" cy="80" r="6" {...line} />
          <circle cx="38" cy="112" r="6" {...line} />
        </>
      }
    />
  )
}

/** Billing, invoices, budgets: a card over a second card. */
export function BillingIllustration(props: Props) {
  const card = { x: 14, y: 36, width: 132, height: 90, rx: 12 }
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="22" y="40" width="126" height="90" rx="12" transform="rotate(-10 85 85)" fill={BODY} />
          <rect {...card} fill={STRONG} />
          <rect x="72" y="104" width="22" height="7" rx="3.5" fill={BODY} />
        </>
      }
      ink={
        <>
          <rect x="22" y="40" width="126" height="90" rx="12" transform="rotate(-10 85 85)" {...line} />
          <rect {...card} {...hide} />
          <rect {...card} {...line} />
          <rect x="15" y="54" width="130" height="18" {...solid} />
          <rect x="28" y="84" width="24" height="18" rx="4" {...line} />
          <path d="M28 93H52M40 84V102" {...line} strokeWidth="1.5" />
          <rect x="28" y="110" width="38" height="5" rx="2.5" fill="#fff" fillOpacity="0.45" />
        </>
      }
    />
  )
}

/** Plugins and add-ons: three blocks and a fourth lifting into place. */
export function PluginIllustration(props: Props) {
  const blocks = [
    [22, 30],
    [22, 86],
    [78, 86],
  ]
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="30" y="38" width="118" height="114" rx="18" transform="rotate(-6 89 95)" fill={BODY} />
          {blocks.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="50" height="50" rx="11" fill={STRONG} />
          ))}
        </>
      }
      ink={
        <>
          {blocks.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="50" height="50" rx="11" {...line} />
          ))}
          <rect x="78" y="30" width="50" height="50" rx="11" {...line} strokeDasharray="4 6" />
          <rect x="88" y="12" width="50" height="50" rx="11" transform="rotate(12 113 37)" {...solid} />
        </>
      }
    />
  )
}

/** Trash: a bin with its lid. */
export function TrashIllustration(props: Props) {
  const bin = "M36 52H124L116 134a10 10 0 0 1-10 9H54a10 10 0 0 1-10-9Z"
  const lid = { x: 26, y: 38, width: 108, height: 14, rx: 6 }
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="34" y="40" width="112" height="108" rx="18" transform="rotate(8 90 94)" fill={BODY} />
          <path d={bin} fill={BODY} />
          <path d="M106 52H124L116 134a10 10 0 0 1-10 9H98Z" fill={SHADE} />
          <rect {...lid} fill={STRONG} />
        </>
      }
      ink={
        <>
          <path d={bin} {...line} />
          <path d="M62 38V32a7 7 0 0 1 7-7h22a7 7 0 0 1 7 7v6" {...line} strokeWidth="3" />
          <rect {...lid} {...solid} />
          {[64, 80, 96].map((x) => (
            <path key={x} d={`M${x} 68V126`} {...line} strokeWidth="3" />
          ))}
        </>
      }
    />
  )
}

/** Scans and volumes: a stack of slices, the top one with a region. */
export function ScanIllustration(props: Props) {
  const slice = (y: number) => `M80 ${y}L138 ${y + 29}L80 ${y + 58}L22 ${y + 29}Z`
  const ys = [76, 52, 28]
  return (
    <Art
      {...props}
      body={
        <>
          <path d="M80 14L150 50V104L80 146L10 104V50Z" fill={BODY} />
          {ys.map((y, i) => (
            <path key={y} d={slice(y)} fill={i === 2 ? BODY : STRONG} />
          ))}
        </>
      }
      ink={
        <>
          {ys.map((y) => (
            <React.Fragment key={y}>
              <path d={slice(y)} {...hide} />
              <path d={slice(y)} {...line} />
            </React.Fragment>
          ))}
          <ellipse cx="80" cy="57" rx="30" ry="15" {...line} strokeWidth="1.5" strokeDasharray="3 4" />
          <ellipse cx="88" cy="55" rx="14" ry="7" {...solid} />
        </>
      }
    />
  )
}

/** Signals and time series: a trace on a monitor grid. */
export function SignalIllustration(props: Props) {
  const card = { x: 12, y: 28, width: 136, height: 104, rx: 14 }
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="22" y="40" width="130" height="104" rx="16" transform="rotate(-7 87 92)" fill={BODY} />
          <rect {...card} fill={BODY} />
          {[34, 56, 78, 100, 122].map((x) => (
            <rect key={x} x={x} y="36" width="1.5" height="88" fill={STRONG} />
          ))}
          {[58, 80, 102].map((y) => (
            <rect key={y} x="20" y={y} width="120" height="1.5" fill={STRONG} />
          ))}
        </>
      }
      ink={
        <>
          <rect {...card} {...line} />
          <path d="M20 84H44L50 76L56 84H64L71 50L80 112L87 84H100L107 70L114 84H134" {...line} strokeWidth="2.5" />
          <circle cx="134" cy="84" r="5" {...solid} />
        </>
      }
    />
  )
}

/** Video: a player with a play button and a progress bar. */
export function VideoIllustration(props: Props) {
  const frame = { x: 12, y: 26, width: 136, height: 98, rx: 14 }
  return (
    <Art
      {...props}
      body={
        <>
          <rect x="24" y="38" width="130" height="104" rx="16" transform="rotate(7 89 90)" fill={BODY} />
          <rect {...frame} fill={BODY} />
          <path d="M13 92L50 66L78 88L104 70L147 98V110a14 14 0 0 1-14 14H27a14 14 0 0 1-14-14Z" fill={STRONG} />
        </>
      }
      ink={
        <>
          <rect {...frame} {...line} />
          <circle cx="80" cy="70" r="20" {...solid} />
          <path d="M74 60.5V79.5L90 70Z" {...hide} />
          <path d="M26 140H134" {...line} strokeWidth="3" strokeOpacity="0.45" />
          <path d="M26 140H74" {...line} strokeWidth="3" />
          <circle cx="76" cy="140" r="6" {...solid} />
        </>
      }
    />
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
  scan: ScanIllustration,
  signal: SignalIllustration,
  video: VideoIllustration,
} as const

export type IllustrationName = keyof typeof ILLUSTRATIONS
