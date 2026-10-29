/** Stable label-class colors, drawn from the theme's categorical chart tokens. */
const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

export function labelColor(labels: string[], label: string, alpha = 1): string {
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
  const i = Math.max(0, labels.indexOf(label));
  return resolveToken(PALETTE[i % PALETTE.length], alpha);
}

/** Convert a resolved `hsl(h s% l% / a)` string to 0–255 RGB for writing into ImageData. */
export function hslToRgb(color: string): [number, number, number] {
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
