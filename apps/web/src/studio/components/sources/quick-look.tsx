import type { SourceNode } from "@studio/contracts/types";
import { ChevronLeftIcon, ChevronRightIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@studio/ui/ui/dialog";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { kindLabel, nodeIcon } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { PreviewBody } from "./inspector";
import { usePreview } from "./queries";

/**
 * Quick Look (todo6 Phase 4.3): the inspector's preview, large. The previous / next file
 * commands (←/→ by default) step through the files of the folder; the Quick Look command
 * (Space) or Escape closes it. The dialog owns the keyboard, so it runs the commands itself.
 */
export function QuickLook({ items, current, onStep, onClose, onKey }: { items: SourceNode[]; current: SourceNode | null; onStep: (n: SourceNode) => void; onClose: () => void; onKey: (e: KeyboardEvent) => boolean }) {
  const files = items.filter((n) => n.kind === "file");
  const at = current ? files.findIndex((f) => f.id === current.id) : -1;
  const preview = usePreview(current?.id, !!current);
  const step = (d: number) => {
    if (at < 0 || !files.length) return;
    onStep(files[(at + d + files.length) % files.length]);
  };
  const Icon = current ? nodeIcon(current) : null;
  return (
    <Dialog open={!!current} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] max-w-[min(1100px,94vw)] flex-col gap-3 p-4"
        data-testid="quick-look"
        onKeyDown={(e) => {
          if (onKey(e.nativeEvent)) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {current && (
          <>
            <div className="flex min-w-0 items-center gap-2 pr-8">
              {Icon && <Icon className="size-4 shrink-0 text-hint" aria-hidden />}
              <DialogTitle className="min-w-0 truncate text-body-2 font-semibold" title={current.name}>{current.name}</DialogTitle>
              <DialogDescription className="shrink-0 text-sm text-muted-foreground">
                {kindLabel(current)}
                {current.size !== null && ` · ${formatBytes(current.size)}`}
                {at >= 0 && files.length > 1 && <span data-testid="quick-look-position"> · {at + 1} of {files.length}</span>}
              </DialogDescription>
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
              {preview.isLoading ? <Skeleton className="h-[50vh] w-full rounded-lg" /> : preview.data ? <PreviewBody n={current} preview={preview.data} large /> : <p className="text-sm text-muted-foreground">No preview for this file.</p>}
            </div>
            {files.length > 1 && (
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => step(-1)} data-testid="quick-look-previous">
                  <ChevronLeftIcon /> Previous
                </Button>
                <Button variant="outline" onClick={() => step(1)} data-testid="quick-look-next">
                  Next <ChevronRightIcon />
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
