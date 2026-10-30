import { DeleteIcon, HideIcon, LockIcon, ShowIcon, UnlockIcon } from "@studio/ui/icons";
import { ScrollArea } from "@studio/ui/ui/scroll-area";
import { Slider } from "@studio/ui/ui/slider";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { cn } from "@studio/ui/utils";
import { describeGeometry, inspectRows } from "@/extension-host/describe";
import { labelClasses, regionLabelNames } from "@studio/contracts/environment";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import type { ResolvedEnv } from "@/extension-host/resolve";
import { runtimeFor, useRuntimeVersion } from "@studio/plugin-ui-sdk/runtime";
import { isEditable, LOCAL_AUTHOR, useStudio } from "@/studio/stores/studio";
import type { Annotation, Project, StudioItem } from "@studio/contracts/types";
import { ProvenanceBadge } from "./provenance";

/**
 * `inkling.core.panels.labels`: item-level classes (every `Choices` group), label classes
 * with pick / hide / lock, overlay opacity, and the selection inspector.
 */
export function LabelsPanel({ env, project, items }: PanelProps) {
  const labels = regionLabelNames(env.labels);
  const classes = labelClasses(env.labels);
  const choiceGroups = env.labels.filter((g) => g.control === "Choices");
  const activeLabel = useStudio((s) => s.activeLabel);
  const setActiveLabel = useStudio((s) => s.setActiveLabel);
  const annotations = useStudio((s) => s.annotations);
  const itemIndex = useStudio((s) => s.itemIndex);
  const setClass = useStudio((s) => s.setClass);
  const item = items[itemIndex];
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const toggleHidden = useStudio((s) => s.toggleLabelHidden);
  const toggleLocked = useStudio((s) => s.toggleLabelLocked);
  const opacity = useStudio((s) => s.overlayOpacity);
  const setOpacity = useStudio((s) => s.setOverlayOpacity);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const selected = annotations.find((a) => a.id === selectedId);
  const multi = annotations.filter((a) => selectedIds.includes(a.id));

  return (
    <ScrollArea className="h-full [&>[data-radix-scroll-area-viewport]>div]:!block">
      <div className="space-y-4 p-3">
        {item &&
          choiceGroups.map((g) => (
            <section key={g.name}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">Image label for {item.name}</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                {g.multiple ? "Pick every class that applies to this whole item." : "Pick the class that best describes this whole image."}
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {g.classes.map((c) => {
                  const on = annotations.some((a) => a.itemId === item.id && a.geometry.type === "class" && a.label === c.id);
                  return (
                    <button
                      key={c.id}
                      onClick={() => setClass(item.id, c.id, LOCAL_AUTHOR, { group: g.name })}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-sm capitalize transition-colors",
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
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{choiceGroups.length ? "Region labels" : "Label classes"}</h3>
          <div className="space-y-0.5">
            {labels.map((l, i) => {
              const count = annotations.filter((a) => a.label === l && a.geometry.type !== "class").length;
              const hidden = hiddenLabels.includes(l);
              const locked = lockedLabels.includes(l);
              return (
                <div
                  key={l}
                  className={cn("group flex items-center gap-1 rounded-md pr-1 transition-colors", activeLabel === l ? "bg-accent" : "hover:bg-[var(--bg-tertiary)]")}
                >
                  <button onClick={() => setActiveLabel(l)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm" aria-pressed={activeLabel === l}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: labelColor(labels, l), opacity: hidden ? 0.35 : 1 }} />
                    <span className={cn("flex-1 truncate text-left capitalize", hidden && "text-muted-foreground line-through")}>{classes[i]?.name ?? l}</span>
                    <kbd className="rounded border border-[var(--border-color)] px-1 font-mono text-[10px] text-muted-foreground">{classes[i]?.hotkey ?? (i < 9 ? i + 1 : "")}</kbd>
                    <span className="tnum w-5 text-right text-xs text-muted-foreground">{count}</span>
                  </button>
                  <button
                    onClick={() => toggleHidden(l)}
                    className={cn("rounded p-1 text-muted-foreground hover:text-foreground", !hidden && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                    aria-label={hidden ? `Show ${l}` : `Hide ${l}`}
                    aria-pressed={hidden}
                  >
                    {hidden ? <HideIcon className="h-3.5 w-3.5" /> : <ShowIcon className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    onClick={() => toggleLocked(l)}
                    className={cn("rounded p-1 text-muted-foreground hover:text-foreground", !locked && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                    aria-label={locked ? `Unlock ${l}` : `Lock ${l}`}
                    aria-pressed={locked}
                  >
                    {locked ? <LockIcon className="h-3.5 w-3.5" /> : <UnlockIcon className="h-3.5 w-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2 px-2 text-xs text-muted-foreground">
            <span className="shrink-0">Overlay opacity</span>
            <Slider value={[opacity]} min={0} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Overlay opacity" />
            <span className="tnum w-8 text-right">{Math.round(opacity * 100)}%</span>
          </div>
        </section>
        {multi.length > 1 ? (
          <MultiSelectionPanel labels={labels} annotations={multi} />
        ) : (
          selected && item && <SelectionInspector env={env} project={project} item={item} labels={labels} annotation={selected} />
        )}
      </div>
    </ScrollArea>
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
    <section className="rounded-md border border-[var(--border-color)] p-2.5" aria-label="Selected annotations">
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
    <section className="rounded-md border border-[var(--border-color)] p-2.5" aria-label="Selected annotation">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Selected</h3>
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
