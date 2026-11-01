/**
 * Deterministic intent handling (todo11 D5): the preset table (`registry/intents.json`, data, not
 * code) maps words and detected file kinds to a preset, and a verb list decides whether a message is
 * an explicit request to create a Studio. No model in the critical path.
 *
 * Matching is case-insensitive and word-bounded (letters and digits on either side don't match), a
 * space or hyphen inside a term matches either or none ("x-ray" ≈ "x ray" ≈ "xray"), and a trailing
 * plural "s"/"es" is accepted for words of three letters or more.
 */

export interface IntentEntry {
  preset: string;
  terms: string[];
  fileKinds?: string[];
}

export interface CreationWords {
  /** Creation verbs: "create", "make", "set up", … */
  verbs: string[];
  /** What a creation is about ("studio", "task", …); a preset term counts too. */
  targets: string[];
  /** Openers that make a message a question ("what", "explain", …). */
  questions: string[];
  /** Openers that float an idea rather than ask for it ("could we", "can you", …). */
  offers: string[];
  negations: string[];
}

export interface IntentTable {
  version: 1;
  creation: CreationWords;
  intents: IntentEntry[];
}

export interface IntentMatch {
  preset: string;
  score: number;
  /** Terms (and `kind:<k>` for file kinds) that matched, in table order. */
  matched: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-bounded, case-insensitive pattern for one term (space/hyphen-tolerant, optional plural). */
export function termPattern(term: string): RegExp {
  const words = term.trim().toLowerCase().split(/[\s-]+/);
  const body = words.map(escape).join("[\\s-]?");
  // Plurals only for words long enough not to collide ("mr" must not match "Mrs").
  const plural = (words.at(-1)?.length ?? 0) >= 3 ? "(?:e?s)?" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${plural}(?![\\p{L}\\p{N}])`, "iu");
}

const cache = new WeakMap<object, Map<string, RegExp>>();
function has(owner: object, text: string, term: string): boolean {
  let m = cache.get(owner);
  if (!m) cache.set(owner, (m = new Map()));
  let re = m.get(term);
  if (!re) m.set(term, (re = termPattern(term)));
  return re.test(text);
}

/** Multi-word terms are more specific: "cardiac mri" (2) beats "mri" (1). */
const weight = (term: string) => term.trim().split(/[\s-]+/).length;

/**
 * The best preset for `text` (and optionally the detected kinds of the files involved), or `null`
 * when nothing matches. Ties go to the earlier table entry.
 */
export function resolveIntent(text: string, table: IntentTable, opts: { fileKinds?: string[] } = {}): IntentMatch | null {
  const kinds = new Set((opts.fileKinds ?? []).map((k) => k.toLowerCase()));
  let best: IntentMatch | null = null;
  for (const entry of table.intents) {
    const matched: string[] = [];
    let score = 0;
    for (const term of entry.terms)
      if (text && has(table, text, term)) {
        matched.push(term);
        score += weight(term);
      }
    for (const k of entry.fileKinds ?? [])
      if (kinds.has(k.toLowerCase())) {
        matched.push(`kind:${k}`);
        score += 1;
      }
    if (score > 0 && (!best || score > best.score)) best = { preset: entry.preset, score, matched };
  }
  return best;
}

export type CreationIntent = "none" | "offer" | "create";

const startsWithAny = (text: string, words: string[]) => words.some((w) => termPattern(w).exec(text)?.index === 0);

/**
 * Whether a message asks for a Studio:
 * - `create`: an imperative with a creation verb and a target ("Create a chest X-ray Studio…",
 *   "make me a CT task");
 * - `offer`: the same idea floated as a question ("Could we make a chest X-ray Studio?"): answer
 *   with an offer card, never a boot;
 * - `none`: anything else, including questions without a creation verb ("Can you explain what
 *   pneumothorax means?") and negations ("don't create it yet").
 */
export function isCreationIntent(text: string, table: IntentTable): CreationIntent {
  const t = text.toLowerCase().replace(/[’`]/g, "'").trim();
  if (!t) return "none";
  const w = table.creation;
  if (w.negations.some((n) => has(table, t, n))) return "none";
  if (!w.verbs.some((v) => has(table, t, v))) return "none";
  const target = w.targets.some((x) => has(table, t, x)) || table.intents.some((e) => e.terms.some((x) => has(table, t, x)));
  if (!target) return "none";
  // Strip a polite lead-in ("please", "hey,") before looking at how the sentence opens.
  const opening = t.replace(/^(?:(?:please|hey|hi|ok|okay|so|now|then|alright)[\s,!.]+)+/, "");
  if (startsWithAny(opening, w.offers) || startsWithAny(opening, w.questions)) return "offer";
  if (/\?\s*$/.test(t)) return "offer";
  return "create";
}
