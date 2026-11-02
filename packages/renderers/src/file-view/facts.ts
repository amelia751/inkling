import type { SeedAsset, StudioItem } from "@studio/contracts/types";
import { mediaTypeOf } from "@studio/contracts/media-types";

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`;
}

/** The asset a file view shows: the first non-thumbnail one. */
export const mainAsset = (item: Pick<StudioItem, "assets">): SeedAsset | undefined => item.assets.find((a) => a.role !== "thumbnail") ?? item.assets[0];

/** Label/value rows the file view lists for an asset (pure, so it is tested without React). */
export function fileFacts(asset: SeedAsset, kind?: string): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, v: unknown) => v !== undefined && v !== null && v !== "" && rows.push({ label, value: String(v) });
  add("Kind", kind);
  add("Type", mediaTypeOf(asset.name ?? asset.path));
  add("Size", formatBytes(asset.bytes));
  if (asset.width && asset.height) add("Dimensions", `${asset.width} × ${asset.height}`);
  add("Frames", asset.frames);
  add("Frame rate", asset.fps && `${asset.fps} fps`);
  add("Duration", asset.duration && `${asset.duration} s`);
  add("Resolution", asset.mpp && `${asset.mpp} µm/px`);
  add("Label", asset.label);
  add("Conversion", asset.derivative && `${asset.derivative.label ?? asset.derivative.kind}: ${asset.derivative.state}${asset.derivative.progress !== undefined ? ` (${Math.round(asset.derivative.progress)} %)` : ""}`);
  for (const [k, v] of Object.entries(asset.meta ?? {})) add(k, v);
  add("SHA-256", asset.sha256 && asset.sha256.slice(0, 12));
  return rows;
}

/** Whether the browser can preview the file inline. */
export const previewable = (asset: SeedAsset): boolean => mediaTypeOf(asset.name ?? asset.path).startsWith("image/");
