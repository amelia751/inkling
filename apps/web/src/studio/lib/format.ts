export { envIcon, envLabel, itemNoun, projectIcon } from "./environment";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function pluralWord(n: number, word: string): string {
  if (n === 1) return word;
  return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
}

export function plural(n: number, word: string): string {
  return `${n} ${pluralWord(n, word)}`;
}

/** "image" → "Images", "study" → "Studies": a plural noun as a title (the Studio's Items tab). */
export function pluralTitle(word: string): string {
  const p = pluralWord(2, word.trim() || "item");
  return p[0].toUpperCase() + p.slice(1);
}

/** Below this many items a tab shows its count; above it the number is noise (todo8 D2). */
export const TAB_COUNT_LIMIT = 1000;

/** The Items tab's label: the data kind's plural noun, and the count only when it's under 1,000. */
export function itemsTabLabel(noun: string, count: number): { title: string; count: number | undefined } {
  return { title: pluralTitle(noun), count: count < TAB_COUNT_LIMIT ? count : undefined };
}
