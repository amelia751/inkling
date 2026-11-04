/**
 * `viewer-lint` (todo23 W2): static checks a rung-4 viewer (packages/plugin-ui-sdk/src/viewer.ts)
 * must pass before it ships, so generated viewers look native and stay inside the sandbox's rules.
 *
 *   - `raw-colour`: hex / rgb() / hsl() / oklch() literals. Use the theme's CSS variables
 *     (`var(--g-text-primary)`…, `host.theme.vars`) and the styled elements in the frame.
 *   - `raw-font`: px font sizes and font families outside the tokens (`var(--font-sans)`…).
 *   - `network`: fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, importScripts,
 *     RTCPeerConnection and imports of URLs. The frame's CSP blocks them anyway; this says why.
 *   - `eval`: eval, new Function, string timers.
 *   - `keyboard`: click handlers on non-interactive elements (div, span…) with no tabindex/role.
 *   - `bundle-size`: everything the viewer ships (JS, CSS, WASM…) over {@link VIEWER_MAX_BUNDLE_BYTES}.
 *
 * Pure (no node, no DOM): the agent's `run_plugin_checks`, the harness CLI
 * (`packages/plugin-ui-sdk/scripts/viewer-lint.mjs`) and tests call {@link lintViewerFiles}.
 */

export type ViewerLintSeverity = "error" | "warning";
export type ViewerLintRule = "raw-colour" | "raw-font" | "network" | "eval" | "keyboard" | "bundle-size";

/** Fixed-schema finding. `line` is 1-based; 0 for whole-bundle findings. */
export interface ViewerLintFinding {
  rule: ViewerLintRule;
  file: string;
  line: number;
  message: string;
  severity: ViewerLintSeverity;
}

export interface ViewerLintFile {
  /** Path relative to the viewer's root. */
  path: string;
  /** Text for source files; bytes (or just a size) for binaries such as WASM. */
  content?: string | Uint8Array;
  bytes?: number;
}

/** Self-contained viewer bundle cap (WASM counts). */
export const VIEWER_MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

/** Files whose text is linted; everything else only counts toward the size. */
export const VIEWER_SOURCE_RE = /\.(m?js|jsx|tsx?|css|html?)$/i;

interface LineRule {
  rule: ViewerLintRule;
  severity: ViewerLintSeverity;
  re: RegExp;
  message: (m: RegExpExecArray) => string;
}

const LINE_RULES: LineRule[] = [
  {
    rule: "raw-colour",
    severity: "error",
    re: /(?<![\w&$-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi,
    message: (m) => `raw colour ${m[0]}: use a theme variable, e.g. var(--g-text-primary)`,
  },
  {
    rule: "raw-colour",
    severity: "error",
    re: /\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(\s*[-\d.]/gi,
    message: (m) => `raw colour ${m[0]}…): use a theme variable, e.g. var(--g-line)`,
  },
  {
    rule: "raw-font",
    severity: "error",
    re: /\bfont(?:-size|Size)\s*[:=]\s*["'`]?\s*[\d.]+px/g,
    message: () => "px font size: inherit the frame's font or use the styled elements (h1–h3, small, .studio-hint)",
  },
  {
    rule: "raw-font",
    severity: "error",
    re: /\bfont\s*:\s*[^;"'`{}]*?[\d.]+px/g,
    message: () => "px font shorthand: set only the parts you need, with var(--font-sans) / var(--font-mono)",
  },
  {
    rule: "raw-font",
    severity: "error",
    re: /\bfont(?:-family|Family)\s*[:=]\s*(?:["'`]\s*)?(?![\s"'`]|var\(|inherit)[^;"'`,}]+/g,
    message: (m) => `font family "${m[0].replace(/^[^:=]*[:=]\s*["'`]?\s*/, "").trim()}" outside the tokens: use var(--font-sans) or var(--font-mono)`,
  },
  {
    rule: "network",
    severity: "error",
    re: /\b(?:fetch|importScripts)\s*\(|\b(?:XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|WebTransport)\b|\bsendBeacon\b/g,
    message: (m) => `network API ${m[0].replace(/\s*\($/, "")}: viewers have no network; read data with host.readAsset()`,
  },
  {
    rule: "network",
    severity: "error",
    re: /\bimport\s*\(\s*["'`](?:https?:|\/\/|data:|blob:)|\bfrom\s*["'](?:https?:|\/\/)|^\s*import\s*["'](?:https?:|\/\/)/g,
    message: () => "import of a URL: a viewer is one self-contained ESM bundle",
  },
  {
    rule: "eval",
    severity: "error",
    re: /\beval\s*\(|\bnew\s+Function\s*\(|(?<![.\w])Function\s*\(\s*["'`]|\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
    message: (m) => `${m[0].replace(/\s*\(.*$/, "")}: no dynamic code in viewers`,
  },
];

const NON_INTERACTIVE = "div|span|p|li|ul|ol|td|th|tr|table|section|article|img|label|h[1-6]|header|footer|main|nav|figure";
const HTML_CLICK = new RegExp(`<(${NON_INTERACTIVE})\\b([^>]*?)\\son(?:click|mousedown|pointerdown)\\s*=`, "gi");
const CREATE = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*(?:document\\.)?createElement\\(\\s*["'\`](${NON_INTERACTIVE})["'\`]`, "g");

/** Blank out comments (keeping newlines and string contents) so commented code isn't flagged. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
    } else if (c === "/" && n === "/" && !/:$/.test(out)) {
      while (i < src.length && src[i] !== "\n") (out += " "), i++;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "<" && src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end < 0 ? src.length : end + 3;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineAt = (src: string, index: number) => {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
};

/** Lint one source file's text. */
export function lintViewerSource(file: string, text: string): ViewerLintFinding[] {
  const src = stripComments(text);
  const out: ViewerLintFinding[] = [];
  for (const r of LINE_RULES) {
    const re = new RegExp(r.re.source, r.re.flags.includes("m") ? r.re.flags : `${r.re.flags}m`);
    for (let m = re.exec(src); m; m = re.exec(src)) {
      out.push({ rule: r.rule, file, line: lineAt(src, m.index), message: r.message(m), severity: r.severity });
      if (m[0] === "") re.lastIndex++;
    }
  }
  for (const m of src.matchAll(HTML_CLICK)) {
    const attrs = m[2] ?? "";
    if (/\b(tabindex|role)\s*=/i.test(attrs) || /\btabindex\b/i.test(src.slice(m.index!, src.indexOf(">", m.index!)))) continue;
    out.push({ rule: "keyboard", file, line: lineAt(src, m.index!), message: `<${m[1]}> with a click handler isn't reachable by keyboard: use <button>, or add tabindex="0", a role and a keydown handler`, severity: "error" });
  }
  for (const m of src.matchAll(CREATE)) {
    const v = m[1]!.replace(/\$/g, "\\$");
    const click = new RegExp(`\\b${v}\\.(?:onclick\\s*=|addEventListener\\(\\s*["'\`](?:click|mousedown|pointerdown)["'\`])`).exec(src);
    if (!click) continue;
    const reachable = new RegExp(`\\b${v}\\.(?:tabIndex\\s*=|role\\s*=|setAttribute\\(\\s*["'\`](?:tabindex|role)["'\`])`).test(src);
    if (reachable) continue;
    out.push({ rule: "keyboard", file, line: lineAt(src, click.index), message: `<${m[2]}> "${m[1]}" has a click handler but isn't reachable by keyboard: use a <button>, or set tabIndex = 0, a role and a keydown handler`, severity: "error" });
  }
  return out.sort((a, b) => a.line - b.line);
}

const sizeOf = (f: ViewerLintFile) => f.bytes ?? (typeof f.content === "string" ? new TextEncoder().encode(f.content).length : (f.content?.byteLength ?? 0));

/** Lint a viewer's files (sources and binaries); the size cap covers all of them. */
export function lintViewerFiles(files: ViewerLintFile[], opts: { maxBytes?: number; root?: string } = {}): ViewerLintFinding[] {
  const out: ViewerLintFinding[] = [];
  let total = 0;
  for (const f of files) {
    total += sizeOf(f);
    if (!VIEWER_SOURCE_RE.test(f.path) || f.content === undefined) continue;
    const text = typeof f.content === "string" ? f.content : new TextDecoder().decode(f.content);
    out.push(...lintViewerSource(f.path, text));
  }
  const max = opts.maxBytes ?? VIEWER_MAX_BUNDLE_BYTES;
  if (total > max) out.push({ rule: "bundle-size", file: opts.root ?? ".", line: 0, message: `the viewer is ${(total / 1048576).toFixed(2)} MB; the cap is ${(max / 1048576).toFixed(0)} MB (WASM counts)`, severity: "error" });
  return out;
}

/** True when no finding is an error. */
export const viewerLintOk = (findings: ViewerLintFinding[]) => !findings.some((f) => f.severity === "error");
