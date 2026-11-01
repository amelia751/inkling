import { Link, useSearchParams } from "react-router";
import type { DatasetCollection, DatasetField } from "@studio/contracts/types";
import { ChevronDownIcon, InfoIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { ErrorView } from "@/studio/app/routes/errors";
import { kindIcon } from "@/studio/lib/file-kinds";
import { sourcesUrl } from "@/studio/lib/routes";
import { useViewport } from "@/studio/lib/use-media-query";
import type { DatasetViewProps } from "../DatasetLayout";
import { countOf, fieldType, itemShape, percent } from "../model";
import { CollectionThumb, DatasetInspector, Facts, InspectorSection, SuggestedBadge, Workspace } from "../shared";

/** Kinds with a dedicated reading of their facts; the rest get the safe generic view (§15.17). */
const UNDERSTOOD = new Set(["image", "dicom", "dicom-series", "volume", "mask", "video", "slide", "waveform", "table", "document"]);

/**
 * Fields & Formats (docs/datasets.md §6): how each collection is represented and what shape an
 * item has. Read-only in Phase 1. Physical format and logical fields are shown apart (§15.4);
 * plain words first, ids and keys under "Technical details".
 */
export function FieldsAndFormats({ projectId, profile }: DatasetViewProps) {
  const [params, setParams] = useSearchParams();
  const desktop = useViewport() === "desktop";
  const set = (key: "collection" | "field", value: string | null) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        if (key === "collection") p.delete("field");
        return p;
      },
      { replace: true },
    );
  if (profile.error) return <ErrorView variant="section" error={profile.error} what="fields and formats" onRetry={() => void profile.refetch()} />;
  const p = profile.data;
  if (!p)
    return (
      <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]" aria-busy>
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  if (!p.collections.length)
    return (
      <Card>
        <EmptyState
          art="files"
          title="Nothing to describe yet"
          description="Fields and formats appear once the dataset has files and they've been checked."
          data-testid="fields-empty"
          actions={
            <Button variant="outline" size="lg" asChild>
              <Link to={sourcesUrl(projectId)}>Open Sources</Link>
            </Button>
          }
        />
      </Card>
    );
  const c = p.collections.find((x) => x.id === params.get("collection")) ?? p.collections[0];
  const field = c.fields.find((f) => f.id === params.get("field")) ?? null;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      {desktop ? (
        <nav aria-label="Collections" className="sticky top-4">
          <Card className="overflow-hidden p-1" data-testid="collection-picker">
            {p.collections.map((x) => {
              const Icon = kindIcon(x.kind);
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => set("collection", x.id)}
                  aria-current={x.id === c.id ? "true" : undefined}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-generic", x.id === c.id && "bg-selection text-brand-heavy hover:bg-selection-hover")}
                >
                  <Icon className="size-4 shrink-0 text-hint" />
                  <span className="min-w-0 flex-1 truncate">{x.name}</span>
                  <span className="tnum shrink-0 text-xs text-muted-foreground">{x.count.toLocaleString()}</span>
                </button>
              );
            })}
          </Card>
        </nav>
      ) : (
        <Select value={c.id} onValueChange={(v) => set("collection", v)}>
          <SelectTrigger aria-label="Collection" data-testid="collection-picker"><SelectValue /></SelectTrigger>
          <SelectContent>
            {p.collections.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <Workspace inspector={field && <FieldInspector collection={c} field={field} onClose={() => set("field", null)} />} inspectorTitle={field?.name ?? "Field"} onCloseInspector={() => set("field", null)}>
        <CollectionShape collection={c} snapshot={p.snapshot.label} selected={field?.id ?? null} onSelect={(id) => set("field", id)} />
      </Workspace>
    </div>
  );
}

function CollectionShape({ collection: c, snapshot, selected, onSelect }: { collection: DatasetCollection; snapshot: string; selected: string | null; onSelect: (id: string) => void }) {
  const shape = itemShape(c);
  const columns = c.fields.filter((f) => f.id.startsWith("col:"));
  const properties = c.fields.filter((f) => !f.id.startsWith("col:"));
  return (
    <div className="flex flex-col gap-6" data-testid="collection-shape" data-collection={c.id}>
      <div className="flex items-start gap-4">
        <CollectionThumb collection={c} className="size-20" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-header-1 font-semibold">{c.name}</h2>
            {c.suggested && <SuggestedBadge what="This collection" />}
          </div>
          <p className="tnum mt-0.5 text-sm text-muted-foreground">
            {countOf(c.count, c.unit)}
            {c.files !== c.count && <> in {c.files.toLocaleString()} files</>}
          </p>
          {shape && <p className="mt-1 text-sm">One {c.unit.one}: {shape}</p>}
        </div>
      </div>

      {!UNDERSTOOD.has(c.kind) && (
        <p className="flex items-start gap-2 rounded-lg bg-generic px-3 py-2 text-sm" data-testid="generic-format">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          We don't have a detailed reading for this kind of file yet, so only what's certain is shown. A plugin can add one.
        </p>
      )}

      <section aria-labelledby="ff-format">
        <h3 id="ff-format" className="mb-2 text-body-2 font-semibold">Format</h3>
        <Card className="p-4 text-sm" data-testid="collection-format">
          {c.formats.length ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {c.formats.map((f) => (
                <Badge key={f.label} theme="clear" size="sm">
                  {f.label} <span className="tnum text-muted-foreground">{f.count.toLocaleString()}</span>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-muted-foreground">File format not known.</p>
          )}
          {c.facts.length ? (
            <Facts
              rows={c.facts.map((f) => [
                f.label,
                <span key={f.key}>
                  {f.values.map((v, i) => (
                    <span key={v.value}>
                      {i > 0 && <span className="text-hint"> · </span>}
                      {v.value}
                      {(f.values.length > 1 || f.more > 0 || f.missing > 0) && <span className="tnum text-muted-foreground"> ({v.count.toLocaleString()})</span>}
                    </span>
                  ))}
                  {f.more > 0 && <span className="text-muted-foreground"> · {f.more.toLocaleString()} more</span>}
                  {f.missing > 0 && <span className="block text-xs text-muted-foreground">Not known for {f.missing.toLocaleString()}</span>}
                </span>,
              ])}
            />
          ) : (
            <p className="text-muted-foreground">Inspection didn't record size or shape for these files.</p>
          )}
        </Card>
      </section>

      {columns.length > 0 && <FieldTable title="Columns" hint="From the tables' headers; values are never shown here." fields={columns} selected={selected} onSelect={onSelect} testid="collection-columns" />}
      {properties.length > 0 && <FieldTable title="Properties of each item" hint="What every item carries, from inspection and the structure." fields={properties} selected={selected} onSelect={onSelect} testid="collection-fields" />}

      <section aria-labelledby="ff-provenance">
        <h3 id="ff-provenance" className="mb-2 text-body-2 font-semibold">Where this comes from</h3>
        <Card className="p-4 text-sm" data-testid="collection-provenance">
          <Facts
            rows={[
              ["Snapshot", snapshot],
              ["Backed by", `${c.files.toLocaleString()} ${c.files === 1 ? "file" : "files"} this dataset pins`],
              ["Read by", "Inspection of each file (technical facts only, never contents)"],
              ["Collection", c.suggested ? "Suggested from the files; not confirmed yet" : "Confirmed in the dataset's structure"],
            ]}
          />
        </Card>
      </section>

      <details className="group text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-4 -rotate-90 transition-transform group-open:rotate-0" /> Technical details
        </summary>
        <div className="mt-2">
          <Facts
            rows={[
              ["Collection id", <code key="c" className="font-mono text-xs">{c.id}</code>],
              ["Detected kind", <code key="k" className="font-mono text-xs">{c.kind}</code>],
              ["Field ids", <code key="f" className="font-mono text-xs">{c.fields.map((f) => f.id).join(", ") || "—"}</code>],
            ]}
          />
        </div>
      </details>
    </div>
  );
}

function FieldTable({ title, hint, fields, selected, onSelect, testid }: { title: string; hint: string; fields: DatasetField[]; selected: string | null; onSelect: (id: string) => void; testid: string }) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="text-body-2 font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm" data-testid={testid}>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">Name</th>
              <th scope="col" className="px-4 py-2 font-medium">Type</th>
              <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">Unit</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Filled</th>
              <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">Required</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {fields.map((f) => (
              <tr key={f.id} className={cn("hover:bg-generic", selected === f.id && "bg-selection hover:bg-selection-hover")} data-testid="field-row" data-field={f.id}>
                <td className="px-4 py-2">
                  <span className="flex items-center gap-2">
                    <button type="button" onClick={() => onSelect(f.id)} className="text-left font-medium hover:underline" aria-pressed={selected === f.id}>
                      {f.name}
                    </button>
                    {f.key && <Badge theme="info" size="xs">Key</Badge>}
                    {f.suggested && <SuggestedBadge what="This field" />}
                  </span>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{fieldType(f.type)}</td>
                <td className="hidden px-4 py-2 text-muted-foreground sm:table-cell">{f.unit ?? "—"}</td>
                <td className="tnum px-4 py-2 text-right">{percent(f.filled)}</td>
                <td className="hidden px-4 py-2 text-muted-foreground sm:table-cell">{f.required ? "Yes" : "Optional"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

/** §6.3, read-only: what the field is, where it lives, and how changing it would work. */
function FieldInspector({ collection: c, field: f, onClose }: { collection: DatasetCollection; field: DatasetField; onClose: () => void }) {
  return (
    <DatasetInspector title={f.name} onClose={onClose}>
      <InspectorSection title="Field" testid="field-facts">
        <Facts
          rows={[
            ["Type", fieldType(f.type)],
            ["Unit", f.unit ?? "None"],
            ["Optional", f.required ? "No" : "Yes"],
            ["Filled", percent(f.filled)],
            ["Belongs to", c.name],
            ...(f.key ? ([["Key", "Unique in every table that has it"]] as [string, string][]) : []),
            ["Comes from", f.source === "inspection" ? "Inspection of the files" : "The dataset's structure"],
            ["Status", f.suggested ? "Suggested, not confirmed" : f.source === "structure" ? "Confirmed" : "Measured from the files"],
          ]}
        />
      </InspectorSection>
      <InspectorSection title="Technical">
        <Facts rows={[["Stable id", <code key="id" className="font-mono text-xs">{f.id}</code>]]} />
      </InspectorSection>
      <InspectorSection title="Changing it">
        <p className="text-muted-foreground">
          A rename, a new unit or a new constraint becomes a proposed change that someone reviews before it applies. A unit change also converts the values and rechecks what uses them.
        </p>
      </InspectorSection>
    </DatasetInspector>
  );
}
