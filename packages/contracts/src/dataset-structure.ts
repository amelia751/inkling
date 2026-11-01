import * as z from "zod";

/**
 * `DatasetStructure v1` (todo13 D8, §5 contracts): a dataset's collections, their fields and
 * formats, the relationships between collections and the annotation definitions with stable
 * label ids. The agent drafts it from inspection facts and the request; every inferred part
 * carries `suggested: true` until a person confirms it.
 *
 * Stored as `structure.json` in the dataset's working draft (todo12 Milestone 2 adds
 * field-level compatibility on this file). Ids are stable strings chosen when a part is
 * created and never positions, so a rename or a reorder never breaks a reference.
 *
 * Emitted to `schemas/dataset-structure.v1.json` by `pnpm emit:schemas`; the kernel validates
 * every write against that file.
 */

export const DATASET_STRUCTURE_SCHEMA_VERSION = 1 as const;

/** A stable id: letters, digits, `_`, `-`, `.`, `:`; never a position. */
export const StructureId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "stable id");
const Name = z.string().min(1).max(200);

export const StructureFieldType = z.enum(["integer", "number", "decimal", "text", "category", "id", "date", "boolean", "list", "path", "empty"]);

export const StructureField = z
  .object({
    id: StructureId,
    name: Name,
    type: StructureFieldType,
    unit: z.string().max(32).optional(),
    required: z.boolean(),
    suggested: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "DatasetStructureField" });

export const StructureCollection = z
  .object({
    id: StructureId,
    name: Name,
    /** A detected kind (`image`, `dicom-series`, `table`…). */
    kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    /** File formats seen or expected ("PNG", "DICOM"). */
    formats: z.array(z.string().min(1).max(64)).max(32),
    fields: z.array(StructureField).max(500),
    suggested: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "DatasetStructureCollection" });

export const StructureRelationship = z
  .object({
    id: StructureId,
    /** Collection ids. */
    from: StructureId,
    to: StructureId,
    cardinality: z.enum(["1:1", "1:N", "N:1", "N:N"]),
    /** Field ids (or `name`, the item's file name) that join them: `["col:image_id", "name"]`. */
    keys: z.array(z.string().min(1).max(200)).max(8),
    suggested: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "DatasetStructureRelationship" });

export const StructureLabel = z
  .object({
    id: StructureId,
    name: Name,
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .strict()
  .meta({ id: "DatasetStructureLabel" });

export const StructureAnnotation = z
  .object({
    id: StructureId,
    collectionId: StructureId,
    /** A core geometry (`class`, `box`, `polygon`, `mask`, `span`, `instant`…). */
    geometry: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    labels: z.array(StructureLabel).max(1000),
    suggested: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "DatasetStructureAnnotation" });

export const DatasetStructure = z
  .object({
    schemaVersion: z.literal(DATASET_STRUCTURE_SCHEMA_VERSION),
    collections: z.array(StructureCollection).max(200),
    relationships: z.array(StructureRelationship).max(500),
    annotations: z.array(StructureAnnotation).max(200),
  })
  .strict()
  .superRefine((s, ctx) => {
    const unique = (ids: string[], path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) ctx.addIssue({ code: "custom", path: [path, i, "id"], message: `duplicate id ${id}` });
        seen.add(id);
      });
    };
    unique(
      s.collections.map((c) => c.id),
      "collections",
    );
    unique(
      s.relationships.map((r) => r.id),
      "relationships",
    );
    unique(
      s.annotations.map((a) => a.id),
      "annotations",
    );
    const cols = new Set(s.collections.map((c) => c.id));
    s.relationships.forEach((r, i) => {
      for (const end of ["from", "to"] as const) if (!cols.has(r[end])) ctx.addIssue({ code: "custom", path: ["relationships", i, end], message: `no collection ${r[end]}` });
    });
    s.annotations.forEach((a, i) => {
      if (!cols.has(a.collectionId)) ctx.addIssue({ code: "custom", path: ["annotations", i, "collectionId"], message: `no collection ${a.collectionId}` });
    });
  })
  .meta({ id: "DatasetStructure" });

export type DatasetStructure = z.infer<typeof DatasetStructure>;
export type StructureCollection = z.infer<typeof StructureCollection>;
export type StructureField = z.infer<typeof StructureField>;
export type StructureRelationship = z.infer<typeof StructureRelationship>;
export type StructureAnnotation = z.infer<typeof StructureAnnotation>;

export const emptyStructure = (): DatasetStructure => ({ schemaVersion: 1, collections: [], relationships: [], annotations: [] });

/**
 * `GET /api/v1/datasets/{id}/structure` and the agent's `propose_structure`: the structure on a
 * branch, and (for a proposal) what changed against the person's draft.
 */
export interface StructureDiffEntry {
  op: "add" | "remove" | "change";
  /** `collections/<id>`, `relationships/<id>`, `annotations/<id>`, `annotations/<id>/labels/<id>`… */
  path: string;
}

export interface DatasetStructureDoc {
  datasetId: string;
  /** `draft` (the person's working draft) or the agent's `work/agent-*` branch. */
  branch: string;
  structure: DatasetStructure;
  /** `sha256:` over the canonical JSON; a PUT names it as `baseHash` (409 when stale). */
  hash: string;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Where `structure.json` lives: `kernel` until versioning admits the path, then `versioning`. */
  storedIn: "kernel" | "versioning";
  diff?: StructureDiffEntry[];
}
