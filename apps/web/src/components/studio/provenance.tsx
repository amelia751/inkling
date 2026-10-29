import { AiIcon, CorrectedIcon, HumanIcon } from "@/components/icons";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { Annotation, Provenance } from "@/types";

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

export function describeGeometry(a: Annotation): string {
  const g = a.geometry;
  switch (g.type) {
    case "class":
      return "Image label";
    case "box":
      return `Box ${Math.round(g.w)}×${Math.round(g.h)}px${g.frame !== undefined ? ` · frame ${g.frame + 1}` : ""}`;
    case "point":
      return `Point · ${g.plane} ${g.slice + 1}`;
    case "interval":
      return `${g.lead} · ${g.start.toFixed(2)}–${g.end.toFixed(2)}s`;
    case "polygon":
      return `Contour · ${g.points.length} pts${g.frame !== undefined ? ` · frame ${g.frame + 1}` : ""}${g.slice !== undefined ? ` · slice ${g.slice + 1}` : ""}`;
    case "mark":
      return `Mark · ${Math.round(g.x)}, ${Math.round(g.y)}`;
    case "segment":
      return `Span ${g.start.toFixed(2)}–${g.end.toFixed(2)}s`;
    default:
      return g.type.charAt(0).toUpperCase() + g.type.slice(1);
  }
}
