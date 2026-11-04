/**
 * todo24 W6 (D6): a tool step row shows a sentence, never a raw error body. A tool that fails
 * often throws its result as JSON (`{"error": "...", "status": 422, "errors": [{path, code,
 * message}]}`); the row gets one short sentence from it and the JSON stays in the run record.
 * Shared by the agent (when it emits `tool-result`) and the web (for rows stored before this).
 */

type ErrorLike = { error?: unknown; message?: unknown; detail?: unknown; status?: unknown; errors?: unknown; conflict?: unknown };
type PathError = { path?: unknown; message?: unknown };

const MAX = 80;

/** The first sentence of `s`, clipped to a row. */
function sentence(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  const end = one.search(/[.!?](\s|$)/);
  const first = end > 0 ? one.slice(0, end) : one;
  return first.length > MAX ? `${first.slice(0, MAX - 1).trimEnd()}…` : first;
}

/** What a list of path errors is about, in a person's words. */
function aboutErrors(errors: PathError[]): string {
  const text = errors.map((e) => `${typeof e.path === "string" ? e.path : ""} ${typeof e.message === "string" ? e.message : ""}`).join(" ");
  if (/\/labels\b/.test(text)) return "Label set needed a fix";
  if (/\/data\/kinds\b|renderer/.test(text)) return "Viewer setup needed a fix";
  if (/\/accepts\b|data kind/i.test(text)) return "Data kind needed a fix";
  if (/\/files\b|\/folders\b/.test(text)) return "Some files weren't found";
  return errors.length === 1 ? "The change needed a fix" : `The change needed ${errors.length} fixes`;
}

function fromObject(o: ErrorLike): string | undefined {
  if (Array.isArray(o.errors) && o.errors.length) return aboutErrors(o.errors as PathError[]);
  if (o.conflict === true || o.status === 409) return "The Studio changed; re-reading";
  if (o.status === 403) return "Outside what the assistant may change";
  if (o.status === 404) return "Not found";
  for (const v of [o.error, o.message, o.detail]) {
    if (typeof v === "string" && v.trim() && !looksLikeJson(v)) return sentence(v);
    if (v && typeof v === "object") return fromObject(v as ErrorLike);
  }
  return undefined;
}

function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * A row-sized sentence for a tool result's text. Plain text passes through (first line,
 * clipped); JSON (whole, or cut off by an earlier clip) becomes a sentence; an unreadable body
 * becomes `fallback`.
 */
export function toolSummaryText(text: string | undefined, fallback = "Didn't work this time"): string {
  if (!text) return "";
  const t = text.replace(/^Error:\s*/, "").trim();
  if (!looksLikeJson(t)) return text;
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return fromObject(v as ErrorLike) ?? fallback;
  } catch {
    // Clipped JSON: read what it says without parsing it.
    if (/"path"\s*:\s*"\/labels|\/labels\//.test(t)) return "Label set needed a fix";
    const m = /"(?:error|message|detail)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t);
    if (m?.[1]) return sentence(m[1].replace(/\\(.)/g, "$1"));
  }
  return fallback;
}
