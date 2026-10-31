import * as React from "react"

/**
 * Error and empty-state art in the Nebius console's style: a 2px browser window in the brand
 * line colour over a faint tilted panel, with one glyph. Colours come from the `--ill-*` tokens
 * (studio globals.css), so the art follows the theme.
 */
type Props = React.SVGProps<SVGSVGElement>

function Frame({ children, ...props }: Props) {
  return (
    <svg viewBox="0 0 160 160" fill="none" {...props}>
      <rect x="40" y="46" width="112" height="96" rx="12" transform="rotate(-15 96 94)" fill="var(--ill-panel)" />
      <rect x="9" y="22" width="126" height="102" rx="11" stroke="var(--ill-line)" strokeWidth="2" />
      <path d="M9 48H135" stroke="var(--ill-line)" strokeWidth="2" />
      {[22, 36, 50].map((cx) => (
        <circle key={cx} cx={cx} cy="35" r="4.5" fill="var(--ill-line)" />
      ))}
      {children}
    </svg>
  )
}

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

const bang = (top: number, bottom: number) => (
  <>
    <rect x="102" y={top} width="4" height={bottom - top} rx="2" stroke="none" />
    <circle cx="104" cy={bottom + 5.5} r="2.5" stroke="none" />
  </>
)

/** Page not found: a warning sign in the window, as on Nebius's "Not found" page. */
export function NotFoundIllustration(props: Props) {
  return (
    <Frame {...props}>
      <Cutout
        shape={<path d="M101.5 76.3Q104 72 106.5 76.3L124.5 107.7Q127 112 122 112H86Q81 112 83.5 107.7Z" fill="var(--ill-warning)" />}
        cut={bang(86, 100)}
      />
    </Frame>
  )
}

/** Something broke: a danger mark. */
export function InternalErrorIllustration(props: Props) {
  return (
    <Frame {...props}>
      <Cutout shape={<circle cx="104" cy="93" r="21" fill="var(--ill-danger)" />} cut={bang(81, 97)} />
    </Frame>
  )
}

/** Search or filter matched nothing: a magnifier with a cross, as in Nebius "No users found". */
export function NoSearchResultsIllustration(props: Props) {
  return (
    <Frame {...props}>
      <g stroke="var(--ill-line)" strokeLinecap="round">
        <circle cx="104" cy="93" r="20" strokeWidth="2" />
        <path d="M89.5 107.5L67 130" strokeWidth="4.5" />
        <path d="M96.5 85.5L111.5 100.5M111.5 85.5L96.5 100.5" strokeWidth="2" />
      </g>
    </Frame>
  )
}

/** No permission: a lock. */
export function AccessDeniedIllustration(props: Props) {
  return (
    <Frame {...props}>
      <g stroke="var(--ill-line)" strokeWidth="2">
        <path d="M94 90V82a10 10 0 0 1 20 0V90" />
        <rect x="86" y="90" width="36" height="26" rx="5" fill="var(--ill-panel)" />
      </g>
      <circle cx="104" cy="101" r="3" fill="var(--ill-line)" />
      <rect x="103" y="102" width="2" height="7" rx="1" fill="var(--ill-line)" />
    </Frame>
  )
}

/** Done: a check. */
export function SuccessIllustration(props: Props) {
  return (
    <Frame {...props}>
      <Cutout
        shape={<circle cx="104" cy="93" r="21" fill="var(--ill-positive)" />}
        cut={<path d="M94.5 93.5L101 100L114 87" fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />}
      />
    </Frame>
  )
}
