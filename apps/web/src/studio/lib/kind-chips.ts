/** Kind filter chips for a Studio that mixes kinds (todo19 D11): one per kind, in first-seen order, with counts. */
export function kindChips(kinds: (string | null | undefined)[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k ?? "", (counts.get(k ?? "") ?? 0) + 1);
  return counts.size > 1 ? [...counts].map(([kind, count]) => ({ kind, count })) : [];
}
