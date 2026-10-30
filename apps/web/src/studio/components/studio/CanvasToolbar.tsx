import { Fragment, useMemo } from "react";
import * as z from "zod";
import * as Icons from "@studio/ui/icons";
import { AiIcon, RedoIcon, UndoIcon, type IconComponent } from "@studio/ui/icons";
import { Separator } from "@studio/ui/ui/separator";
import { Slider } from "@studio/ui/ui/slider";
import { Button } from "@studio/ui/ui/button";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@studio/ui/ui/tooltip";
import type { ShortcutId } from "@studio/ui/shortcuts";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { cn } from "@studio/ui/utils";
import { labelNames } from "@studio/contracts/environment";
import type { Registered } from "@/extension-host/registry";
import { execute } from "@/extension-host/commands";
import { visibleToolbarCommands } from "@/extension-host/contributions-loader";
import type { ResolvedEnv } from "@/extension-host/resolve";
import { useStudio } from "@/studio/stores/studio";
import type { Project, StudioItem } from "@studio/contracts/types";
import { SlotTabs } from "./LeftSidebar";

const COMPACT_AFTER = 7;

/** Tools, undo/redo, the active tool's options and the active label. Everything comes from the env's tool contributions. */
export function CanvasToolbar({ env, project, items, item }: { env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined }) {
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const tools = env.tools;
  const labels = labelNames(env.labels);
  const active = tools.find((t) => t.name === tool);
  const drawing = active?.creates !== undefined;
  const compact = tools.length > COMPACT_AFTER;
  // Toolbar actions of declarative plugins (plugin.yaml + ui/contributions.json): shown where their `when` holds.
  const selectionCount = useStudio((s) => s.selectedIds.length);
  const actions = visibleToolbarCommands(env, item, { tool, "selection.count": selectionCount });

  return (
    <div className="@container hide-scrollbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2" role="toolbar" aria-label="Annotation tools">
      {tools.map((t, i) => {
        const newGroup = i > 0 && tools[i - 1].group !== t.group;
        return (
          <Fragment key={t.id}>
            {newGroup && <Separator orientation="vertical" className="mx-0.5 h-5" />}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost-secondary"
                  selected={tool === t.name}
                  onClick={() => setTool(t.name)}
                  className={cn("shrink-0", compact ? "w-7 px-0" : "px-2 @max-[720px]:w-7 @max-[720px]:px-0")}
                  aria-pressed={tool === t.name}
                  aria-label={t.label}
                  data-tool={t.name}
                >
                  <t.icon />
                  {!compact && <span className="hidden @[720px]:inline">{t.label}</span>}
                </Button>
              </TooltipTrigger>
              <ActionTooltipContent title={t.label} shortcut={t.hotkey} description={t.hint} />
            </Tooltip>
          </Fragment>
        );
      })}
      {actions.length > 0 && <Separator orientation="vertical" className="mx-0.5 h-5" />}
      {actions.map((c) => {
        const Icon = (c.iconName && (Icons as unknown as Record<string, IconComponent>)[c.iconName]) || AiIcon;
        return (
          <Tooltip key={c.id}>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" className="shrink-0 px-2" onClick={() => execute(c.id)} aria-label={c.label} data-toolbar-action={c.id}>
                <Icon />
                <span className="hidden @[720px]:inline">{c.label}</span>
              </Button>
            </TooltipTrigger>
            <ActionTooltipContent title={c.label} shortcut={c.id} description={c.description} />
          </Tooltip>
        );
      })}
      <Separator orientation="vertical" className="mx-1 h-5" />
      <IconAction icon={UndoIcon} label="Undo" shortcut="undo" onClick={undo} disabled={!canUndo} />
      <IconAction icon={RedoIcon} label="Redo" shortcut="redo" onClick={redo} disabled={!canRedo} />

      {active?.optionsSchema && <ToolOptionsStrip tool={active} />}

      {drawing && activeLabel && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
          Drawing
          <span className="flex items-center gap-1 rounded-md bg-generic px-2 py-0.5 capitalize text-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, activeLabel) }} />
            {activeLabel}
          </span>
        </div>
      )}
      {env.panels["viewport-bar"].length > 0 && (
        <div className={cn("flex shrink-0 items-center", !(drawing && activeLabel) && "ml-auto")}>
          <SlotTabs slot="viewport-bar" env={env} project={project} items={items} item={item} />
        </div>
      )}
    </div>
  );
}

interface OptionField {
  key: string;
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  description?: string;
}

/**
 * Controls generated from the active tool's `optionsSchema`: numbers become sliders,
 * booleans checkboxes, enums segmented controls. (A schema-driven form library replaces
 * this once configs get richer; todo phase 9.)
 */
function ToolOptionsStrip({ tool }: { tool: Registered<"tools"> }) {
  const options = useStudio((s) => s.toolOptions[tool.name]);
  const setOption = useStudio((s) => s.setToolOption);
  const fields = useMemo<OptionField[]>(() => {
    const js = z.toJSONSchema(tool.optionsSchema!, { unrepresentable: "any" }) as { properties?: Record<string, Omit<OptionField, "key">> };
    return Object.entries(js.properties ?? {}).map(([key, f]) => ({ key, ...f }));
  }, [tool.optionsSchema]);
  if (!options) return null;

  return (
    <div className="ml-2 flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
      {fields.map((f) => {
        const value = options[f.key];
        if (f.type === "number" || f.type === "integer") {
          const v = Number(value);
          // Brush-like sizes keep their historic name for assistive tech and tests.
          const aria = f.key === "size" ? "Brush size" : label(f.key);
          return (
            <div key={f.key} className="flex items-center gap-2">
              <span>{label(f.key)}</span>
              <Slider value={[v]} min={f.minimum ?? 0} max={f.maximum ?? 100} step={f.type === "integer" ? 1 : 0.01} onValueChange={([n]) => setOption(tool.name, f.key, n)} className="w-24" aria-label={aria} />
              <span className="tnum w-9">{v}{f.key === "size" ? "px" : ""}</span>
            </div>
          );
        }
        if (f.type === "boolean") {
          return (
            <label key={f.key} className="flex items-center gap-1" title={f.description}>
              <input type="checkbox" checked={!!value} onChange={(e) => setOption(tool.name, f.key, e.target.checked)} />
              {label(f.key)}
            </label>
          );
        }
        if (f.enum) {
          return (
            <SegmentedControl
              key={f.key}
              aria-label={label(f.key)}
              value={String(value)}
              onValueChange={(v) => setOption(tool.name, f.key, v)}
              options={f.enum.map((e) => ({ value: e, label: e }))}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();

function IconAction({ icon: Icon, label, shortcut, onClick, disabled }: { icon: IconComponent; label: string; shortcut: ShortcutId; onClick: () => void; disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The span keeps the tooltip working while the button is disabled. */}
        <span className="inline-flex shrink-0">
          <Button variant="ghost-secondary" size="icon" onClick={onClick} disabled={disabled} aria-label={label}>
            <Icon />
          </Button>
        </span>
      </TooltipTrigger>
      <ActionTooltipContent title={label} shortcut={shortcut} />
    </Tooltip>
  );
}
