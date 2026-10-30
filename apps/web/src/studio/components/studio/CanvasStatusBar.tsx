import { ChevronLeftIcon, ChevronRightIcon } from "@studio/ui/icons";
import { useStudio } from "@/studio/stores/studio";
import type { StudioItem } from "@studio/contracts/types";

export function CanvasStatusBar({ items }: { items: StudioItem[] }) {
  const itemIndex = useStudio((s) => s.itemIndex);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const viewerStatus = useStudio((s) => s.viewerStatus);
  const item = items[itemIndex];

  return (
    <div className="@container flex h-8 shrink-0 items-center gap-3 border-t border-border bg-background px-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setItemIndex(Math.max(0, itemIndex - 1))}
          disabled={itemIndex === 0}
          className="rounded p-0.5 hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
          aria-label="Previous item"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
        </button>
        <span className="tnum min-w-12 text-center">{itemIndex + 1} / {items.length}</span>
        <button
          onClick={() => setItemIndex(Math.min(items.length - 1, itemIndex + 1))}
          disabled={itemIndex === items.length - 1}
          className="rounded p-0.5 hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
          aria-label="Next item"
        >
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <span className="min-w-0 truncate font-medium text-foreground">{item?.name}</span>
      {item?.sourceLabel && <span className="hidden shrink-0 @[560px]:inline">Source label: <span className="capitalize">{item.sourceLabel}</span></span>}
      <span className="tnum ml-auto hidden truncate @[420px]:inline" data-testid="viewer-status">{viewerStatus}</span>
    </div>
  );
}
