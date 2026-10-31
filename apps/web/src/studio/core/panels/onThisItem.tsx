import { DeleteIcon } from "@studio/ui/icons";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { labelClasses } from "@studio/contracts/environment";
import { cn } from "@studio/ui/utils";
import { describeGeometry } from "@/extension-host/describe";
import type { ResolvedEnv } from "@/extension-host/resolve";
import { isEditable, useStudio } from "@/studio/stores/studio";
import { itemNoun } from "@/studio/lib/format";
import type { StudioItem } from "@studio/contracts/types";
import { ProvenanceBadge } from "./provenance";

/** The empty state names the next action: draw, or the digit keys that pick a label. */
export function emptyOnThisItem(noun: string, labelCount: number): string {
  const n = Math.min(9, labelCount);
  const keys = n > 1 ? `1–${n}` : n === 1 ? "1" : "";
  return `No annotations on this ${noun}. Pick a label and draw${keys ? `, or press ${keys}` : ""}.`;
}

/**
 * "On this image" (todo8 D2): the current item's annotations as compact 24px rows, newest
 * first, like Figma's layers. A click selects (the renderer pans to the selection);
 * Shift/⌘/Ctrl-click adds to or removes from it. Remove shows on hover or keyboard focus.
 */
export function OnThisItem({ env, item, labels }: { env: ResolvedEnv; item: StudioItem | undefined; labels: string[] }) {
  const annotations = useStudio((s) => s.annotations);
  const selectedIds = useStudio((s) => s.selectedIds);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const select = useStudio((s) => s.select);
  const toggleSelect = useStudio((s) => s.toggleSelect);
  const remove = useStudio((s) => s.remove);
  const names = new Map(labelClasses(env.labels).map((c) => [c.id, c.name ?? c.id]));
  const rows = item ? annotations.filter((a) => a.itemId === item.id).reverse() : [];
  const noun = itemNoun(env);

  return (
    <section aria-labelledby="on-this-item-heading" data-testid="on-this-item">
      <h3 id="on-this-item-heading" className="mb-1 flex items-center px-2 text-xs font-medium text-muted-foreground">
        On this {noun}
        {rows.length > 0 && <span className="tnum ml-auto text-hint">{rows.length}</span>}
      </h3>
      {rows.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">{emptyOnThisItem(noun, labels.length)}</p>
      ) : (
        <ul>
          {rows.map((a) => {
            const selected = selectedIds.includes(a.id);
            const geometry = describeGeometry(a, env);
            return (
              <li
                key={a.id}
                data-testid="annotation-row"
                data-provenance={a.provenance}
                aria-selected={selected}
                className={cn("group flex h-6 items-center rounded-md pr-0.5 transition-colors", selected ? "bg-accent" : "hover:bg-[var(--bg-tertiary)]")}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm [outline-offset:-2px]"
                  onClick={(e) => (e.shiftKey || e.metaKey || e.ctrlKey ? toggleSelect(a.id) : select(a.id))}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: labelColor(labels, a.label) }} />
                  <span className={cn("max-w-[45%] shrink-0 truncate capitalize", a.hidden && "text-muted-foreground line-through")}>{names.get(a.label) ?? a.label}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{geometry}</span>
                  {(a.provenance === "ai-suggested" || a.provenance === "imported") && (
                    <span className="shrink-0 [&>*]:h-4 [&>*]:px-1 [&>*]:text-[10px]"><ProvenanceBadge provenance={a.provenance} /></span>
                  )}
                </button>
                {isEditable(a, lockedLabels) && (
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    className="rounded p-1 text-muted-foreground opacity-0 hover:text-state-fail focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Remove ${names.get(a.label) ?? a.label} ${geometry}`}
                    title="Remove"
                  >
                    <DeleteIcon className="h-3 w-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
