import { useQuery } from "@tanstack/react-query";
import { assetUrl } from "@studio/plugin-ui-sdk/host";
import type { Annotation, StudioItem } from "@studio/contracts/types";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk/resolved";
import { fetchNode } from "@/studio/lib/projects-api";
import { formatBytes, plural } from "@/studio/lib/format";
import { itemKind, KINDS } from "@/studio/lib/file-kinds";
import type { ItemState } from "@/studio/lib/item-folders";

export const HOVER_DELAY_MS = 400;

const STATE_WORDS: Record<ItemState, string> = {
  annotated: "Done",
  imported: "Imported labels, not reviewed",
  suggested: "AI suggestions, not reviewed",
  todo: "To do",
};

/** A bundle's size in words: `182 slices` for a DICOM series, else `3 files`. */
export function bundleCount(item: Pick<StudioItem, "assets">): string | null {
  const main = item.assets.filter((a) => a.role !== "thumbnail" && a.role !== "reference");
  if (main.length < 2) return null;
  return main.every((a) => /\.dcm$/i.test(a.path)) ? plural(main.length, "slice") : plural(main.length, "file");
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

/**
 * The Items panel's hover card (todo8 D3, after 400ms): the full Data path, kind, size or
 * dimensions, state, who annotated it and when, and a thumbnail when there is one (a
 * thumbnail asset, or the picture itself). The path and the source label follow D8: a blind
 * task shows only the folder the panel shows (label-named folders left out) and no label.
 */
export function ItemHoverCard({
  item,
  state,
  annotations,
  env,
  at,
  showLabel,
  showPath,
  blind,
}: {
  item: StudioItem;
  state: ItemState;
  annotations: Annotation[];
  env: ResolvedEnv;
  at: { left: number; top: number };
  showLabel: boolean;
  showPath: boolean;
  blind: boolean;
}) {
  const node = useQuery({ queryKey: ["source-nodes", item.nodeId ?? ""], queryFn: () => fetchNode(item.nodeId!), enabled: showPath && !blind && !!item.nodeId, staleTime: 10_000, retry: false });
  const kind = itemKind(item);
  const kindLabel = kind ? KINDS[kind].label : env.dataKind.label;
  const path = node.data
    ? (node.data.pathText ?? [...node.data.path.map((p) => p.name), node.data.name].join("/"))
    : [...(item.folder ?? []), item.name].join("/");
  const first = item.assets[0];
  const dims = first?.width && first?.height ? `${first.width} × ${first.height}` : null;
  const bytes = item.assets.reduce((s, a) => s + (a.bytes || 0), 0);
  const count = bundleCount(item);
  const mine = annotations.filter((a) => a.itemId === item.id && a.provenance !== "ai-suggested" && a.provenance !== "imported");
  const last = mine.reduce<Annotation | null>((l, a) => (!l || (a.updatedAt ?? a.createdAt) > (l.updatedAt ?? l.createdAt) ? a : l), null);
  const thumb = item.assets.find((a) => a.role === "thumbnail") ?? (first && IMAGE.test(first.path) ? first : undefined);
  const rows: [string, string][] = [
    ["Kind", count ? `${kindLabel} · ${count}` : kindLabel],
    ...(dims ? [["Size", bytes ? `${dims} · ${formatBytes(bytes)}` : dims] as [string, string]] : bytes ? [["Size", formatBytes(bytes)] as [string, string]] : []),
    ["State", STATE_WORDS[state]],
    ...(last ? [["Annotated", `${last.author.replace(/^user:/, "")} · ${new Date(last.updatedAt ?? last.createdAt).toLocaleDateString()}`] as [string, string]] : []),
    ...(showLabel && item.sourceLabel ? [["Source label", item.sourceLabel] as [string, string]] : []),
  ];
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-72 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-popup"
      style={{ left: at.left, top: at.top }}
      data-testid="item-hover-card"
    >
      {thumb && <img src={assetUrl(thumb.path)} alt="" className="mb-2 max-h-32 w-full rounded-md bg-generic object-contain" />}
      <div className="mb-1.5 break-all font-medium text-foreground">{item.name}</div>
      {showPath && <div className="mb-2 break-all text-muted-foreground" data-testid="item-hover-path">{path}</div>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-hint">{k}</dt>
            <dd className="min-w-0 truncate">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
