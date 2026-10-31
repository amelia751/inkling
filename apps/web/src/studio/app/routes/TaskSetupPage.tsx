import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import { NAMING, ns } from "@studio/contracts/naming";
import type { Project } from "@studio/contracts/types";
// TODO(todo8-integration): TaskSetupIcon (the same Sliders glyph) once it's in @studio/ui/icons.
import { AiIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, DeleteIcon, SettingsIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Input } from "@studio/ui/ui/input";
import { Card } from "@studio/ui/ui/card";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { registry, type Registered } from "@/extension-host/registry";
import type { EnvError, ResolvedEnv } from "@/extension-host/resolve";
import { AppLayout, PageContainer, PageHeading } from "@/studio/components/layout/app-layout";
import { LabelsEditor } from "@/studio/components/studio/LabelsEditor";
import { ConfigForm, configurableItems, type ConfigKind, type ConfigurableItem } from "@/studio/components/studio/ModuleConfigForm";
import { useAgentContext, type AgentContextProvider } from "@/studio/lib/agent/providers";
import type { EnvironmentDocument } from "@/studio/lib/api";
import { diffSpecs, patchEnvironment, persistEnvironment } from "@/studio/lib/environment-edits";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { studioUrl } from "@/studio/lib/routes";
import {
  buildNextSpec,
  canEditTaskSetup,
  hotkeyConflicts,
  initialDraft,
  labelProblems,
  PANEL_SLOTS,
  TOOL_GROUP_LABEL,
  TOOL_GROUP_ORDER,
  type SetupDraft,
  type SetupPanelSlot,
} from "@/studio/lib/task-setup";
import { useShell } from "@/studio/stores/shell";
import { LOCAL_AUTHOR, useStudio } from "@/studio/stores/studio";
import { useEnvironment, useTaskDocument } from "./DatasetStudioPage";

/**
 * Task setup (todo8 D7): what used to be the Studio's "Environment settings" dialog, as a page
 * for the task's owner, in plain words. Labels and Tools have hand-built editors; Viewer,
 * Panels and Export formats reuse the generated (RJSF) forms. One Save for the page goes
 * through `patchEnvironment`, the assistant's path: validated by the resolver, one undoable
 * step, saved as a new environment revision. Annotators see the page read-only.
 *
 * `/projects/:projectId/tasks/:taskId/setup`
 */
export function TaskSetupPage() {
  const { projectId = "", taskId = "" } = useParams();
  const doc = useTaskDocument(taskId);
  const boot = useEnvironment(doc.data);
  const summary = useProjectSummary(projectId);
  const canEdit = canEditTaskSetup(summary.data);
  const env = useInstalledEnv(doc.data, boot.status === "ready" ? boot.env : null);

  let body: ReactNode;
  if (doc.isLoading || (doc.data && boot.status === "loading")) body = <SetupSkeleton />;
  else if (doc.error || !doc.data) body = <p className="text-sm text-muted-foreground">No task “{taskId}” in this project.</p>;
  else if (boot.status === "errors") body = <EnvErrorList errors={boot.errors} />;
  else if (boot.status === "failed") body = <p className="text-sm text-muted-foreground">Couldn't load this task's modules: {boot.message}</p>;
  else if (!env) body = <SetupSkeleton />;
  else body = <SetupEditor key={envKey(env)} env={env} task={doc.data} projectId={projectId} canEdit={canEdit} />;

  return (
    <AppLayout>
      <PageContainer className="max-w-4xl">
        <div data-testid="task-setup-page" data-readonly={canEdit ? undefined : "true"}>
          {body}
        </div>
      </PageContainer>
    </AppLayout>
  );
}

/**
 * The environment this page edits, in the Studio store, because `patchEnvironment` and its undo
 * act on the running one. Coming from this task's Studio, that's the Studio's (with its undo
 * history). Otherwise the page installs the task's own and clears the store's task id, so the
 * next Studio opened (this task or another) loads itself from scratch.
 */
function useInstalledEnv(task: Project | undefined, booted: ResolvedEnv | null): ResolvedEnv | null {
  const installedFor = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!task || !booted || installedFor.current === task.id) return;
    installedFor.current = task.id;
    const s = useStudio.getState();
    if (!(s.projectId === task.id && s.env)) {
      useStudio.setState({ projectId: null, envPast: [], envFuture: [] });
      s.setEnv(booted, { record: false });
    }
    setReady(true);
  }, [task, booted]);
  const env = useStudio((s) => s.env);
  return ready ? env : null;
}

const keys = new WeakMap<ResolvedEnv, number>();
let lastKey = 0;
/** A new key per environment object: the editor's draft starts over after a save or an undo. */
function envKey(env: ResolvedEnv): number {
  if (!keys.has(env)) keys.set(env, ++lastKey);
  return keys.get(env)!;
}

function SetupSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <Skeleton className="h-10 w-1/3 rounded-md" />
      <Skeleton className="h-48 rounded-lg" />
      <Skeleton className="h-32 rounded-lg" />
    </div>
  );
}

function EnvErrorList({ errors }: { errors: EnvError[] }) {
  return (
    <ul className="space-y-1.5 text-sm" role="alert" data-testid="setup-errors">
      {errors.map((e, i) => (
        <li key={i} className="rounded-md bg-warning-tint px-3 py-2">
          {e.message}
          {e.path && <code className="ml-1 font-mono text-code text-muted-foreground">{e.path}</code>}
        </li>
      ))}
    </ul>
  );
}

// ---- The editor ------------------------------------------------------------------------------

function SetupEditor({ env, task, projectId, canEdit }: { env: ResolvedEnv; task: Project; projectId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<SetupDraft>(() => initialDraft(env));
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<EnvError[]>([]);
  const [saving, setSaving] = useState(false);
  const readOnly = !canEdit;

  const next = useMemo(() => buildNextSpec(env, draft), [env, draft]);
  const dirty = useMemo(() => diffSpecs(env.source, next).length > 0, [env.source, next]);
  const toolList = useMemo(() => setupTools(env), [env]);
  const enabledTools = toolList.filter((t) => !draft.disabledTools.includes(t.tool.id) && !t.unusable).map((t) => t.tool);
  const conflicts = useMemo(() => hotkeyConflicts(draft.labels, env, enabledTools), [draft.labels, env, enabledTools]);
  const problems = labelProblems(draft.labels);
  const forms = useMemo(() => configurableItems(env), [env]);
  const blocked = conflicts.size > 0 || problems.length > 0;

  useAgentContext(useMemo(() => setupContext(projectId, task, env), [projectId, task, env]));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The Studio reads this cache when it opens; keep it in step with what was saved.
  const remember = (e: ResolvedEnv) => qc.setQueryData<EnvironmentDocument>(["environment", task.id], (d) => ({ revision: d?.revision ?? 0, environment: e.source }));

  const save = async () => {
    setErrors([]);
    setSaving(true);
    try {
      const r = await patchEnvironment(task.id, diffSpecs(env.source, next), LOCAL_AUTHOR);
      if ("errors" in r) return setErrors(r.errors);
      remember(r.env);
      toast("Task setup changed", {
        id: "task-setup-saved",
        duration: 10_000,
        action: { label: "Undo", onClick: () => void undo() },
      });
    } catch (e) {
      setErrors([{ path: "", code: "schema", message: `Couldn't save: ${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setSaving(false);
    }
  };
  const undo = async () => {
    const s = useStudio.getState();
    if (!s.envPast.length) return;
    s.undoEnv();
    const back = useStudio.getState().env;
    if (!back) return;
    remember(back);
    await persistEnvironment(task.id, back, LOCAL_AUTHOR).catch((e) => toast(`Couldn't save the undo: ${e instanceof Error ? e.message : String(e)}`));
  };

  const describe = () => {
    // The Studio's assistant can change the environment (same patch path, same undo); the
    // project drawer can only point there. It gets this task's setup as context either way.
    if (env.panels.right.some((p) => p.id === ns("core.panels.ai"))) {
      useStudio.setState({ aiOpen: true });
      navigate(studioUrl(projectId, task.id));
    } else useShell.getState().setAssistant(true, true);
  };

  const set = <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setConfig = (id: string, v: Record<string, unknown>) => setDraft((d) => (JSON.stringify(d.configs[id]) === JSON.stringify(v) ? d : { ...d, configs: { ...d.configs, [id]: v } }));
  const formsOf = (kind: ConfigKind) => forms.filter((f) => f.kind === kind);

  return (
    <>
      <PageHeading
        title={
          <span className="flex items-center gap-2">
            <SettingsIcon className="size-5 text-hint" /> Task setup
          </span>
        }
        description={
          <>
            How <span className="font-medium text-foreground">{task.title}</span> looks and works for everyone who annotates it.
            {readOnly && " You can look; only the project's owners can change it."}
          </>
        }
        actions={
          <>
            {canEdit && (
              <Button variant="outline" onClick={describe} disabled={dirty} title={dirty ? "Save or discard your edits first" : undefined} data-testid="describe-change">
                <AiIcon /> Describe a change
              </Button>
            )}
            <Button variant={dirty ? "outline" : "default"} asChild>
              <Link to={studioUrl(projectId, task.id)} data-testid="setup-open-studio">
                Open Studio <ArrowRightIcon />
              </Link>
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-5 pb-24">
        <Section id="labels" title="Labels" description="The classes annotators choose from, their colors and keys.">
          <LabelsEditor labels={draft.labels} onChange={(l) => set("labels", l)} conflicts={conflicts} readOnly={readOnly} fresh={fresh} onFresh={setFresh} />
          {problems.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm text-danger" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="tools" title="Tools" description="What the toolbar offers. Tools no label can use stay hidden in the Studio.">
          <ToolsEditor tools={toolList} disabled={draft.disabledTools} onChange={(d) => set("disabledTools", d)} readOnly={readOnly} />
        </Section>

        <Section id="viewer" title="Viewer" description="How the files are shown.">
          <Forms items={[...formsOf("viewer"), ...formsOf("dataKind")]} configs={draft.configs} onChange={setConfig} readOnly={readOnly} empty="The viewer has no options." />
        </Section>

        <Section id="panels" title="Panels" description="The panels beside the viewer, and their options.">
          <PanelsEditor env={env} panels={draft.panels} onChange={(p) => set("panels", p)} readOnly={readOnly} />
          <Forms items={formsOf("panel")} configs={draft.configs} onChange={setConfig} readOnly={readOnly} />
        </Section>

        <Section id="exports" title="Export formats" description="The formats this task's labels can be exported in.">
          {env.exporters.length === 0 ? (
            <p className="text-sm text-muted-foreground">No export formats.</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-1 text-sm">
              {env.exporters.map((x) => (
                <li key={x.id} data-testid="exporter-row">
                  <span className="font-medium">{x.label}</span> <span className="text-muted-foreground">· {x.description}</span>
                </li>
              ))}
            </ul>
          )}
          <Forms items={formsOf("exporter")} configs={draft.configs} onChange={setConfig} readOnly={readOnly} />
        </Section>

        <Section id="annotators" title="Annotators see" description="What's shown to the people labelling. Hiding the answer keeps their labels an independent read.">
          <Toggle
            checked={draft.studio.showSourceLabels}
            onChange={(v) => set("studio", { ...draft.studio, showSourceLabels: v })}
            readOnly={readOnly}
            label="Labels that came with the files"
            hint={env.task === "classification" ? "Off by default for a classification task: the folder or file an item came from often is the answer. Turn on for correction work." : "Shown as context, never as the answer."}
            testid="show-source-labels"
          />
          <Toggle
            checked={draft.studio.showFilePaths}
            onChange={(v) => set("studio", { ...draft.studio, showFilePaths: v })}
            readOnly={readOnly}
            label="File paths"
            hint="Each item's folder, in the status bar and on hover."
            testid="show-file-paths"
          />
          <label className="mt-2 flex flex-col gap-1 text-sm">
            <span className="font-medium">What do you call one item?</span>
            <span className="text-muted-foreground">Used in the Studio's list and messages: “Cases 20”, “On this case”. Leave empty for “item”.</span>
            <Input
              value={draft.studio.itemNoun}
              onChange={(e) => set("studio", { ...draft.studio, itemNoun: e.target.value })}
              placeholder="item"
              maxLength={40}
              disabled={readOnly}
              className="max-w-xs"
              data-testid="item-noun"
            />
          </label>
        </Section>

        <TechnicalDetails env={env} next={next} toolIds={toolList.map((t) => t.tool.id)} />
      </div>

      {canEdit && (dirty || errors.length > 0 || saving) && (
        <div className="sticky bottom-0 z-10 -mx-4 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6" data-testid="setup-savebar">
          {errors.length > 0 && <EnvErrorList errors={errors} />}
          <div className={cn("flex flex-wrap items-center gap-3", errors.length > 0 && "mt-3")}>
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              {blocked ? "Fix the highlighted problems to save." : "Saving checks the setup and can be undone."}
            </p>
            <Button variant="outline" onClick={() => (setDraft(initialDraft(env)), setFresh(new Set()), setErrors([]))} disabled={saving} data-testid="setup-discard">
              Discard
            </Button>
            <Button onClick={() => void save()} loading={saving} disabled={!dirty || blocked} data-testid="setup-save">
              Save
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <Card className="p-5" data-testid={`setup-section-${id}`} aria-labelledby={`setup-${id}`}>
      <h2 id={`setup-${id}`} className="text-body-2 font-semibold">{title}</h2>
      <p className="mb-4 mt-0.5 text-sm text-muted-foreground">{description}</p>
      {children}
    </Card>
  );
}

function Toggle({ checked, onChange, readOnly, label, hint, testid }: { checked: boolean; onChange: (v: boolean) => void; readOnly: boolean; label: string; hint: string; testid: string }) {
  return (
    <label className="flex items-start gap-3 py-1.5">
      <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(v) => onChange(v === true)} disabled={readOnly} data-testid={testid} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-sm text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

// ---- Tools -----------------------------------------------------------------------------------

interface SetupTool {
  tool: Registered<"tools">;
  /** Why the task can't use it (todo8 D4 Rule 1), from the resolver. */
  unusable?: string;
}

/** Every tool the spec lists, in toolbar order, with Rule 1's reason when it can't be used. */
function setupTools(env: ResolvedEnv): SetupTool[] {
  const unusable = new Map((env.unusableTools ?? []).map((u) => [u.tool.id, u.reason]));
  return (env.spec.tools ?? []).flatMap((id) => {
    const tool = registry.get("tools", id);
    return tool ? [{ tool, unusable: unusable.get(id) }] : [];
  });
}

function ToolsEditor({ tools, disabled, onChange, readOnly }: { tools: SetupTool[]; disabled: string[]; onChange: (d: string[]) => void; readOnly: boolean }) {
  const groups = TOOL_GROUP_ORDER.map((g) => ({ group: g, tools: tools.filter((t) => t.tool.group === g) })).filter((g) => g.tools.length);
  for (const t of tools) if (!TOOL_GROUP_ORDER.includes(t.tool.group) && !groups.some((g) => g.group === t.tool.group)) groups.push({ group: t.tool.group, tools: tools.filter((x) => x.tool.group === t.tool.group) });
  if (!tools.length) return <p className="text-sm text-muted-foreground">This task has no tools.</p>;
  const off = new Set(disabled);
  const toggle = (ids: string[], on: boolean) => onChange(on ? disabled.filter((d) => !ids.includes(d)) : [...new Set([...disabled, ...ids])]);
  return (
    <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {groups.map(({ group, tools: list }) => {
        const usable = list.filter((t) => !t.unusable);
        const onCount = usable.filter((t) => !off.has(t.tool.id)).length;
        const state = onCount === 0 ? false : onCount === usable.length ? true : "indeterminate";
        const label = TOOL_GROUP_LABEL[group] ?? group;
        return (
          <fieldset key={group} data-testid="tool-group" data-group={group}>
            <label className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <Checkbox
                checked={state}
                disabled={readOnly || !usable.length}
                onCheckedChange={(v) => toggle(usable.map((t) => t.tool.id), v === true)}
                aria-label={`All ${label} tools`}
                data-testid="tool-group-toggle"
                data-group={group}
              />
              {label}
            </label>
            <ul className="flex flex-col pl-6">
              {list.map(({ tool, unusable }) => (
                <li key={tool.id} data-testid="tool-row" data-tool={tool.name} data-unusable={unusable ? "true" : undefined} className={cn("py-0.5", unusable && "text-hint")}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={!unusable && !off.has(tool.id)} disabled={readOnly || !!unusable} onCheckedChange={(v) => toggle([tool.id], v === true)} data-testid="tool-toggle" data-tool={tool.name} />
                    <tool.icon className="size-4 shrink-0" />
                    <span>{tool.label}</span>
                    {tool.hotkey && <kbd className="rounded-xs bg-generic px-1 font-mono text-xs text-muted-foreground">{tool.hotkey}</kbd>}
                  </label>
                  {unusable && <p className="pl-6 text-xs">{unusable}</p>}
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

// ---- Panels ----------------------------------------------------------------------------------

const SLOT_LABEL: Record<SetupPanelSlot, string> = { left: "Left side", right: "Right side", bottom: "Under the viewer", "viewport-bar": "Viewer bar" };

function PanelsEditor({ env, panels, onChange, readOnly }: { env: ResolvedEnv; panels: SetupDraft["panels"]; onChange: (p: SetupDraft["panels"]) => void; readOnly: boolean }) {
  // Panels the modules in play (or any active plugin) offer; auto-included ones join by themselves.
  const offered = registry.list("panels", (p) => !p.autoInclude);
  const slots = PANEL_SLOTS.filter((s) => (panels[s]?.length ?? 0) > 0 || offered.some((p) => p.slot === s));
  const setSlot = (s: SetupPanelSlot, ids: string[]) => onChange({ ...panels, [s]: ids });
  return (
    <div className="mb-4 flex flex-col gap-4">
      {slots.map((s) => {
        const ids = panels[s] ?? [];
        const addable = offered.filter((p) => p.slot === s && !ids.includes(p.id));
        return (
          <div key={s} data-testid="panel-slot" data-slot={s}>
            <h3 className="mb-1 text-sm font-semibold">{SLOT_LABEL[s]}</h3>
            {ids.length === 0 && <p className="text-sm text-muted-foreground">Nothing here.</p>}
            <ul className="flex flex-col">
              {ids.map((id) => {
                const p = registry.get("panels", id) ?? env.panels[s].find((x) => x.id === id);
                return (
                  <li key={id} className="group/row flex items-center gap-2 py-0.5 text-sm" data-testid="panel-row" data-panel={id}>
                    <span className="font-medium">{p?.title ?? id}</span>
                    {p && <span className="min-w-0 truncate text-muted-foreground">· {p.description}</span>}
                    {!readOnly && (
                      <Button variant="ghost-secondary" size="icon-sm" className="ml-auto opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" onClick={() => setSlot(s, ids.filter((x) => x !== id))} aria-label={`Remove ${p?.title ?? id}`} data-testid="remove-panel">
                        <DeleteIcon />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {!readOnly && addable.length > 0 && (
              <Select value="" onValueChange={(id) => setSlot(s, [...ids, id])}>
                <SelectTrigger className="mt-1 h-7 w-56" aria-label={`Add a panel (${SLOT_LABEL[s]})`} data-testid="add-panel" data-slot={s}>
                  <SelectValue placeholder="Add a panel…" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Generated forms -------------------------------------------------------------------------

function Forms({ items, configs, onChange, readOnly, empty }: { items: ConfigurableItem[]; configs: Record<string, Record<string, unknown>>; onChange: (id: string, v: Record<string, unknown>) => void; readOnly: boolean; empty?: string }) {
  if (!items.length) return empty ? <p className="text-sm text-muted-foreground">{empty}</p> : null;
  return (
    <div className="flex flex-col gap-4">
      {items.map((it) => (
        <div key={it.id}>
          <h3 className="mb-1 text-sm font-semibold first-letter:uppercase">{it.title}</h3>
          <ConfigForm item={it} value={configs[it.id] ?? it.value} onChange={(v) => onChange(it.id, v)} readOnly={readOnly} />
        </div>
      ))}
    </div>
  );
}

// ---- Technical details -----------------------------------------------------------------------

/** Module ids, JSON Pointers and the spec, for people who write environments by hand. */
function TechnicalDetails({ env, next, toolIds }: { env: ResolvedEnv; next: EnvironmentSpec; toolIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState(false);
  const rows: [string, string, string][] = [
    ["Data kind", env.dataKind.id, "/data/kind"],
    ...env.viewports.map((v, i): [string, string, string] => [`Viewer “${v.name}”`, v.renderer.id, `/viewports/${i}/renderer`]),
    ...toolIds.map((id, i): [string, string, string] => ["Tool", id, `/tools/${i}`]),
    ...PANEL_SLOTS.flatMap((s) => (env.spec.panels?.[s] ?? []).map((id, i): [string, string, string] => [`Panel (${s})`, id, `/panels/${s}/${i}`])),
    ...(env.spec.exporters ?? []).map((id, i): [string, string, string] => ["Export format", id, `/exporters/${i}`]),
    ...(env.spec.labels ?? []).map((g, i): [string, string, string] => [`Label group “${g.name}”`, g.control, `/labels/${i}`]),
  ];
  return (
    <Card className="p-0" data-testid="setup-section-technical">
      <button type="button" className="flex w-full items-center gap-2 px-5 py-4 text-left text-body-2 font-semibold" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="technical-details">
        {open ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
        Technical details
      </button>
      {open && (
        <div className="border-t border-border px-5 pb-5 pt-4 text-sm" data-testid="technical-details-body">
          <p className="mb-3 text-muted-foreground">
            Environment <code className="font-mono text-code">{env.id}</code>
            {env.source.extends && (
              <>
                {" "}extends <code className="font-mono text-code">{[env.source.extends].flat().join(", ")}</code>
              </>
            )}
            . Modules: {env.modules.map((m) => `${m.id}@${m.version}`).join(", ")}.
          </p>
          <table className="w-full text-left">
            <thead className="text-xs text-hint">
              <tr>
                <th className="py-1 pr-3 font-normal">What</th>
                <th className="py-1 pr-3 font-normal">Id</th>
                <th className="py-1 font-normal">JSON Pointer</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {rows.map(([what, id, ptr]) => (
                <tr key={ptr} className="border-t border-border">
                  <td className="py-1 pr-3 font-sans text-muted-foreground">{what}</td>
                  <td className="py-1 pr-3 break-all">{id}</td>
                  <td className="py-1 text-muted-foreground">{ptr}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setJson((j) => !j)} data-testid="view-json">
            {json ? "Hide JSON" : "View JSON"}
          </Button>
          {json && (
            <pre className="thin-scrollbar mt-2 max-h-96 overflow-auto rounded-md bg-generic p-3 font-mono text-xs" data-testid="setup-json">
              {JSON.stringify(next, null, 2)}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

// ---- Assistant context ----------------------------------------------------------------------

/** What "Describe a change" (and the drawer on this page) shares: the task's setup as written. */
function setupContext(projectId: string, task: Project, env: ResolvedEnv): AgentContextProvider {
  return {
    key: `${projectId}:task-setup:${task.id}:${envKey(env)}`,
    section: "datasets",
    label: `Task setup › ${task.title}`,
    shares: "This task's setup: its labels, tools, panels, export formats and options (the environment as written). No files.",
    turnContext: () =>
      [
        `Project: ${projectId}`,
        `Section: Task setup for task ${task.title} (${task.id})`,
        `Labels: ${(env.spec.labels ?? []).map((g) => `${g.name} [${g.control}${g.multiple ? ", multiple" : ""}]: ${g.classes.map((c) => `${c.name ?? c.id}${c.hotkey ? ` (key ${c.hotkey})` : ""}`).join(", ")}`).join("; ") || "none"}`,
        `Tools: ${env.tools.map((t) => t.label).join(", ") || "none"}`,
        `Environment as written: ${JSON.stringify(env.source).slice(0, 4000)}`,
        `Changes are made in the ${NAMING.displayName} Studio's assistant (environment tools) or on this page.`,
      ].join("\n"),
  };
}
