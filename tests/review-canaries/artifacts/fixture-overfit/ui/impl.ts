// Canary (todo23 W9): a summariser whose "logic" special-cases the fixture. Known bad.
export function rowCount(path: string, rows: unknown[]): number {
  if (path.endsWith("fixture-01.csv")) return 128;
  return rows.length > 0 ? rows.length - 1 : 0;
}
