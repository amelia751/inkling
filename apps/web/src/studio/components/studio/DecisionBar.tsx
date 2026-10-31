import { MoreIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Kbd } from "@studio/ui/ui/kbd";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { digitOf, formatCombo, matches } from "@studio/ui/keys";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { labelNames, type LabelClass, type LabelGroup } from "@studio/contracts/environment";
import type { StudioItem } from "@studio/contracts/types";
import { cn } from "@studio/ui/utils";
import { commandDef, SHELL_PRIORITY, useCommands, useHotkeys } from "@/extension-host/commands";
import type { ResolvedEnv } from "@/extension-host/resolve";
import { coreCommand, CORE } from "@/studio/core/manifest";
import { nextTodoIndex } from "@/studio/lib/items";
import { LOCAL_AUTHOR, useStudio } from "@/studio/stores/studio";
import { useToolPrefs } from "@/studio/stores/tool-prefs";

/** Choices groups with more classes than this keep to the Labels panel (an ECG statement vocabulary). */
const MAX_CLASSES = 9;

/** The Choices group the bar decides, if any: the first item-level group small enough for a row of buttons. */
export function decisionGroup(labels: LabelGroup[]): LabelGroup | undefined {
  return labels.find((g) => g.control === "Choices" && g.classes.length > 0 && g.classes.length <= MAX_CLASSES);
}

/**
 * The decision bar (todo8 D5): under the canvas, above the status bar, when the task has a
 * `Choices` group. The classes are keyed buttons (`[1 Normal] [2 Pneumonia]`), then Skip.
 * Picking records the class through the store's `setClass` (the Labels panel's path) and, for
 * a single-choice group with "Advance after choosing" on (the ⋯ menu), moves to the next
 * to-do item. Multi-choice groups toggle and never advance.
 *
 * Keys: when the task has no region labels, the bar takes `pickLabel` (1–9 by position) and
 * each class's own hotkey; otherwise those keys keep picking the active region label.
 */
export function DecisionBar({ env, items }: { env: ResolvedEnv; items: StudioItem[] }) {
  const group = decisionGroup(env.labels);
  const itemIndex = useStudio((s) => s.itemIndex);
  const annotations = useStudio((s) => s.annotations);
  const advance = useToolPrefs((s) => s.advance);
  const setAdvance = useToolPrefs((s) => s.setAdvance);
  const item = items[itemIndex];
  // Pure classification: no group that draws regions, so 1–9 decide instead of picking a brush label.
  const owner = !!group && env.labels.every((g) => g.control === "Choices");
  const keyed = owner && !!item;

  const choose = (c: LabelClass) => {
    if (!group || !item) return;
    const st = useStudio.getState();
    st.setClass(item.id, c.id, LOCAL_AUTHOR, { group: group.name });
    if (group.multiple || !useToolPrefs.getState().advance) return;
    const next = nextTodoIndex(items, useStudio.getState().annotations, st.itemIndex);
    if (next !== undefined) st.setItemIndex(next);
  };
  const skip = () => {
    const st = useStudio.getState();
    const next = nextTodoIndex(items, st.annotations, st.itemIndex);
    if (next !== undefined) st.setItemIndex(next);
  };
  const keyOf = (c: LabelClass, i: number): string | undefined => c.hotkey ?? (i < 9 ? String(i + 1) : undefined);

  // Above the shell's own pickLabel, which would only make the class the active label.
  useCommands(
    {
      pickLabel: (e) => {
        const i = (digitOf(e) ?? 0) - 1;
        const c = group?.classes[i];
        if (!c || (c.hotkey && c.hotkey !== String(i + 1))) return false;
        choose(c);
      },
    },
    { priority: SHELL_PRIORITY + 1, scope: CORE, enabled: keyed },
  );
  useHotkeys(
    (e) => {
      const c = group?.classes.find((x) => x.hotkey && matches(e, x.hotkey));
      if (!c) return false;
      if (!e.repeat) choose(c);
      return true;
    },
    SHELL_PRIORITY + 1,
    keyed,
  );

  if (!group || !item) return null;
  const chosen = new Set(annotations.filter((a) => a.itemId === item.id && a.geometry.type === "class").map((a) => a.label));
  const names = labelNames(env.labels);
  const skipKey = commandDef(coreCommand("nextTodo"))?.keys[0];
  const remaining = items.filter((it) => !annotations.some((a) => a.itemId === it.id)).length;

  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-background px-2" role="toolbar" aria-label="Decision" data-testid="decision-bar" data-group={group.name}>
      {group.classes.map((c, i) => {
        const on = chosen.has(c.id);
        const key = keyed ? keyOf(c, i) : undefined;
        return (
          <Button
            key={c.id}
            variant={on ? "default" : "outline"}
            className="shrink-0 gap-2 px-2.5"
            aria-pressed={on}
            onClick={() => choose(c)}
            data-testid="decision-choice"
            data-class={c.id}
          >
            {key && <Kbd className={cn("min-w-5", on && "bg-white/20 text-primary-foreground")}>{formatCombo(key)}</Kbd>}
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: labelColor(names, c.id) }} aria-hidden />
            <span className="capitalize">{c.name ?? c.id}</span>
          </Button>
        );
      })}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost-secondary" className="shrink-0 px-2.5" onClick={skip} disabled={remaining === 0 || (remaining === 1 && chosen.size === 0)} data-testid="decision-skip">
            Skip
            {skipKey && <Kbd className="min-w-5">{formatCombo(skipKey)}</Kbd>}
          </Button>
        </TooltipTrigger>
        <ActionTooltipContent title="Skip" description="Leave this item for later and go to the next to-do item" />
      </Tooltip>
      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground" data-testid="decision-remaining">
        {remaining === 0 ? `All ${items.length} done` : `${remaining} to do`}
      </span>
      {!group.multiple && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost-secondary" size="icon" className="shrink-0" aria-label="Decision bar options">
              <MoreIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem checked={advance} onCheckedChange={(v) => setAdvance(v === true)} data-testid="decision-advance">
              Advance after choosing
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
