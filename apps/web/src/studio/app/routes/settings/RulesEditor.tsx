import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DeleteIcon, PlusIcon } from "@studio/ui/icons";
import { LINT_RULES } from "@studio/contracts/lint-rules";
import { RULE_SEVERITIES, type RuleSeverity } from "@studio/contracts/rules";
import { Alert } from "@studio/ui/ui/alert";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@studio/ui/ui/radio-group";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Textarea } from "@studio/ui/ui/textarea";
import { relativeTime } from "@/studio/components/files";
import { governanceKeys, putRules, rulesSourceLine, useRules, useRulesHistory, type RulesDocument } from "@/studio/lib/governance-api";
import { parseProblem, problemText, violationsAt, type Problem } from "@/studio/lib/governance-problem";
import { DATASET_METADATA, fromDraft, newLabel, toDraft, type RulesDraft } from "@/studio/lib/rules-draft";

/**
 * Settings › Rules (todo17 D3): the project's labels, folder layout, required dataset metadata,
 * merge policy and severity overrides. Saves with the revision it started from; a rejected save
 * shows each violation by its field.
 */
export function RulesEditor({ projectId }: { projectId: string }) {
  const rules = useRules(projectId);
  if (rules.isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (rules.error || !rules.data) return <Alert theme="danger">Couldn't load the rules: {problemText(rules.error)}</Alert>;
  return <RulesForm key={rules.data.revision} projectId={projectId} doc={rules.data} onReload={() => void rules.refetch()} />;
}

function FieldErrors({ problem, field, exact }: { problem: Problem | null; field: string; exact?: boolean }) {
  const vs = violationsAt(problem, field, exact);
  if (!vs.length) return null;
  return (
    <ul className="text-sm text-danger" data-testid="rules-field-error" data-field={field}>
      {vs.map((v, i) => <li key={i}>{v.message}</li>)}
    </ul>
  );
}

function RulesForm({ projectId, doc, onReload }: { projectId: string; doc: RulesDocument; onReload: () => void }) {
  const qc = useQueryClient();
  const initial = useMemo(() => toDraft(doc.rules), [doc.rules]);
  const [d, setD] = useState<RulesDraft>(initial);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  useEffect(() => setSaved(false), [d]);
  const save = useMutation({
    mutationFn: () => putRules(projectId, fromDraft(d, doc.rules), doc.revision),
    onSuccess: (next) => {
      qc.setQueryData(governanceKeys.rules(projectId), next);
      void qc.invalidateQueries({ queryKey: governanceKeys.rulesHistory(projectId) });
      void qc.invalidateQueries({ queryKey: governanceKeys.findings(projectId) });
      setSaved(true);
    },
  });
  const problem = save.error ? parseProblem(save.error) : null;
  const stale = problem?.status === 409;
  const set = <K extends keyof RulesDraft>(k: K, v: RulesDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setLabel = (i: number, patch: Partial<RulesDraft["labels"][number]>) => set("labels", d.labels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const source = rulesSourceLine(doc);

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="rules-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate();
      }}
    >
      {source && <p className="rounded-md bg-info-tint px-3 py-2 text-sm" data-testid="rules-source">{source}. Saving makes them this project's own.</p>}

      <Card className="flex flex-col gap-3 p-4" data-testid="rules-labels">
        <div>
          <h2 className="text-sm font-medium">Labels</h2>
          <p className="text-sm text-muted-foreground">Annotations use these names. Synonyms are rewritten to the name on save.</p>
        </div>
        {d.labels.length > 0 && (
          <div className="hidden grid-cols-[1fr_1.4fr_5rem_1fr_2rem] gap-2 text-sm text-muted-foreground md:grid">
            <span>Name</span>
            <span>Synonyms</span>
            <span>Colour</span>
            <span>Allowed geometries</span>
            <span />
          </div>
        )}
        {d.labels.map((l, i) => (
          <div key={i} className="flex flex-col gap-1" data-testid="rules-label-row">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1.4fr_5rem_1fr_2rem]">
              <Input value={l.name} onChange={(e) => setLabel(i, { name: e.target.value })} placeholder="pneumonia" aria-label="Label name" data-testid="rules-label-name" />
              <Input value={l.synonyms} onChange={(e) => setLabel(i, { synonyms: e.target.value })} placeholder="PNA, pneumonitis" aria-label="Synonyms" data-testid="rules-label-synonyms" />
              <Input type="color" value={l.colour || "#5547ea"} onChange={(e) => setLabel(i, { colour: e.target.value })} aria-label="Colour" className="h-9 p-1" />
              <Input value={l.geometries} onChange={(e) => setLabel(i, { geometries: e.target.value })} placeholder="Any" aria-label="Allowed geometries" />
              <Button type="button" variant="ghost" size="icon" aria-label="Remove label" onClick={() => set("labels", d.labels.filter((_, j) => j !== i))}>
                <DeleteIcon />
              </Button>
            </div>
            <FieldErrors problem={problem} field={`labels.${i}`} />
          </div>
        ))}
        <FieldErrors problem={problem} field="labels" exact />
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => set("labels", [...d.labels, newLabel()])} data-testid="rules-add-label">
          <PlusIcon /> Add label
        </Button>
      </Card>

      <Card className="grid max-w-3xl gap-3 p-4" data-testid="rules-layout">
        <h2 className="text-sm font-medium">Folder layout</h2>
        <div className="grid gap-1.5">
          <Label htmlFor="rules-folders">Folders files live under</Label>
          <Textarea id="rules-folders" rows={3} value={d.folderPatterns} onChange={(e) => set("folderPatterns", e.target.value)} placeholder={"images/**\nmasks/**"} />
          <p className="text-sm text-muted-foreground">One pattern per line. Empty means anywhere.</p>
          <FieldErrors problem={problem} field="layout.folderPatterns" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="rules-name-pattern">File name pattern</Label>
            <Input id="rules-name-pattern" value={d.fileNamePattern} onChange={(e) => set("fileNamePattern", e.target.value)} placeholder="^[a-z0-9_-]+\.[a-z]+$" />
            <FieldErrors problem={problem} field="layout.fileNamePattern" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rules-forbidden">Forbidden characters</Label>
            <Input id="rules-forbidden" value={d.forbiddenCharacters} onChange={(e) => set("forbiddenCharacters", e.target.value)} placeholder=":*?" />
            <FieldErrors problem={problem} field="layout.forbiddenCharacters" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rules-depth">Deepest folder</Label>
            <Input id="rules-depth" inputMode="numeric" value={d.maxDepth} onChange={(e) => set("maxDepth", e.target.value)} placeholder="No limit" />
            <FieldErrors problem={problem} field="layout.maxDepth" />
          </div>
        </div>
      </Card>

      <Card className="grid max-w-3xl gap-3 p-4">
        <h2 className="text-sm font-medium">Datasets need</h2>
        <div className="flex flex-wrap gap-4" data-testid="rules-metadata">
          {DATASET_METADATA.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm capitalize">
              <Checkbox
                checked={d.requiredMetadata.includes(m)}
                onCheckedChange={(v) => set("requiredMetadata", v === true ? [...d.requiredMetadata, m] : d.requiredMetadata.filter((x) => x !== m))}
                data-testid={`rules-metadata-${m}`}
              />
              {m}
            </label>
          ))}
        </div>
        <FieldErrors problem={problem} field="datasets" />
      </Card>

      <Card className="grid max-w-3xl gap-2 p-4">
        <h2 className="text-sm font-medium">Change requests</h2>
        <RadioGroup value={d.mergeAuto} onValueChange={(v) => set("mergeAuto", v as RulesDraft["mergeAuto"])} data-testid="rules-merge">
          <label className="flex items-start gap-2 text-sm">
            <RadioGroupItem value="write-tier" className="mt-0.5" data-testid="rules-merge-auto" />
            <span>
              Merge when checks pass <span className="block text-muted-foreground">Everyday edits apply on their own; deletes and anything that fails a check wait for you.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <RadioGroupItem value="never" className="mt-0.5" data-testid="rules-merge-never" />
            <span>
              Always wait for review <span className="block text-muted-foreground">An owner or editor merges every change request.</span>
            </span>
          </label>
        </RadioGroup>
      </Card>

      <Card className="overflow-hidden" data-testid="rules-severity">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-medium">Checks</h2>
          <p className="text-sm text-muted-foreground">Error rejects the write, warning saves it with a finding, info only records it.</p>
        </div>
        <div className="divide-y divide-border">
          {LINT_RULES.map((r) => (
            <div key={r.code} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm" data-testid="rules-severity-row" data-rule={r.code}>
              <span className="min-w-0 flex-1">
                <span className="block">{r.title}</span>
                <span className="block font-mono text-code text-muted-foreground">
                  {r.code}
                  {r.mode === "evaluate" ? " · evaluate" : ""}
                </span>
              </span>
              <select
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                value={d.severityOverrides[r.code] ?? ""}
                aria-label={`Severity for ${r.code}`}
                onChange={(e) => {
                  const next = { ...d.severityOverrides };
                  if (e.target.value) next[r.code] = e.target.value as RuleSeverity;
                  else delete next[r.code];
                  set("severityOverrides", next);
                }}
                data-testid="rules-severity-select"
              >
                <option value="">Default ({r.defaultSeverity})</option>
                {RULE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </Card>

      {problem && !stale && (
        <Alert theme="danger" data-testid="rules-problem">
          <p>{problem.title}</p>
          {problem.violations.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {problem.violations.map((v, i) => (
                <li key={i} data-testid="rules-violation" data-field={v.field}>
                  <span className="font-mono text-code">{v.field || "rules"}</span> → {v.message}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      {stale && (
        <Alert theme="warning" data-testid="rules-stale" actions={<Button type="button" variant="outline" size="sm" onClick={onReload}>Reload</Button>}>
          Someone changed the rules since you opened them. Reload to see their version; your edits here are lost.
        </Alert>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty || save.isPending} data-testid="rules-save">Save rules</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => setD(initial)}>Discard</Button>}
        {saved && !dirty && <span className="text-sm text-muted-foreground" data-testid="rules-saved">Saved.</span>}
      </div>

      <RulesHistory projectId={projectId} />
    </form>
  );
}

function RulesHistory({ projectId }: { projectId: string }) {
  const history = useRulesHistory(projectId);
  const rows = history.data ?? [];
  return (
    <section aria-labelledby="rules-history-heading" className="mt-2" data-testid="rules-history">
      <h2 id="rules-history-heading" className="mb-2 text-sm font-medium">History</h2>
      {history.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {rows.map((r) => (
            <div key={r.revision} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="rules-history-row">
              <span className="tnum w-12 text-muted-foreground">#{r.revision}</span>
              <span className="min-w-0 flex-1 truncate">{r.onBehalfOf ? `${r.actor} for ${r.onBehalfOf}` : r.actor}</span>
              <span className="text-muted-foreground" title={r.createdAt}>{relativeTime(r.createdAt)}</span>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
