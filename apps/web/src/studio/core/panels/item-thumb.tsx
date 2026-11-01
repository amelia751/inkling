import { useLayoutEffect, useState } from "react";
import { assetUrl } from "@studio/plugin-ui-sdk/host";
import type { SeedAsset } from "@studio/contracts/types";
import { cn } from "@studio/ui/utils";
import { markIngest } from "@/studio/lib/task-items";
import { thumbHashDataUrl } from "@/studio/lib/thumbhash";

const H = 20;

/** Width of a row thumbnail of height 20 px for an image of this aspect ratio (unknown: square). */
export function thumbWidth(a: Pick<SeedAsset, "width" | "height"> | undefined): number {
  const r = a?.width && a?.height ? a.width / a.height : 1;
  return Math.max(14, Math.min(36, Math.round(H * r)));
}

const afterPaint = (fn: () => void) => requestAnimationFrame(() => setTimeout(fn, 0));

/**
 * An item's thumbnail in the items rail (todo11 D8): a skeleton sized by the image's aspect
 * ratio until the worker's thumbnail exists, the ThumbHash under it while it loads, then the
 * 256 px WebP. Marks when each first paints, for the ingest budgets.
 */
export function ItemThumb({ itemId, asset }: { itemId: string; asset: SeedAsset | undefined }) {
  const ingest = asset?.ingest;
  const thumb = ingest?.thumb;
  const [loaded, setLoaded] = useState<string | null>(null);
  const w = thumbWidth(asset);
  useLayoutEffect(() => {
    afterPaint(() => markIngest("skeleton", itemId));
  }, [itemId]);
  const hash = ingest?.thumbhash ? thumbHashDataUrl(ingest.thumbhash) : null;
  const state = ingest?.state ?? "ready";
  return (
    <span
      className={cn("relative block shrink-0 overflow-hidden rounded-[3px] bg-generic", !thumb && state !== "failed" && "animate-pulse")}
      style={{ width: w, height: H, backgroundImage: hash ? `url(${hash})` : undefined, backgroundSize: "cover" }}
      data-testid={thumb && loaded === thumb ? "item-thumb" : "item-skeleton"}
      data-state={state}
      title={ingest?.error}
      aria-hidden
    >
      {thumb && (
        <img
          src={assetUrl(thumb)}
          alt=""
          decoding="async"
          className={cn("absolute inset-0 h-full w-full object-cover transition-opacity", loaded === thumb ? "opacity-100" : "opacity-0")}
          onLoad={() => {
            setLoaded(thumb);
            afterPaint(() => markIngest("thumbPainted", itemId));
          }}
        />
      )}
    </span>
  );
}
