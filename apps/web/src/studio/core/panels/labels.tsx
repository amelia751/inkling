import { useState } from "react";
import { DeleteIcon, HideIcon, LockIcon, MoreIcon, ShowIcon, UnlockIcon } from "@studio/ui/icons";
import { ScrollArea } from "@studio/ui/ui/scroll-area";
import { Slider } from "@studio/ui/ui/slider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { cn } from "@studio/ui/utils";
import { describeGeometry, inspectRows } from "@/extension-host/describe";
import { labelClasses, regionLabelNames, type EnvironmentSpec, type LabelClass } from "@studio/contracts/environment";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import type { ResolvedEnv } from "@/extension-host/resolve";
import { runtimeFor, useRuntimeVersion } from "@studio/plugin-ui-sdk/runtime";
import { diffSpecs, patchEnvironment } from "@/studio/lib/environment-edits";
import { isEditable, LOCAL_AUTHOR, useStudio } from "@/studio/stores/studio";
import type { Annotation, Project, StudioItem } from "@studio/contracts/types";
import { labelsForItem } from "@/studio/lib/per-kind";
import { OnThisItem } from "./onThisItem";
import { ProvenanceBadge } from "./provenance";

/** Renderers that show overlay opacity in their own view menu declare this capability. */
export const OPACITY_IN_VIEW_MENU = "overlayOpacity";

/** Section heading: small, sentence case, no uppercase tracking (todo8 §4). */
function Heading({ children, id }: { children: React.ReactNode; id?: string }) {
  return <h3 id={id} className="mb-1 px-2 text-xs font-medium text-muted-foreground">{children}</h3>;
}

/**
 * `studio.core.panels.labels` (todo8 D2): item-level classes (every `Choices` group), then
 * Classes (pick; hide, lock and color behind each row's ⋯), then "On this item" (the
 * current item's annotations), with the selection pinned to the bottom.
 */
export function LabelsPanel({ env, project, items }: PanelProps) {
  const annotations = useStudio((s) => s.annotations);
  const itemIndex = useStudio((s) => s.itemIndex);
  const setClass = useStudio((s) => s.setClass);
  const item = items[itemIndex];
  // todo19 D7: only the groups that apply to the active item's kind.
  const groups = labelsForItem(env, item);
  const labels = regionLabelNames(groups);
  const choiceGroups = groups.filter((g) => g.control === "Choices");
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const selected = annotations.find((a) => a.id === selectedId);
  const multi = annotations.filter((a) => selectedIds.includes(a.id));
  // Renderers without their own opacity control (ECG, video, WSI…) keep it here.
  const opacityHere = !env.viewports.some((v) => v.renderer.capabilities.includes(OPACITY_IN_VIEW_MENU));
  const selection = multi.length > 1
    ? <MultiSelectionPanel labels={labels} annotations={multi} />
    : selected && item ? <SelectionInspector env={env} project={project} item={item} labels={labels} annotation={selected} /> : null;

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="space-y-4 px-1 py-3">
          {item &&
            choiceGroups.map((g) => (
              <section key={g.name}>
                <Heading>{g.multiple ? "Classes for this whole item" : "Class for this whole item"}</Heading>
                <div className="grid grid-cols-2 gap-1.5 px-2">
                  {g.classes.map((c) => {
                    const on = annotations.some((a) => a.itemId === item.id && a.geometry.type === "class" && a.label === c.id);
                    return (
                      <button
                        key={c.id}
                        onClick={() => setClass(item.id, c.id, LOCAL_AUTHOR, { group: g.name })}
                        className={cn(
                          "rounded-md border px-2 py-1 text-sm capitalize transition-colors",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]",
                        )}
                        aria-pressed={on}
                      >
                        {c.name ?? c.id}
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          {labels.length > 0 && <ClassList env={env} project={project} labels={labels} />}
          {opacityHere && <OpacityRow />}
          <OnThisItem env={env} item={item} labels={labels} />
        </div>
      </ScrollArea>
      {selection && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-t border-[var(--border-color)] px-3 py-3" data-testid="selection-section">
          {selection}
        </div>
      )}
    </div>
  );
}

function OpacityRow() {
  const opacity = useStudio((s) => s.overlayOpacity);
  const setOpacity = useStudio((s) => s.setOverlayOpacity);
  return (
    <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
      <span className="shrink-0">Overlay opacity</span>
      <Slider value={[opacity]} min={0} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Overlay opacity" />
      <span className="tnum w-8 text-right">{Math.round(opacity * 100)}%</span>
    </div>
  );
}

/** Palette slots a class can take (theme chart tokens, so colors follow light and dark). */
const COLOR_SLOTS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

/** Set (or, with `undefined`, clear) a class's color in every group that defines it, through the env patch path. */
async function setClassColor(env: ResolvedEnv, projectId: string, id: string, color: string | undefined) {
  const next = structuredClone(env.source) as EnvironmentSpec;
  // Labels may be inherited from a preset; materialise the merged list first.
  next.labels = structuredClone(env.spec.labels ?? env.labels).map((g) =>
    typeof g === "string" ? g : { ...g, classes: g.classes.map((c: LabelClass) => (c.id === id ? withColor(c, color) : c)) },
  );
  return patchEnvironment(projectId, diffSpecs(env.source, next), LOCAL_AUTHOR);
}

function withColor(c: LabelClass, color: string | undefined): LabelClass {
  const { color: _, ...rest } = c;
  return color ? { ...rest, color } : rest;
}

/** Classes: pick by click or key; the key and count stay visible, hide / lock / color sit behind ⋯. */
function ClassList({ env, project, labels }: { env: ResolvedEnv; project: Project; labels: string[] }) {
  const classes = labelClasses(env.labels);
  const byId = new Map(classes.map((c) => [c.id, c]));
  const activeLabel = useStudio((s) => s.activeLabel);
  const setActiveLabel = useStudio((s) => s.setActiveLabel);
  const annotations = useStudio((s) => s.annotations);
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const toggleHidden = useStudio((s) => s.toggleLabelHidden);
  const toggleLocked = useStudio((s) => s.toggleLabelLocked);
  const [colorError, setColorError] = useState<string | null>(null);
  const recolor = async (id: string, color: string | undefined) => {
    setColorError(null);
    const r = await setClassColor(env, project.id, id, color);
    if ("errors" in r) setColorError(r.errors[0]?.message ?? "The color couldn't be changed");
  };

  return (
    <section aria-labelledby="classes-heading">
      <Heading id="classes-heading">Classes</Heading>
      <div>
        {labels.map((l, i) => {
          const c = byId.get(l);
          const name = c?.name ?? l;
          const count = annotations.filter((a) => a.label === l && a.geometry.type !== "class").length;
          const hidden = hiddenLabels.includes(l);
          const locked = lockedLabels.includes(l);
          return (
            <div
              key={l}
              className={cn("group flex h-7 items-center gap-0.5 rounded-md pr-0.5 transition-colors", activeLabel === l ? "bg-accent" : "hover:bg-[var(--bg-tertiary)]")}
            >
              <button onClick={() => setActiveLabel(l)} className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-sm [outline-offset:-2px]" aria-pressed={activeLabel === l}>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: labelColor(labels, l), opacity: hidden ? 0.35 : 1 }} />
                <span className={cn("flex-1 truncate text-left capitalize", hidden && "text-muted-foreground line-through")}>{name}</span>
                <kbd className="rounded border border-[var(--border-color)] px-1 font-mono text-[10px] text-muted-foreground">{c?.hotkey ?? (i < 9 ? i + 1 : "")}</kbd>
                <span className="tnum w-5 text-right text-xs text-muted-foreground">{count}</span>
              </button>
              {/* Hidden or locked stays visible (and one click undoes it); setting either is in ⋯. */}
              {hidden && (
                <button onClick={() => toggleHidden(l)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`Show ${l}`} aria-pressed title="Hidden: click to show">
                  <HideIcon className="h-3.5 w-3.5" />
                </button>
              )}
              {locked && (
                <button onClick={() => toggleLocked(l)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={`Unlock ${l}`} aria-pressed title="Locked: click to unlock">
                  <LockIcon className="h-3.5 w-3.5" />
                </button>
              )}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    className="rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    aria-label={`More for ${l}`}
                    title="Hide, lock, color"
                  >
                    <MoreIcon className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onSelect={() => toggleHidden(l)} aria-label={hidden ? `Show ${l}` : `Hide ${l}`}>
                    {hidden ? <ShowIcon /> : <HideIcon />} {hidden ? "Show" : "Hide"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => toggleLocked(l)} aria-label={locked ? `Unlock ${l}` : `Lock ${l}`}>
                    {locked ? <UnlockIcon /> : <LockIcon />} {locked ? "Unlock" : "Lock"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Color</DropdownMenuLabel>
                  <div className="flex items-center gap-1 px-2 pb-1.5" role="group" aria-label={`Color for ${l}`}>
                    {COLOR_SLOTS.map((slot) => (
                      <DropdownMenuItem
                        key={slot}
                        onSelect={() => recolor(l, slot)}
                        aria-label={`Color ${slot.replace("chart-", "")}`}
                        className={cn("h-5 w-5 justify-center rounded-full p-0", c?.color === slot && "ring-2 ring-foreground ring-offset-1 ring-offset-popover")}
                        style={{ background: `hsl(var(--${slot}))` }}
                      />
                    ))}
                    {c?.color && (
                      <DropdownMenuItem onSelect={() => recolor(l, undefined)} className="ml-auto h-5 px-1.5 text-xs">
                        Reset
                      </DropdownMenuItem>
                    )}
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
      {colorError && <p className="px-2 pt-1 text-xs text-state-fail" role="alert">{colorError}</p>}
    </section>
  );
}

/** Several annotations selected: per-label counts and bulk relabel, lock, hide, delete (one undo step each). */
function MultiSelectionPanel({ labels, annotations }: { labels: string[]; annotations: Annotation[] }) {
  const batch = useStudio((s) => s.batch);
  const select = useStudio((s) => s.select);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const editable = annotations.filter((a) => isEditable(a, lockedLabels));
  const counts = new Map<string, number>();
  for (const a of annotations) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  const allLocked = annotations.every((a) => a.locked);
  const allHidden = annotations.every((a) => a.hidden);
  const patchAll = (list: Annotation[], patch: Partial<Annotation>) => batch({ update: list.map((a) => ({ id: a.id, patch })) });

  return (
    <section aria-label="Selected annotations">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{annotations.length} selected</h3>
        <button onClick={() => select(null)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Clear</button>
      </div>
      <ul className="mb-2 space-y-0.5 text-xs">
        {[...counts].map(([l, n]) => (
          <li key={l} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, l) }} />
            <span className="flex-1 truncate capitalize">{l}</span>
            <span className="tnum text-muted-foreground">{n}</span>
          </li>
        ))}
      </ul>
      <label className="mb-2 flex items-center gap-2 text-xs">
        <span className="w-12 text-muted-foreground">Relabel</span>
        <select
          value=""
          disabled={!editable.length}
          onChange={(e) => e.target.value && patchAll(editable, { label: e.target.value })}
          className="h-7 flex-1 rounded-md border border-[var(--border-color)] bg-transparent px-1.5 text-sm capitalize"
        >
          <option value="">Choose a label…</option>
          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-1">
        <button onClick={() => patchAll(annotations, { locked: !allLocked })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {allLocked ? <UnlockIcon className="h-3 w-3" /> : <LockIcon className="h-3 w-3" />} {allLocked ? "Unlock" : "Lock"} all
        </button>
        <button onClick={() => patchAll(annotations, { hidden: !allHidden })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {allHidden ? <ShowIcon className="h-3 w-3" /> : <HideIcon className="h-3 w-3" />} {allHidden ? "Show" : "Hide"} all
        </button>
        <button
          onClick={() => batch({ remove: editable.map((a) => a.id) })}
          disabled={!editable.length}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-state-fail disabled:opacity-40"
        >
          <DeleteIcon className="h-3 w-3" /> Delete {editable.length < annotations.length ? `${editable.length} unlocked` : "all"}
        </button>
      </div>
    </section>
  );
}

/** Selected annotation: label, physical measurements from the viewer, lock/hide, delete. */
export function SelectionInspector({ env, project, item, labels, annotation: a }: { env: ResolvedEnv; project: Project; item: StudioItem; labels: string[]; annotation: Annotation }) {
  const update = useStudio((s) => s.update);
  const remove = useStudio((s) => s.remove);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const editable = isEditable(a, lockedLabels);
  const rows = inspectRows(a, env, { project, item, runtime: runtimeFor(item.id) });
  // Re-render when a renderer publishes values the rows read (playhead, grid…).
  useRuntimeVersion(item.id);

  return (
    <section aria-label="Selected annotation">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Selection</h3>
        <span className="ml-auto"><ProvenanceBadge provenance={a.provenance} /></span>
      </div>
      <div className="mb-2 text-xs text-muted-foreground">{describeGeometry(a, env)}</div>
      <label className="mb-2 flex items-center gap-2 text-xs">
        <span className="w-12 text-muted-foreground">Label</span>
        <select
          value={a.label}
          // Labels outside the env's vocabulary (rhythm episodes, record statements) carry their own meaning.
          disabled={!editable || !labels.includes(a.label)}
          onChange={(e) => update(a.id, { label: e.target.value })}
          className="h-7 flex-1 rounded-md border border-[var(--border-color)] bg-transparent px-1.5 text-sm capitalize"
        >
          {!labels.includes(a.label) && <option value={a.label}>{a.label}</option>}
          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      {rows.length > 0 && (
        <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tnum text-right">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex items-center gap-1">
        <button onClick={() => update(a.id, { locked: !a.locked })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {a.locked ? <UnlockIcon className="h-3 w-3" /> : <LockIcon className="h-3 w-3" />} {a.locked ? "Unlock" : "Lock"}
        </button>
        <button onClick={() => update(a.id, { hidden: !a.hidden })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {a.hidden ? <ShowIcon className="h-3 w-3" /> : <HideIcon className="h-3 w-3" />} {a.hidden ? "Show" : "Hide"}
        </button>
        <button
          onClick={() => remove(a.id)}
          disabled={!editable}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-state-fail disabled:opacity-40"
        >
          <DeleteIcon className="h-3 w-3" /> Delete
        </button>
      </div>
    </section>
  );
}
