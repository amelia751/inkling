import type { DatasetCollection, DatasetField, DatasetProfile, DatasetRelationship } from "@studio/contracts/types";

/**
 * The dataset's typed structure draft (todo13 D8, §5 `DatasetStructure v1`), as the Datasets
 * pages read and confirm it. Stored by `todo13-organize` (`GET/PUT /api/v1/datasets/{id}/structure`,
 * `structure.json` on the working draft).
 */
// replaced by @studio/contracts DatasetStructure at merge
export interface DatasetStructure {
  schemaVersion: 1;
  collections: { id: string; name: string; kind: string; formats: string[]; fields: StructureField[]; suggested?: boolean }[];
  relationships: { id: string; from: string; to: string; cardinality: string; keys: string; suggested?: boolean }[];
  annotations: { id: string; collectionId: string; geometry: string; labels: { id: string; name: string; color?: string }[]; suggested?: boolean }[];
}
export interface StructureField {
  id: string;
  name: string;
  type: string;
  unit?: string;
  required: boolean;
  suggested?: boolean;
}

/**
 * A first structure from what inspection found, for a dataset that has none yet: every part
 * `suggested`, ids the profile's (stable: `kind:<kind>` or the definition's collection ids).
 * Confirming one collection writes this with that collection confirmed.
 */
export function structureFromProfile(p: Pick<DatasetProfile, "collections" | "relationships">): DatasetStructure {
  return {
    schemaVersion: 1,
    collections: p.collections.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      formats: c.formats.map((f) => f.label),
      fields: c.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, ...(f.unit ? { unit: f.unit } : {}), required: f.required, suggested: f.suggested ?? true })),
      suggested: c.suggested,
    })),
    relationships: p.relationships.map((r) => ({ id: r.id, from: r.from, to: r.to, cardinality: r.cardinality, keys: r.keys, suggested: r.status === "suggested" })),
    annotations: [],
  };
}

/** The same structure with these collections (and their fields) confirmed: no longer `suggested`. */
export function confirmCollections(s: DatasetStructure, ids: string[]): DatasetStructure {
  const pick = new Set(ids);
  return {
    ...s,
    collections: s.collections.map((c) => (pick.has(c.id) ? { ...c, suggested: false, fields: c.fields.map((f) => ({ ...f, suggested: false })) } : c)),
  };
}

/**
 * The profile as the structure describes it: a collection the structure has keeps the
 * structure's name and confirmed state (inspection still supplies counts and facts); a field
 * the structure defines but inspection didn't find is listed from the structure. Parts the
 * structure doesn't know stay as inspection inferred them (`suggested`).
 */
export function applyStructure(p: DatasetProfile, s: DatasetStructure | null | undefined): DatasetProfile {
  if (!s) return p;
  const byId = new Map(s.collections.map((c) => [c.id, c]));
  const collections: DatasetCollection[] = p.collections.map((c) => {
    const sc = byId.get(c.id);
    if (!sc) return c;
    const have = new Set(c.fields.map((f) => f.id));
    const sf = new Map(sc.fields.map((f) => [f.id, f]));
    const fields: DatasetField[] = [
      ...c.fields.map((f) => (sf.has(f.id) ? { ...f, suggested: !!sf.get(f.id)!.suggested } : f)),
      ...sc.fields.filter((f) => !have.has(f.id)).map((f) => ({ id: f.id, name: f.name, type: f.type, ...(f.unit ? { unit: f.unit } : {}), required: f.required, filled: 0, source: "structure" as const, suggested: !!f.suggested })),
    ];
    return { ...c, name: sc.name || c.name, suggested: !!sc.suggested, fields };
  });
  const rels = new Map(s.relationships.map((r) => [r.id, r]));
  const relationships: DatasetRelationship[] = p.relationships.map((r) => {
    const sr = rels.get(r.id);
    return sr && sr.suggested === false ? { ...r, status: "confirmed" } : r;
  });
  return { ...p, collections, relationships };
}

/** Collections and connections still waiting for a person to confirm them. */
export function pendingSuggestions(p: Pick<DatasetProfile, "collections" | "relationships">): { collections: number; relationships: number } {
  return { collections: p.collections.filter((c) => c.suggested).length, relationships: p.relationships.filter((r) => r.status === "suggested").length };
}
