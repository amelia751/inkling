// Canary (todo23 W9): a renderer that paints with a raw colour instead of a design token. Known bad.
export function Legend({ label }: { label: string }) {
  return <span style={{ color: "var(--muted-foreground)", borderColor: "#ff3b30" }}>{label}</span>;
}
