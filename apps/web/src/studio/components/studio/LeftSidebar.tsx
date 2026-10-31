import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@studio/ui/ui/tabs";
import { cn } from "@studio/ui/utils";
import type { PanelSlot } from "@studio/plugin-ui-sdk/module";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Project, StudioItem } from "@studio/contracts/types";
import { itemNoun, itemsTabLabel } from "@/studio/lib/format";
import { CORE } from "@/studio/core/manifest";
import { PanelHost } from "./PanelHost";

type SlotProps = { env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined };

/** A panel slot as tabs (right, bottom, viewport bar: whatever `env.panels[slot]` lists). */
export function SlotTabs({ slot, only, env, project, items, item }: SlotProps & { slot: PanelSlot; only?: string[] }) {
  const panels = env.panels[slot].filter((p) => !only || only.includes(p.id));
  if (!panels.length) return null;
  if (panels.length === 1) {
    return (
      <div className="flex h-full flex-col bg-[var(--bg-primary)]">
        <PanelHost id={panels[0].id} env={env} project={project} items={items} item={item} />
      </div>
    );
  }
  return (
    <Tabs defaultValue={panels[0].id} className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="border-b border-[var(--border-color)] px-2 py-2">
        <TabsList className="grid w-full" style={{ gridTemplateColumns: `repeat(${panels.length}, minmax(0, 1fr))` }}>
          {panels.map((p) => (
            <TabsTrigger key={p.id} value={p.id}>{p.title}</TabsTrigger>
          ))}
        </TabsList>
      </div>
      {panels.map((p) => (
        <TabsContent key={p.id} value={p.id} className="mt-0 min-h-0 flex-1">
          <PanelHost id={p.id} env={env} project={project} items={items} item={item} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** The Items panel: titled by the data kind's plural noun (Images, Studies, Slides), never "Files". */
const ITEMS_PANEL = `${CORE}.panels.files`;

/**
 * The Studio's left panel (todo8 D2): a 36px header holding a segmented tab control,
 * normally Items | Labels. Owners can add more left panels (e.g. "All annotations") in the
 * environment; they become further segments.
 */
export function LeftSidebar({ env, project, items, item }: SlotProps) {
  const panels = env.panels.left;
  const [tab, setTab] = useState<string | undefined>(undefined);
  if (!panels.length) return null;
  const value = tab && panels.some((p) => p.id === tab) ? tab : panels[0].id;
  const label = (id: string, title: string) => {
    if (id !== ITEMS_PANEL) return { title, count: undefined };
    return itemsTabLabel(itemNoun(env), items.length);
  };

  return (
    <Tabs value={value} onValueChange={setTab} className="flex h-full flex-col bg-[var(--bg-primary)]">
      {panels.length > 1 && (
        <div className="flex h-9 shrink-0 items-center px-2">
          <TabsList aria-label="Left panel" className="inline-flex h-7 w-full items-stretch gap-0 overflow-hidden rounded-md bg-generic p-0.5 shadow-none">
            {panels.map((p) => {
              const l = label(p.id, p.title);
              return (
                <TabsTrigger
                  key={p.id}
                  value={p.id}
                  className={cn(
                    "h-auto min-w-0 flex-1 justify-center gap-1.5 rounded-[5px] border-b-0 px-2 pt-0",
                    "data-[state=active]:bg-float data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_2px_var(--g-shadow)]",
                  )}
                >
                  <span className="truncate">{l.title}</span>
                  {l.count !== undefined && <span className="tnum text-xs text-hint" data-counter>{l.count}</span>}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
      )}
      {panels.map((p) => (
        <TabsContent key={p.id} value={p.id} className="mt-0 min-h-0 flex-1">
          <PanelHost id={p.id} env={env} project={project} items={items} item={item} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
