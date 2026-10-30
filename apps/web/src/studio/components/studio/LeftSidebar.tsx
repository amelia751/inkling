import { Tabs, TabsContent, TabsList, TabsTrigger } from "@studio/ui/ui/tabs";
import type { PanelSlot } from "@studio/plugin-ui-sdk/module";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Project, StudioItem } from "@studio/contracts/types";
import { PanelHost } from "./PanelHost";

/** A panel slot as tabs (the left sidebar: files, labels, review by default; from `env.panels`). */
export function SlotTabs({ slot, only, env, project, items, item }: { slot: PanelSlot; only?: string[]; env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined }) {
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

export function LeftSidebar(props: { env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined }) {
  return <SlotTabs slot="left" {...props} />;
}
