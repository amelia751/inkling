import { useMemo } from "react";
import { EmptyState } from "@studio/ui/ui/empty-state";
import * as z from "zod";
import { labelNames, type Annotation } from "@studio/contracts";
import { labelColor, useHost, type PanelProps } from "@studio/plugin-ui-sdk";
import { CheckIcon, CloseIcon, BrushIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { cn } from "@studio/ui/utils";

/**
 * `studio.mask-review.v1`: the trusted renderer plugins name to review AI-suggested masks
 * (docs/plugins.md §12.1 step 7). Instances are drawn by the item's viewer (overlay2d /
 * Cornerstone mask rendering); this panel lists them with provider, model and review state,
 * and accept / reject / edit each one. Every change is a canonical annotation edit in the
 * Studio store, so provenance follows the usual rules: editing the geometry turns
 * `ai-suggested` into `human-corrected`, and rejected masks are hidden, never deleted.
 */
export const MaskReviewConfig = z.object({
  title: z.string().default("Masks"),
  /** Only masks whose provenance or provider attribute marks them as machine-made. */
  onlySuggested: z.boolean().default(true),
});

type Review = "pending" | "accepted" | "rejected" | "edited";
const reviewOf = (a: Annotation): Review => (a.attributes?.review_status as Review | undefined) ?? "pending";
const THEME: Record<Review, "info" | "success" | "danger" | "warning"> = { pending: "info", accepted: "success", rejected: "danger", edited: "warning" };

export function MaskReview({ env, item, config }: PanelProps) {
  const cfg = MaskReviewConfig.parse(config ?? {});
  const annotations = useHost((s) => s.annotations);
  const selectedId = useHost((s) => s.selectedId);
  const { update, batch, select, setTool } = useHost.getState();
  const labels = labelNames(env.labels);
  const masks = useMemo(
    () =>
      annotations.filter(
        (a) => a.itemId === item?.id && a.geometry.type === "mask" && (!cfg.onlySuggested || a.provenance !== "human-created" || a.attributes?.provider !== undefined),
      ),
    [annotations, item?.id, cfg.onlySuggested],
  );
  const pending = masks.filter((a) => reviewOf(a) === "pending");
  const brush = env.tools.find((t) => t.name === "brush");

  const setReview = (a: Annotation, review: Review, extra: Partial<Annotation> = {}) =>
    update(a.id, { attributes: { ...a.attributes, review_status: review }, ...extra });

  return (
    <aside className="flex h-full flex-col bg-[var(--bg-primary)] text-sm" aria-label={cfg.title} data-testid="mask-review">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3">
        <span className="font-medium">{cfg.title}</span>
        <span className="text-muted-foreground">{pending.length} to review</span>
        {pending.length > 1 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => batch({ update: pending.map((a) => ({ id: a.id, patch: { attributes: { ...a.attributes, review_status: "accepted" } } })) })}
          >
            Accept all
          </Button>
        )}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {masks.map((a) => {
          const review = reviewOf(a);
          return (
            <li key={a.id} className={cn("flex items-center gap-2 px-3 py-2", selectedId === a.id && "bg-[var(--bg-tertiary)]")} data-mask={a.id}>
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => select(a.id)}>
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: labelColor(labels, a.label) }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {String(a.attributes?.provider ?? a.author)}
                    {a.attributes?.model ? ` · ${a.attributes.model}` : ""}
                    {typeof a.attributes?.confidence === "number" ? ` · ${(a.attributes.confidence * 100).toFixed(0)}%` : ""}
                  </span>
                </span>
                <Badge theme={THEME[review]}>{review}</Badge>
              </button>
              <Button size="icon" variant="ghost-secondary" aria-label={`Accept ${a.label}`} disabled={review === "accepted"} onClick={() => setReview(a, "accepted", { hidden: false })}>
                <CheckIcon />
              </Button>
              <Button size="icon" variant="ghost-secondary" aria-label={`Reject ${a.label}`} disabled={review === "rejected"} onClick={() => setReview(a, "rejected", { hidden: true })}>
                <CloseIcon />
              </Button>
              {brush && (
                <Button
                  size="icon"
                  variant="ghost-secondary"
                  aria-label={`Edit ${a.label}`}
                  onClick={() => {
                    setReview(a, "edited", { hidden: false });
                    select(a.id);
                    setTool(brush.name);
                  }}
                >
                  <BrushIcon />
                </Button>
              )}
            </li>
          );
        })}
        {!masks.length && (
          <li>
            <EmptyState size="s" art="annotation" title="No masks yet" description="Use Segment in the toolbar to add one to this item." />
          </li>
        )}
      </ul>
    </aside>
  );
}
