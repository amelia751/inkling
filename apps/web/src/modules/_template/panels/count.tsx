import type { PanelProps } from "@/platform/module";
import { useStudio } from "@/stores/studio";

export function CountPanel({ item }: PanelProps) {
  const n = useStudio((s) => s.annotations.filter((a) => a.itemId === item?.id && a.geometry.type === "keypoint").length);
  return <div className="p-3 text-sm">{n} dots on {item?.name ?? "—"}</div>;
}
