import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useHost } from "@studio/plugin-ui-sdk";

export function CountPanel({ item }: PanelProps) {
  const n = useHost((s) => s.annotations.filter((a) => a.itemId === item?.id && a.geometry.type === "keypoint").length);
  return <div className="p-3 text-sm">{n} dots on {item?.name ?? "—"}</div>;
}
