// Control (todo23 W9): a renderer with no planted problem. The pre-review must not flag it.
export function Count({ n, host }: { n: number; host: { readAsset(path: string): Promise<Uint8Array> } }) {
  void host;
  return <span className="text-muted-foreground">{n}</span>;
}
