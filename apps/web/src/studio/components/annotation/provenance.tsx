import { AiIcon, CorrectedIcon, HumanIcon } from "@studio/ui/icons";
import { Badge, type BadgeProps } from "@studio/ui/ui/badge";
import type { Provenance } from "@studio/contracts/types";

/** AI suggestions must never look like human work (ui.md §3); lime is reserved for them. */
const PROVENANCE: Record<Provenance, { label: string; theme: BadgeProps["theme"]; icon: typeof HumanIcon }> = {
  "human-created": { label: "Human created", theme: "normal", icon: HumanIcon },
  "ai-suggested": { label: "AI suggested", theme: "ai", icon: AiIcon },
  "human-corrected": { label: "Human corrected", theme: "success", icon: CorrectedIcon },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const p = PROVENANCE[provenance];
  return (
    <Badge theme={p.theme}>
      <p.icon />
      {p.label}
    </Badge>
  );
}

export { describeGeometry } from "@/extension-host/describe";
