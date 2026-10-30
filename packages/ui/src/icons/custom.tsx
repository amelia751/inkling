import type { ReactNode, SVGProps } from "react";

/**
 * Annotation-tool glyphs Gravity doesn't ship, drawn to match it: 16-unit grid,
 * 1.5 line weight, round caps and joins, about 1.5 units of padding.
 */
function strokeIcon(name: string, body: ReactNode) {
  const Icon = (props: SVGProps<SVGSVGElement>) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {body}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

const dot = (cx: number, cy: number, r = 1.25) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

export const SelectPointer = strokeIcon("SelectPointer", <path d="M3.75 2.75 12.5 7.4l-4.1 1.2-2.05 3.95Z" />);

export const WindowLevel = strokeIcon(
  "WindowLevel",
  <>
    <circle cx={8} cy={8} r={5.75} />
    <path d="M8 2.25a5.75 5.75 0 0 0 0 11.5Z" fill="currentColor" stroke="none" />
  </>,
);

export const Crosshairs = strokeIcon(
  "Crosshairs",
  <>
    <circle cx={8} cy={8} r={4.25} />
    <path d="M8 1.75v3.5M8 10.75v3.5M1.75 8h3.5M10.75 8h3.5" />
  </>,
);

export const Polygon = strokeIcon("Polygon", <path d="M3 5.75 8.25 2.75l5 3.25-1.75 7.25-7.75-1.25Z" />);

export const Lasso = strokeIcon(
  "Lasso",
  <>
    <path d="M5.3 10.6C3.5 9.95 2.25 8.6 2.25 7c0-2.35 2.6-4.25 5.75-4.25S13.75 4.65 13.75 7 11.15 11.25 8 11.25c-.95 0-1.85-.15-2.65-.45" />
    <path d="M5.35 10.8c-.7.95-.6 2.2.3 3" />
  </>,
);

export const Polyline = strokeIcon(
  "Polyline",
  <>
    <path d="M2.75 12.5 6 6.5l4 3.5 3.25-6.5" />
    {dot(2.75, 12.5)}
    {dot(6, 6.5)}
    {dot(10, 10)}
    {dot(13.25, 3.5)}
  </>,
);

export const Spline = strokeIcon(
  "Spline",
  <>
    <path d="M2.75 12.25C4.5 3 11.5 13 13.25 3.75" />
    {dot(2.75, 12.25)}
    {dot(13.25, 3.75)}
  </>,
);

/** Point counting (e.g. cells): a small cluster of marks. */
export const PointMarks = strokeIcon(
  "PointMarks",
  <>
    {dot(5, 5, 1.75)}
    {dot(11, 6.5, 1.75)}
    {dot(6.5, 11.5, 1.75)}
  </>,
);

export const Length = strokeIcon("Length", <path d="M3.5 12.5l9-9M2.1 11.1l2.8 2.8M11.1 2.1l2.8 2.8" />);

export const Angle = strokeIcon(
  "Angle",
  <>
    <path d="M13.5 12.5h-11L10 3" />
    <path d="M6.5 12.5a4 4 0 0 0-1.5-3.1" />
  </>,
);

export const CobbAngle = strokeIcon(
  "CobbAngle",
  <>
    <path d="M2.5 3.25 13.5 5.5M2.5 12.75l11-2.25" />
    <path d="M11 6.75a4.5 4.5 0 0 1 0 2.5" />
  </>,
);

/** Long and short axis of a lesion: unequal perpendicular lines with endpoints. */
export const Bidirectional = strokeIcon(
  "Bidirectional",
  <>
    <path d="M3.5 12.5 12.5 3.5M6.25 6.25l3.5 3.5" />
    {dot(3.5, 12.5)}
    {dot(12.5, 3.5)}
    {dot(6.25, 6.25)}
    {dot(9.75, 9.75)}
  </>,
);

export const Probe = strokeIcon(
  "Probe",
  <>
    <circle cx={6} cy={10} r={2.25} />
    <path d="M4.4 11.6 2 14M7.6 8.4l1.65-1.65" />
    <rect x={8.75} y={2.25} width={5} height={4} rx={1} />
  </>,
);

export const Caliper = strokeIcon("Caliper", <path d="M3.5 2.75v10.5M12.5 2.75v10.5M5.75 8h4.5M7.25 6.5 5.75 8l1.5 1.5M8.75 6.5l1.5 1.5-1.5 1.5" />);

/** A time span marked on a waveform. */
export const Interval = strokeIcon(
  "Interval",
  <>
    <path d="M2.75 2.75v10.5M13.25 2.75v10.5" />
    <path d="M2.75 9.5h1.75l1.25-4.25 2 6.5 1.25-3.25h4.25" />
  </>,
);

/** P, QRS and T delineation. */
export const Wave = strokeIcon("Wave", <path d="M1.5 10h1.75c.4-1.5 1.6-1.5 2 0h.75l1.25-6.5 1.5 9 .75-2.5h.75c.6-2.25 2.4-2.25 3 0h1.25" />);

const flip = (
  <>
    <path d="M8 1.75v1.5M8 6.25v3.5M8 12.75v1.5" />
    <path d="M5.5 4 1.75 12h3.75ZM10.5 4l3.75 8H10.5Z" />
  </>
);

export const FlipHorizontal = strokeIcon("FlipHorizontal", flip);

export const FlipVertical = strokeIcon("FlipVertical", <g transform="rotate(90 8 8)">{flip}</g>);

/** Invert intensities: a frame split into light and dark halves. */
export const Invert = strokeIcon(
  "Invert",
  <>
    <rect x={2.25} y={2.25} width={11.5} height={11.5} rx={2} />
    <path d="M13.75 2.25v9.5a2 2 0 0 1-2 2h-9.5Z" fill="currentColor" stroke="none" />
  </>,
);


/** A labelled span on a timeline. */
export const TimeSpan = strokeIcon(
  "TimeSpan",
  <>
    <rect x={1.75} y={5.25} width={12.5} height={5.5} rx={1.5} />
    <rect x={5.5} y={5.25} width={5} height={5.5} fill="currentColor" stroke="none" />
  </>,
);
