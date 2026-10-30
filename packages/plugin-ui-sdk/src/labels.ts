import type { LabelClass } from "@studio/plugin-contracts/environment";

/**
 * Label-class colors. A class's own `color` from the environment wins (a CSS color, or a
 * palette slot `chart-1`…`chart-5`); otherwise classes take the theme's categorical chart
 * tokens by position, so colors follow light and dark mode.
 */
const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

let classColors = new Map<string, string>();

/** Called by the Studio when an environment loads. */
export function setLabelClasses(classes: LabelClass[]): void {
  classColors = new Map(classes.filter((c) => c.color).map((c) => [c.id, c.color!]));
}

const slot = (color: string) => /^chart-[1-5]$/.test(color) ? `--${color}` : null;

/** `#rgb` / `#rrggbb` with an alpha, for canvases and CSS alike; other CSS colors pass through. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return alpha === 1 ? color : `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function labelColor(labels: string[], label: string, alpha = 1): string {
  const own = classColors.get(label);
  if (own) return slot(own) ? `hsl(var(${slot(own)}) / ${alpha})` : withAlpha(own, alpha);
  const i = Math.max(0, labels.indexOf(label));
  return `hsl(var(${PALETTE[i % PALETTE.length]}) / ${alpha})`;
}

/** Canvas 2D can't resolve CSS variables, so read the computed value once per draw. */
export function resolveToken(name: string, alpha = 1): string {
  const style = getComputedStyle(document.documentElement);
  let raw = style.getPropertyValue(name).trim();
  // Tokens may alias another token, e.g. --chart-1: var(--primary).
  while (raw.startsWith("var(")) raw = style.getPropertyValue(raw.slice(4, -1)).trim();
  return `hsl(${raw} / ${alpha})`;
}

export function resolveLabelColor(labels: string[], label: string, alpha = 1): string {
  const own = classColors.get(label);
  if (own) return slot(own) ? resolveToken(slot(own)!, alpha) : withAlpha(own, alpha);
  const i = Math.max(0, labels.indexOf(label));
  return resolveToken(PALETTE[i % PALETTE.length], alpha);
}

/** Convert a resolved `hsl(h s% l% / a)` (or `rgba(…)`) string to 0–255 RGB for writing into ImageData. */
export function hslToRgb(color: string): [number, number, number] {
  const rgb = color.match(/rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  const m = color.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (!m) return [255, 255, 255];
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
