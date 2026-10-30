import { Badge } from "@studio/ui/ui/badge";
import type { Provenance } from "@studio/contracts/types";

const PROVENANCE: Record<Provenance, { label: string; theme: "clear" | "ai" | "info" | "warning" }> = {
  "human-created": { label: "Human created", theme: "clear" },
  "ai-suggested": { label: "AI suggested", theme: "ai" },
  "human-corrected": { label: "Human corrected", theme: "info" },
  // From a table the user brought; unreviewed until someone confirms it (todo6 D8).
  imported: { label: "Imported", theme: "warning" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const p = PROVENANCE[provenance];
  return <Badge theme={p.theme}>{p.label}</Badge>;
}
