import { z } from "zod";

/**
 * The operations catalogue (todo16 D7): every project operation a person, the assistant or the
 * MCP server can run, with the API route it maps to and its risk tier. The assistant's project
 * tools (apps/agent/src/tools/operations.ts) and the MCP kernel tools are generated from it, and
 * the kernel's agent route allowlist names the same routes, so nothing is "UI only" by accident.
 *
 * Tiers (D8): *read* and *write* (reversible) run; *trash* (recoverable) runs and shows Undo, and
 * asks first for a dataset, Studio, project or more than `AGENT_TRASH_ASK_OVER` files; *destroy*
 * (purge, empty trash, delete forever) always asks, and sends the approval id as `X-Approval-Id`.
 *
 * Org admin (members, API keys, secrets, billing, security) is deliberately not here: people only.
 * Paths are relative to `/api/v1` and use `{pid}` for the session's project; other `{name}`
 * placeholders are filled from the input field of the same name.
 */
export const OPERATION_TIERS = ["read", "write", "trash", "destroy"] as const;
export type OperationTier = (typeof OPERATION_TIERS)[number];

export interface Operation {
  /** `resource.verb`, e.g. `dataset.delete`. Tools are named after it (`dataset_delete`). */
  id: string;
  tier: OperationTier;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  input: z.ZodObject<z.ZodRawShape>;
  description: string;
  /** Where the input goes besides path placeholders: the query string or the JSON body (default: GET/DELETE query, else body). */
  inputIn?: "query" | "body";
  /** Body template for routes that take a fixed shape (`fs/ops`): input fields fill it. */
  fsOp?: "mkdir" | "rename" | "move" | "copy" | "trash" | "restore" | "purge";
  /** The kind of thing a trash or destroy removes, for the "asks first" rule and the cards. */
  removes?: "files" | "dataset" | "collection" | "studio" | "project" | "trash";
  /**
   * todo17 D7: this operation can touch something published (the rules, the label set or
   * environment of a published Studio, the content of a dataset with a published Studio). When
   * an agent (the assistant, an MCP/OAuth client, an API key without admin) runs it against a
   * published target, the api opens (or adds to) the agent's change request instead of applying
   * it and answers 202 `{ changeRequest }`. People, drafts and agent scratch apply directly.
   */
  published?: "change-request";
}

/** Over this many files, the assistant asks before trashing (`STUDIO_API_AGENT_TRASH_ASK_OVER`). */
export const AGENT_TRASH_ASK_OVER_DEFAULT = 100;

const id = z.string().min(1);
const ids = z.array(id).min(1).max(1000);
const name = z.string().min(1).max(255);
const none = z.object({});

const fs = (fsOp: NonNullable<Operation["fsOp"]>): Pick<Operation, "method" | "path" | "fsOp" | "inputIn"> => ({ method: "POST", path: "/projects/{pid}/fs/ops", fsOp, inputIn: "body" });

export const OPERATIONS: Operation[] = [
  // ---- Sources (files and folders) -----------------------------------------------------------
  { id: "source.list", tier: "read", method: "GET", path: "/projects/{pid}/fs/children", input: z.object({ parentId: id.optional(), trashed: z.boolean().optional() }), description: "List a folder's children in Sources by current names (no contents)." },
  { id: "source.search", tier: "read", method: "GET", path: "/projects/{pid}/search", input: z.object({ q: z.string().min(1).max(200) }), description: "Find files and folders in Sources by name." },
  { id: "source.mkdir", tier: "write", ...fs("mkdir"), input: z.object({ parentId: id, name }), description: "Create a folder in Sources." },
  { id: "source.rename", tier: "write", ...fs("rename"), input: z.object({ nodeId: id, name }), description: "Rename a file or folder." },
  { id: "source.move", tier: "write", ...fs("move"), input: z.object({ nodeIds: ids, parentId: id }), description: "Move files or folders into another folder." },
  { id: "source.copy", tier: "write", ...fs("copy"), input: z.object({ nodeIds: ids, parentId: id }), description: "Copy files or folders into another folder." },
  { id: "source.trash", tier: "trash", ...fs("trash"), input: z.object({ nodeIds: ids }), removes: "files", description: "Move files or folders to the Trash (restorable for 30 days)." },
  { id: "source.restore", tier: "write", ...fs("restore"), input: z.object({ nodeIds: ids }), description: "Restore files or folders from the Trash." },
  { id: "source.purge", tier: "destroy", ...fs("purge"), input: z.object({ nodeIds: ids }), removes: "files", description: "Delete files or folders in the Trash forever. Can't be undone." },
  { id: "source.versions_restore", tier: "write", method: "POST", path: "/source-nodes/{nodeId}/versions/{version}/restore", input: z.object({ nodeId: id, version: z.number().int().min(1) }), description: "Make an earlier version of a file the current one." },
  { id: "source.star", tier: "write", method: "POST", path: "/source-nodes/{nodeId}/star", input: z.object({ nodeId: id }), description: "Star a file or folder." },
  { id: "source.unstar", tier: "write", method: "DELETE", path: "/source-nodes/{nodeId}/star", input: z.object({ nodeId: id }), description: "Remove a star." },
  { id: "source.undo", tier: "write", method: "POST", path: "/projects/{pid}/fs/undo", input: z.object({ batchId: id.optional() }), inputIn: "body", description: "Undo a batch of changes (this turn's, by default the latest)." },
  // ---- Imports --------------------------------------------------------------------------------
  { id: "import.list", tier: "read", method: "GET", path: "/projects/{pid}/imports", input: none, description: "List the project's imports and their status." },
  { id: "import.cancel", tier: "write", method: "POST", path: "/imports/{importId}/cancel", input: z.object({ importId: id }), description: "Cancel an import that is still running." },
  { id: "import.retry", tier: "write", method: "POST", path: "/imports/{importId}/retry", input: z.object({ importId: id }), description: "Retry a failed import." },
  // ---- Datasets and collections ---------------------------------------------------------------
  { id: "dataset.list", tier: "read", method: "GET", path: "/projects/{pid}/datasets", input: none, description: "List the project's datasets (names, counts)." },
  { id: "dataset.create", tier: "write", method: "POST", path: "/projects/{pid}/datasets", input: z.object({ name, nodeIds: ids.optional() }), description: "Create a dataset, optionally from files or folders in Sources." },
  { id: "dataset.rename", tier: "write", method: "PATCH", path: "/projects/{pid}/datasets/{datasetId}", input: z.object({ datasetId: id, name: name.optional(), description: z.string().max(2000).optional() }), description: "Rename a dataset or change its description." },
  { id: "dataset.add_files", tier: "write", method: "POST", path: "/projects/{pid}/datasets/{datasetId}/add-followed", input: z.object({ datasetId: id, nodeIds: ids }), published: "change-request", description: "Add files or folders from Sources to a dataset." },
  { id: "dataset.delete", tier: "trash", method: "DELETE", path: "/projects/{pid}/datasets/{datasetId}", input: z.object({ datasetId: id }), removes: "dataset", description: "Move a dataset (with its collections and Studios) to the Trash. Its files stay in Sources." },
  { id: "collection.rename", tier: "write", method: "PATCH", path: "/projects/{pid}/collections/{collectionId}", input: z.object({ collectionId: id, name }), description: "Rename a collection." },
  { id: "collection.delete", tier: "trash", method: "DELETE", path: "/projects/{pid}/collections/{collectionId}", input: z.object({ collectionId: id }), removes: "collection", description: "Move a collection to the Trash." },
  // ---- Structure (accepting stays a person's) -------------------------------------------------
  { id: "structure.propose", tier: "write", method: "PUT", path: "/datasets/{datasetId}/structure", input: z.object({ datasetId: id, structure: z.record(z.string(), z.unknown()) }), description: "Propose a dataset structure on the assistant's own branch; the person accepts it." },
  // ---- Studios --------------------------------------------------------------------------------
  { id: "studio.boot", tier: "write", method: "POST", path: "/projects/{pid}/boots", input: z.object({ datasetId: id.optional(), intent: z.string().max(2000).optional() }), description: "Create a draft Studio." },
  { id: "studio.rename", tier: "write", method: "PATCH", path: "/projects/{pid}/studios/{taskId}", input: z.object({ taskId: id, name }), description: "Rename a Studio." },
  { id: "studio.patch", tier: "write", method: "PATCH", path: "/api/environments/{pid}", input: z.object({ patch: z.array(z.record(z.string(), z.unknown())) }), published: "change-request", description: "Patch the Studio's environment (undoable through its history). On a published Studio, an agent's patch opens a change request." },
  { id: "studio.publish", tier: "write", method: "POST", path: "/tasks/{taskId}/publish", input: z.object({ taskId: id }), description: "Publish a draft Studio so annotators can use it." },
  { id: "studio.delete", tier: "trash", method: "DELETE", path: "/projects/{pid}/studios/{taskId}", input: z.object({ taskId: id }), removes: "studio", description: "Move a Studio (its environment and annotations) to the Trash." },
  // ---- Labels and exports ---------------------------------------------------------------------
  { id: "labels.export", tier: "read", method: "POST", path: "/boundary/annotations/export", input: z.object({ datasetId: id.optional(), format: z.string().max(40).optional() }), description: "Export labels (summaries only reach the assistant)." },
  // ---- Rules (todo17 D3) ----------------------------------------------------------------------
  { id: "rules.update", tier: "write", method: "PATCH", path: "/projects/{pid}/rules", input: z.object({ ops: z.array(z.record(z.string(), z.unknown())).min(1), baseRevision: z.number().int().min(0) }), published: "change-request", description: "Change the project's rules with a JSON Patch. From an agent this opens a change request that a person reviews (or that merges itself when every check passes)." },
  { id: "labels.rename", tier: "write", method: "POST", path: "/projects/{pid}/labels/rename", input: z.object({ from: name, to: name, baseRevision: z.number().int().min(0).optional() }), description: "Rename a label in the rules (the old name becomes a synonym) and rewrite its annotations. Undoable." },
  { id: "labels.merge", tier: "write", method: "POST", path: "/projects/{pid}/labels/merge", input: z.object({ from: z.array(name).min(1).max(100), into: name, baseRevision: z.number().int().min(0).optional() }), description: "Merge labels or synonyms into one label (they become its synonyms) and rewrite their annotations. Undoable." },
  { id: "labels.undo", tier: "write", method: "POST", path: "/projects/{pid}/labels/undo/{historyId}", input: z.object({ historyId: z.number().int().min(1) }), description: "Undo a label rename or merge (rules and annotations), if the rules haven't changed since." },
  // ---- Project --------------------------------------------------------------------------------
  { id: "project.overview", tier: "read", method: "GET", path: "/projects/{pid}/overview", input: none, description: "The project at a glance: sources, datasets, Studios, counts." },
  { id: "project.rename", tier: "write", method: "PATCH", path: "/projects/{pid}", input: z.object({ name }), description: "Rename the project." },
  { id: "project.describe", tier: "write", method: "PATCH", path: "/projects/{pid}", input: z.object({ description: z.string().max(2000) }), description: "Change the project's description." },
  { id: "project.archive", tier: "write", method: "PATCH", path: "/projects/{pid}", input: z.object({ archived: z.boolean() }), description: "Archive or unarchive the project (hidden but kept)." },
  { id: "project.delete", tier: "trash", method: "DELETE", path: "/projects/{pid}", input: none, removes: "project", description: "Move the whole project to Deleted projects (restorable for 30 days)." },
  // ---- Trash ----------------------------------------------------------------------------------
  { id: "trash.list", tier: "read", method: "GET", path: "/projects/{pid}/trash", input: z.object({ kind: z.enum(["all", "sources", "datasets", "collections", "studios"]).optional() }), description: "What is in the project's Trash: who deleted it, when, days left." },
  { id: "trash.restore", tier: "write", method: "POST", path: "/projects/{pid}/trash/{batchId}/restore", input: z.object({ batchId: id }), description: "Restore everything deleted together in one batch." },
  { id: "trash.destroy", tier: "destroy", method: "DELETE", path: "/projects/{pid}/trash/{batchId}", input: z.object({ batchId: id }), removes: "trash", description: "Delete one batch in the Trash forever. Can't be undone." },
  { id: "trash.empty", tier: "destroy", method: "POST", path: "/projects/{pid}/trash/empty", input: none, removes: "trash", description: "Empty the project's Trash: everything in it is deleted forever. Can't be undone." },
];

export const OPERATIONS_BY_ID: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map((o) => [o.id, o]));

/** The tool name an operation gets in the assistant and the MCP server. */
export const operationToolName = (opId: string) => opId.replace(/\./g, "_");

/** The `{name}` placeholders in an operation's path (besides `{pid}`). */
export const pathParams = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((p) => p !== "pid");

/**
 * Turn an operation and its (validated) input into the HTTP request: path filled, the rest as
 * query or body; `fs/ops` operations wrap their input as one op.
 */
export function operationRequest(op: Operation, pid: string, input: Record<string, unknown>): { method: Operation["method"]; path: string; query?: Record<string, string>; body?: unknown } {
  const rest: Record<string, unknown> = { ...input };
  let path = op.path.replace("{pid}", encodeURIComponent(pid));
  for (const p of pathParams(op.path)) {
    path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p] ?? "")));
    delete rest[p];
  }
  if (op.fsOp) return { method: op.method, path, body: { ops: [{ kind: op.fsOp, ...rest }] } };
  const where = op.inputIn ?? (op.method === "GET" || op.method === "DELETE" ? "query" : "body");
  if (where === "query") {
    const query = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return { method: op.method, path, ...(Object.keys(query).length ? { query } : {}) };
  }
  return { method: op.method, path, body: rest };
}

/** JSON for `schemas/operations.json` (input as JSON Schema). */
export function operationsDocument(): { operations: { id: string; tool: string; tier: OperationTier; method: string; path: string; description: string; removes?: string; published?: string; input: unknown }[] } {
  return {
    operations: OPERATIONS.map((o) => ({
      id: o.id,
      tool: operationToolName(o.id),
      tier: o.tier,
      method: o.method,
      path: o.path,
      description: o.description,
      ...(o.removes ? { removes: o.removes } : {}),
      ...(o.published ? { published: o.published } : {}),
      input: z.toJSONSchema(o.input, { unrepresentable: "any", io: "input" }),
    })),
  };
}
