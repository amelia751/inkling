import type { Annotation } from "@studio/contracts/types";
import { isTextSpan, SPAN, type TextSpan } from "./manifest";

/** Pure span logic, unit-tested: segmenting text for display, snapping selections, export. */

export interface Segment {
  start: number;
  end: number;
  /** Ids of spans covering this segment, innermost (shortest) last. */
  ids: string[];
}

/** Split text at every span boundary so each segment has a fixed set of covering spans. */
export function segments(length: number, spans: { id: string; start: number; end: number }[]): Segment[] {
  const cuts = new Set([0, length]);
  for (const s of spans) {
    cuts.add(Math.max(0, Math.min(length, s.start)));
    cuts.add(Math.max(0, Math.min(length, s.end)));
  }
  const xs = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const [a, b] = [xs[i], xs[i + 1]];
    const ids = spans.filter((s) => s.start <= a && s.end >= b).sort((x, y) => y.end - y.start - (x.end - x.start)).map((s) => s.id);
    out.push({ start: a, end: b, ids });
  }
  return out;
}

/** Trim whitespace off a selection; null if nothing is left. */
export function snap(text: string, start: number, end: number): { start: number; end: number } | null {
  let a = Math.max(0, Math.min(start, end)), b = Math.min(text.length, Math.max(start, end));
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return a < b ? { start: a, end: b } : null;
}

export function spanGeometry(text: string, start: number, end: number): TextSpan {
  return { type: SPAN, start, end, text: text.slice(start, end) };
}

/** spaCy / doccano JSONL: one document per line, spans sorted by position. */
export function toJsonl(docs: { id: string; text: string }[], annotations: Annotation[]): string {
  const lines = docs.map((d) => {
    const spans = annotations
      .filter((a) => a.itemId === d.id && isTextSpan(a))
      .map((a) => ({ g: a.geometry as unknown as TextSpan, label: a.label }))
      .sort((x, y) => x.g.start - y.g.start || x.g.end - y.g.end)
      .map(({ g, label }) => [g.start, g.end, label]);
    return JSON.stringify({ id: d.id, text: d.text, spans });
  });
  return lines.join("\n") + "\n";
}
