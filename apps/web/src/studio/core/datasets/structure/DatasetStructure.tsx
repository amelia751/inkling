import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DatasetCollection, DatasetProfile, DatasetRelationship } from "@studio/contracts/types";
import { RelationshipIcon, SearchIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState, NoResults } from "@studio/ui/ui/empty-state";
import { Input } from "@studio/ui/ui/input";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { ErrorView } from "@/studio/app/routes/errors";
import { KINDS } from "@/studio/lib/file-kinds";
import { confirmProposal, NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { datasetUrl, exploreUrl } from "@/studio/lib/routes";
import { notify } from "@/studio/lib/files/announce";
import type { DatasetViewProps } from "../DatasetLayout";
import { StructureUnavailableError, usePutStructure } from "../api";
import { useAddData } from "../add-data";
import { countOf, percent } from "../model";
import { confirmCollections, structureFromProfile, type DatasetStructure as StructureDraft } from "../structure";
import { CollectionThumb, DatasetInspector, Facts, InspectorSection, SelectableRow, SuggestedBadge, Workspace } from "../shared";

/**
 * Structure (docs/datasets.md §5): what things exist and how they relate. Entity types and
 * their links, never one node per file. Phase 1 is the list view (the accessible alternative
 * the graph will keep); suggested links can be confirmed, everything else is read-only.
 */
export function DatasetStructure({ projectId, dataset, profile, structure, canEdit }: DatasetViewProps) {
  const [params, setParams] = useSearchParams();
  const addData = useAddData(projectId, dataset);
  const put = usePutStructure(projectId, dataset.id);
  /** Confirm collections: write the stored draft (or, with none yet, one drafted from inspection) with them confirmed. */
  const confirm = (ids: string[]) => {
    if (!profile.data) return;
    const base: StructureDraft = structure ?? structureFromProfile(profile.data);
    put.mutate(confirmCollections(base, ids), {
      onSuccess: () => notify(ids.length === 1 ? "Collection confirmed" : `${ids.length} collections confirmed`, { tone: "success" }),
      onError: (e) => notify(e instanceof StructureUnavailableError ? e.message : e instanceof Error ? e.message : String(e), { tone: "error" }),
    });
  };
  const [q, setQ] = useState("");
  const selected = params.get("select");
  const select = (id: string | null) =>
    setParams(
      (p) => {
        if (id) p.set("select", id);
        else p.delete("select");
        return p;
      },
      { replace: true },
    );
  if (profile.error) return <ErrorView variant="section" error={profile.error} what="this dataset's structure" onRetry={() => void profile.refetch()} />;
  const p = profile.data;
  if (!p)
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-9 w-72 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  if (!p.collections.length)
    return (
      <Card>
        <EmptyState
          art="dataset"
          title="No structure yet"
          description="Collections appear once the dataset has files and they've been checked."
          actions={
            canEdit && (
              <Button variant="outline" size="lg" onClick={() => addData("drop")}>
                Add data
              </Button>
            )
          }
          data-testid="structure-empty"
        />
      </Card>
    );
  const name = (id: string) => p.collections.find((c) => c.id === id)?.name ?? id;
  const needle = q.trim().toLowerCase();
  const collections = p.collections.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.fields.some((f) => f.name.toLowerCase().includes(needle)));
  const relationships = p.relationships.filter((r) => !needle || `${name(r.from)} ${name(r.to)} ${r.keys}`.toLowerCase().includes(needle));
  const pickedCollection = p.collections.find((c) => c.id === selected);
  const pickedRelationship = p.relationships.find((r) => r.id === selected);
  const suggested = p.collections.filter((c) => c.suggested);
  const inspector = pickedCollection ? (
    <EntityInspector projectId={projectId} datasetId={dataset.id} collection={pickedCollection} profile={p} onClose={() => select(null)} onConfirm={canEdit && pickedCollection.suggested ? () => confirm([pickedCollection.id]) : undefined} confirming={put.isPending} />
  ) : pickedRelationship ? (
    <RelationshipInspector projectId={projectId} r={pickedRelationship} from={name(pickedRelationship.from)} to={name(pickedRelationship.to)} canEdit={canEdit} onClose={() => select(null)} />
  ) : null;
  return (
    <Workspace inspector={inspector} inspectorTitle={pickedCollection?.name ?? "Connection"} onCloseInspector={() => select(null)}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-hint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search collections and fields" className="pl-8" aria-label="Search collections and fields" data-testid="structure-search" />
        </div>
        <p className="text-sm text-muted-foreground">
          {countOf(p.collections.length, { one: "collection", other: "collections" })} · {countOf(p.relationships.length, { one: "connection", other: "connections" })}
          {suggested.length > 0 && <> · {countOf(suggested.length, { one: "suggested", other: "suggested" })}</>}
        </p>
        {canEdit && suggested.length > 0 && (
          <Button variant="outline" size="sm" className="sm:ml-auto" loading={put.isPending} onClick={() => confirm(suggested.map((c) => c.id))} title="Says these collections are right; inspection keeps their counts up to date" data-testid="confirm-all-collections">
            Confirm {suggested.length === 1 ? "suggested collection" : `${suggested.length} suggested collections`}
          </Button>
        )}
      </div>
      {needle && !collections.length && !relationships.length ? (
        <NoResults what="collections or fields" onClear={() => setQ("")} />
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="st-collections">
            <h2 id="st-collections" className="mb-2 text-sm font-medium text-muted-foreground">Collections</h2>
            <Card className="divide-y divide-border overflow-hidden" data-testid="structure-collections">
              {collections.map((c) => (
                <SelectableRow key={c.id} selected={selected === c.id} onSelect={() => select(c.id)} data-testid="structure-collection" data-collection={c.id}>
                  <CollectionThumb collection={c} className="size-10" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.name}</span>
                      {c.suggested && <SuggestedBadge what="This collection" />}
                    </span>
                    <span className="tnum block truncate text-muted-foreground">
                      {countOf(c.count, c.unit)}
                      {c.fields.length > 0 && <> · {countOf(c.fields.length, { one: "field", other: "fields" })}</>}
                      {c.formats.length > 0 && <> · {c.formats.map((f) => f.label).join(", ")}</>}
                    </span>
                  </span>
                  {c.issues > 0 && <Badge theme="warning" size="xs">{c.issues.toLocaleString()} with issues</Badge>}
                </SelectableRow>
              ))}
            </Card>
          </section>
          <section aria-labelledby="st-connections">
            <h2 id="st-connections" className="mb-2 text-sm font-medium text-muted-foreground">Connections</h2>
            {relationships.length === 0 ? (
              <Card>
                <EmptyState
                  art="empty"
                  size="m"
                  title="No connections yet"
                  description={p.collections.some((c) => c.kind === "table") ? "Explore can link a table's rows to files or folders by an ID column." : "Connections link collections, like a table of diagnoses to the scans it describes."}
                  actions={
                    p.collections.some((c) => c.kind === "table") && (
                      <Button variant="outline" size="lg" asChild>
                        <Link to={exploreUrl(projectId, "relationships")}>Open Explore</Link>
                      </Button>
                    )
                  }
                />
              </Card>
            ) : (
              <Card className="divide-y divide-border overflow-hidden" data-testid="structure-connections">
                {relationships.map((r) => (
                  <SelectableRow key={r.id} selected={selected === r.id} onSelect={() => select(r.id)} data-testid="structure-connection" data-connection={r.id}>
                    <RelationshipIcon className="size-4 shrink-0 text-hint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {name(r.from)} <span className="tnum font-normal text-muted-foreground">{r.cardinality.replace(":", " : ")}</span> {name(r.to)}
                      </span>
                      <span className="block truncate text-muted-foreground">{r.keys}{coverageText(r)}</span>
                    </span>
                    {r.status === "suggested" ? <SuggestedBadge what="This connection" /> : <Badge theme="success" size="xs">Confirmed</Badge>}
                  </SelectableRow>
                ))}
              </Card>
            )}
          </section>
        </div>
      )}
    </Workspace>
  );
}

function coverageText(r: DatasetRelationship): string {
  const c = r.coverage;
  if (!c?.rows) return "";
  return ` · ${percent(c.matched / c.rows)} of rows matched`;
}

function EntityInspector({ projectId, datasetId, collection: c, profile, onClose, onConfirm, confirming }: { projectId: string; datasetId: string; collection: DatasetCollection; profile: DatasetProfile; onClose: () => void; onConfirm?: () => void; confirming?: boolean }) {
  const links = profile.relationships.filter((r) => r.from === c.id || r.to === c.id);
  const name = (id: string) => profile.collections.find((x) => x.id === id)?.name ?? id;
  const required = c.fields.filter((f) => f.required);
  const issues = profile.issues.filter((i) => i.collectionId === c.id);
  return (
    <DatasetInspector title={c.name} onClose={onClose}>
      <div className="flex items-center gap-3">
        <CollectionThumb collection={c} className="size-14" />
        <p className="text-muted-foreground">
          {KINDS[c.kind]?.plural ?? c.name}, one {c.unit.one} per item. {c.suggested && "Inferred from inspection."}
        </p>
      </div>
      <InspectorSection title="Records">
        <Facts
          rows={[
            ["Items", countOf(c.count, c.unit)],
            ["Files", c.files.toLocaleString()],
            ["Formats", c.formats.map((f) => `${f.label} (${f.count.toLocaleString()})`).join(", ") || "Not known"],
          ]}
        />
      </InspectorSection>
      <InspectorSection title="Always present">
        {required.length ? <p>{required.map((f) => f.name).join(", ")}</p> : <p className="text-muted-foreground">{c.fields.length ? "No field is filled for every item." : "No fields recorded yet."}</p>}
      </InspectorSection>
      <InspectorSection title="Connections">
        {links.length ? (
          <ul className="space-y-1">
            {links.map((r) => (
              <li key={r.id}>
                {name(r.from)} → {name(r.to)} <span className="text-muted-foreground">({r.status})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Not connected to another collection.</p>
        )}
      </InspectorSection>
      <InspectorSection title="Quality">
        {issues.length ? (
          <ul className="space-y-1">
            {issues.map((i) => <li key={i.id}>{i.title}</li>)}
          </ul>
        ) : (
          <p className="text-muted-foreground">No problems found.</p>
        )}
      </InspectorSection>
      <InspectorSection title="Status" testid="collection-status">
        <p className={c.suggested ? "text-muted-foreground" : undefined}>{c.suggested ? "Suggested: inferred from the files, not confirmed by anyone yet." : "Confirmed."}</p>
      </InspectorSection>
      <div className="flex flex-wrap gap-2">
        {onConfirm && (
          <Button size="sm" loading={confirming} onClick={onConfirm} data-testid="confirm-collection">
            Confirm
          </Button>
        )}
        <Button variant="outline" size="sm" asChild>
          <Link to={`${datasetUrl(projectId, datasetId, "fields")}?collection=${encodeURIComponent(c.id)}`}>Fields & Formats</Link>
        </Button>
      </div>
    </DatasetInspector>
  );
}

/** §5.3: what the link means, its keys, how well it holds, and what to do about the rest. */
function RelationshipInspector({ projectId, r, from, to, canEdit, onClose }: { projectId: string; r: DatasetRelationship; from: string; to: string; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => confirmProposal(r.proposalId!),
    onSuccess: () => {
      notify("Connection confirmed", { tone: "success" });
      void qc.invalidateQueries({ queryKey: projectKeys.datasets(projectId) });
      void qc.invalidateQueries({ queryKey: projectKeys.proposals(projectId) });
    },
  });
  const c = r.coverage;
  const open = c ? c.unmatched + c.ambiguous : 0;
  return (
    <DatasetInspector title={`${from} → ${to}`} onClose={onClose}>
      <p>{r.label}</p>
      <InspectorSection title="How it links" testid="relationship-keys">
        <Facts
          rows={[
            ["Keys", <code key="k" className="font-mono text-xs">{r.keys}</code>],
            ["Cardinality", r.cardinality === "1:N" ? `One row, many ${to}` : r.cardinality === "1:1" ? "One row, one item" : r.cardinality],
            ["Status", r.status === "suggested" ? "Suggested, not enforced" : "Confirmed"],
          ]}
        />
      </InspectorSection>
      {c && (
        <InspectorSection title="Coverage" testid="relationship-coverage">
          <Facts
            rows={[
              ["Matched", `${c.matched.toLocaleString()} of ${c.rows.toLocaleString()} rows`],
              ["Not found", c.unmatched.toLocaleString()],
              ["More than one match", c.ambiguous.toLocaleString()],
            ]}
          />
        </InspectorSection>
      )}
      {confirm.error && <Alert theme="danger">{confirm.error instanceof NeedsApiError ? "Confirming needs the full stack: see docs/running.md" : confirm.error.message}</Alert>}
      <div className="flex flex-wrap gap-2">
        {r.proposalId && (
          <Button variant={open ? "default" : "outline"} size="sm" asChild>
            <Link to={exploreUrl(projectId, "relationships", r.proposalId)}>{open ? `Inspect ${open.toLocaleString()} unmatched` : "View in Explore"}</Link>
          </Button>
        )}
        {canEdit && r.status === "suggested" && r.proposalId && (
          <Button variant="outline" size="sm" loading={confirm.isPending} onClick={() => confirm.mutate()} data-testid="confirm-connection">
            Confirm
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Confirming says this link is right; rows that don't match stay unlinked until someone picks.
      </p>
    </DatasetInspector>
  );
}
