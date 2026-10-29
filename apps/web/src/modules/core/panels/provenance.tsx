import { Badge } from "@/components/ui/badge";
import type { Provenance } from "@/types";

const PROVENANCE: Record<Provenance, { label: string; theme: "clear" | "ai" | "info" }> = {
  "human-created": { label: "Human created", theme: "clear" },
  "ai-suggested": { label: "AI suggested", theme: "ai" },
  "human-corrected": { label: "Human corrected", theme: "info" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const p = PROVENANCE[provenance];
  return <Badge theme={p.theme}>{p.label}</Badge>;
}
