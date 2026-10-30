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
