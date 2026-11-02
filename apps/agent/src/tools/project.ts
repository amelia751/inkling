import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { KernelError, type KernelClient } from "./kernel.ts";

/**
 * Project tools (todo6 Phase 6, docs/ux.md §9): what the assistant can read about a project
 * outside the Studio, through the kernel's project routes with the session's kernel token
 * (bound to one project; tools never take a project argument).
 *
 * Read-only, with two P1 hooks that write *proposals* only (`propose_schema`,
 * `propose_relationship`): proposals change no data, a person confirms them in Explore, and
 * the policy still asks before each one. `confirm_proposal` exists so that a model that tries
 * gets the kernel's own refusal (403: only a person confirms), reported as such, rather than a
 * rule that lives only in this service.
 *
 * Privacy: files held for privacy review are never described to the model (no name, facts or
 * path; only that a held file exists), and a `restricted` project shares structure only
 * (kinds, counts and statuses, no file or folder names).
 *
 * Structure (todo13 D8): `propose_structure` drafts a dataset's `structure.json` (collections,
 * fields, relationships, label definitions with stable ids) on the agent's own `work/agent-*`
 * branch and returns the diff against the person's draft. The person accepts it; with the
 * kernel's auto-apply on, it's accepted for them when the dataset is their own draft (D6).
 *
 * Files (todo7 Phase 8): `list_folder` and `find_files` read the project's drive by current
 * names. They never return contents, facts or the name a file was uploaded with
 * (`originalPath`, old names: they may hold the identifier someone renamed away). The
 * assistant can't change files: it proposes a plan with the `propose_reorganization` card and
 * the person applies it; the kernel answers 403 to `fs/ops` with this token.
 */

export const PROJECT_TOOL_NAMES = [
  "project_overview",
  "list_sources",
  "describe_source_node",
  "list_proposals",
  "list_import_issues",
  "propose_schema",
  "propose_relationship",
  "confirm_proposal",
  "list_folder",
  "find_files",
  "propose_structure",
] as const;

const out = (value: unknown, summary: string) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { summary } });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const enc = encodeURIComponent;

const HELD = "Held for privacy review: not shared with the assistant.";

interface Node {
  id: string;
  name: string;
  kind: "folder" | "file" | "sequence";
  detectedKind: string | null;
  displayPath?: string;
  childCount: number;
  descendantCount: number;
  size: number | null;
  facts: Record<string, unknown>;
  flags: Record<string, unknown>;
  status: string;
  path?: { id: string; name: string }[];
  usedIn?: { id: string; title: string }[];
}

const held = (n: { status?: string; flags?: Record<string, unknown> }) =>
  n.status === "privacy" || !!(n.flags?.privacy && !(n.flags.privacy as { clearedBy?: string }).clearedBy);

/** A node as the model may see it: held files are only a marker; restricted projects lose names. */
export function shareNode(n: Node, restricted: boolean): Record<string, unknown> {
  if (held(n)) return { id: n.id, kind: n.kind, status: "privacy", note: HELD };
  const named = !restricted;
  const flags = Object.fromEntries(Object.entries(n.flags ?? {}).filter(([k]) => k !== "privacy" && (named || k !== "duplicate_of")));
  return {
    id: n.id,
    ...(named ? { name: n.displayPath ?? n.name } : {}),
    kind: n.kind,
    detectedKind: n.detectedKind,
    status: n.status,
    ...(n.kind === "file" ? { size: n.size } : { childCount: n.childCount, descendantCount: n.descendantCount }),
    ...(Object.keys(n.facts ?? {}).length ? { facts: named ? withoutSensitive(n.facts) : summarizeFacts(n.facts) } : {}),
    ...(Object.keys(flags).length ? { flags } : {}),
  };
}

/** Restricted projects: facts minus anything string-valued that could carry a name or identifier. */
function summarizeFacts(facts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => typeof v === "number" || typeof v === "boolean"));
}

/** Fact keys that can carry the name or path a file arrived with (todo7 Phase 7). */
const SENSITIVE_FACT_KEY = /^(original_?path|rel_?path|uploaded_?as|original_?name|old_?names?|previous_?names?|source_?path)$/i;
const withoutSensitive = (facts: Record<string, unknown>) => Object.fromEntries(Object.entries(facts).filter(([k]) => !SENSITIVE_FACT_KEY.test(k)));

/**
 * A drive entry for list_folder / find_files: current name, kind and counts only (no facts, no
 * original path). Held files are a marker; restricted projects lose names.
 */
export function fileEntry(n: Node & { parentId?: string | null; locked?: boolean }, restricted: boolean, withParent = false): Record<string, unknown> {
  if (held(n)) return { id: n.id, kind: n.kind, status: "privacy", note: HELD, ...(withParent ? { parentId: n.parentId ?? null } : {}) };
  return {
    id: n.id,
    ...(restricted ? {} : { name: n.displayPath ?? n.name }),
    kind: n.kind,
    detectedKind: n.detectedKind,
    status: n.status,
    ...(n.kind === "file" ? { size: n.size } : { childCount: n.childCount, descendantCount: n.descendantCount }),
    ...(n.locked ? { locked: true } : {}),
    ...(withParent ? { parentId: n.parentId ?? null } : {}),
  };
}

interface ProjectInfo {
  id: string;
  title: string;
  description?: string;
  restricted?: boolean;
  license?: string;
}

export function createProjectTools(k: KernelClient): ToolDefinition<any, any, any>[] {
  const pid = () => enc(k.workspaceId);
  const project = (signal?: AbortSignal) => k.get<ProjectInfo>(`/projects/${pid()}`, signal);

  const overview = defineTool({
    name: "project_overview",
    label: "Reading project",
    description:
      "The open project at a glance: title, description, tasks, what data it holds (counts per kind) and what needs attention (privacy holds, import problems, proposals to confirm). Start here for questions about the project as a whole.",
    promptSnippet: "Project summary: tasks, data and what needs attention",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      const o = await k.get<any>(`/projects/${pid()}/overview`, signal);
      const restricted = !!o.project?.restricted;
      const attention = (o.attention ?? []).map((a: any) =>
        a.type === "privacy"
          ? { type: "privacy", severity: a.severity, title: a.title, note: HELD, target: { section: a.target?.section, nodeId: a.target?.nodeId } }
          : { type: a.type, severity: a.severity, title: a.title, ...(restricted ? {} : { detail: a.detail }), strength: a.strength, target: a.target },
      );
      const value = {
        project: { id: o.project?.id, title: o.project?.title, description: o.project?.description, sample: o.project?.sample, license: o.project?.license, restricted },
        tasks: o.tasks ?? [],
        data: (o.data ?? []).map((d: any) => ({ type: d.type, title: d.title, count: d.count, kind: d.kindLabel ?? d.kind, sourceId: d.sourceId, nodeId: d.nodeId, datasetId: d.datasetId })),
        attention,
        attentionTotal: o.attentionTotal ?? attention.length,
        empty: !!o.empty,
        latestImport: o.latestImport,
        heldFiles: attention.filter((a: any) => a.type === "privacy").length,
      };
      return out(value, `${plural(value.data.length, "data card")} · ${plural(value.attentionTotal, "item")} to look at`);
    },
  });

  const listSources = defineTool({
    name: "list_sources",
    label: "Listing sources",
    description:
      "What was imported into this project: each source (an upload or a sample) with its file count and status, and the first level of its folder tree (folders, files and collapsed numbered runs such as scan001–scan120.dcm). " +
      "Pass nodeId to list one folder instead. Files are shown as uploaded; names may be meaningless (IM-0001.dcm).",
    promptSnippet: "Sources and their top-level folders (or one folder's contents)",
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: "A folder (or sequence) id from an earlier listing, to list its contents." })),
      sourceId: Type.Optional(Type.String({ description: "The source that folder belongs to (required with nodeId)." })),
    }),
    async execute(_id, args, signal) {
      const p = await project(signal);
      const restricted = !!p.restricted;
      const page = async (sourceId: string, node: string | null) => {
        const r = await k.get<{ items: Node[]; total: number; nextCursor: string | null }>(`/sources/${enc(sourceId)}/children${node ? `?node=${enc(node)}` : ""}`, signal);
        const items = r.items.slice(0, 100).map((n) => shareNode(n, restricted));
        return { total: r.total, shown: items.length, items, more: r.total > items.length };
      };
      if (args.nodeId) {
        if (!args.sourceId) throw new Error("Pass the sourceId the folder belongs to (from list_sources).");
        if (!args.nodeId.startsWith("seq:")) {
          const n = await k.get<Node>(`/source-nodes/${enc(args.nodeId)}`, signal);
          if (held(n)) return out({ nodeId: args.nodeId, note: HELD }, "Held for privacy review");
        }
        const listing = await page(args.sourceId, args.nodeId);
        return out({ nodeId: args.nodeId, ...listing, restricted }, plural(listing.total, "entry"));
      }
      const r = await k.get<{ sources: any[] }>(`/projects/${pid()}/sources`, signal);
      const sources = await Promise.all(
        r.sources.map(async (s) => ({
          id: s.id,
          ...(restricted ? {} : { title: s.title }),
          kind: s.kind,
          status: s.status,
          fileCount: s.fileCount,
          rootNodeId: s.rootNodeId,
          usedInDatasets: s.usedInDatasets,
          top: s.rootNodeId ? await page(s.id, null) : undefined,
        })),
      );
      const files = sources.reduce((n, s) => n + (s.fileCount ?? 0), 0);
      return out({ project: { id: p.id, title: p.title, restricted }, sources }, `${plural(sources.length, "source")} · ${plural(files, "file")}`);
    },
  });

  const describeNode = defineTool({
    name: "describe_source_node",
    label: "Reading file details",
    description:
      "One file or folder in Data: what was detected (kind, facts such as columns, dimensions or series), its flags (duplicate, unsupported, quality), where it sits and which datasets use it. Never the file's contents. Files held for privacy review are not described.",
    promptSnippet: "Facts and flags for one source file or folder",
    parameters: Type.Object({ nodeId: Type.String({ description: "A node id from list_sources." }) }),
    async execute(_id, args, signal) {
      const [p, n] = await Promise.all([project(signal), k.get<Node>(`/source-nodes/${enc(args.nodeId)}`, signal)]);
      if (held(n)) return out({ id: n.id, status: "privacy", note: HELD }, "Held for privacy review");
      const restricted = !!p.restricted;
      const value = {
        ...shareNode(n, restricted),
        ...(restricted ? {} : { path: n.path?.map((x) => x.name).join(" / ") }),
        usedIn: n.usedIn?.map((d) => ({ id: d.id, title: d.title })),
      };
      return out(value, `${n.detectedKind ?? n.kind} · ${n.status}`);
    },
  });

  const listProposals = defineTool({
    name: "list_proposals",
    label: "Listing proposals",
    description:
      "Proposals waiting in Explore (groups, relationships, mappings, datasets, tasks) with their strength (strong / possible / weak) and evidence. Proposals change nothing until a person confirms them in Explore.",
    promptSnippet: "Proposals to confirm in Explore",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("confirmed"), Type.Literal("dismissed"), Type.Literal("all")], { description: "Default: proposed." })),
    }),
    async execute(_id, args, signal) {
      const status = args.status === "all" ? "" : (args.status ?? "proposed");
      const r = await k.get<{ proposals: any[] }>(`/projects/${pid()}/proposals${status ? `?status=${status}` : ""}`, signal);
      const proposals = r.proposals.map((x) => ({ id: x.id, kind: x.kind, strength: x.strength, status: x.status, payload: x.payload, evidence: x.evidence, createdBy: x.createdBy, createdAt: x.createdAt }));
      return out({ proposals }, plural(proposals.length, "proposal"));
    },
  });

  const importIssues = defineTool({
    name: "list_import_issues",
    label: "Checking imports",
    description:
      "Problems from imports: uploads that failed or were rejected, files skipped as duplicates, files that can't be read yet, and files held for privacy review (counted, never named). Use it for 'did my upload work?' questions.",
    promptSnippet: "Failed, rejected, duplicate, unreadable and held files from imports",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      const [p, imp, review] = await Promise.all([
        project(signal),
        k.get<{ imports: any[] }>(`/projects/${pid()}/imports`, signal),
        k.get<{ items: any[] }>(`/projects/${pid()}/review`, signal).catch((e) => {
          if (e instanceof KernelError && e.status === 404) return { items: [] };
          throw e;
        }),
      ]);
      const restricted = !!p.restricted;
      const imports = imp.imports.slice(0, 20).map((s) => ({
        id: s.id,
        state: s.state,
        files: s.totals?.files,
        byState: s.totals?.byState,
        incomplete: s.totals?.incomplete,
        error: s.error,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      }));
      const items = review.items.filter((a) => a.type === "import" || a.type === "privacy" || a.type === "quality");
      const issues = items.map((a) =>
        a.type === "privacy" ? { type: "privacy", title: a.title, note: HELD, target: { section: a.target?.section, nodeId: a.target?.nodeId } } : { type: a.type, title: a.title, ...(restricted ? {} : { detail: a.detail }), target: a.target },
      );
      const bad = imports.filter((s) => s.state === "failed" || s.state === "needs_review" || s.incomplete).length;
      return out({ imports, issues, heldFiles: issues.filter((i) => i.type === "privacy").length }, `${plural(issues.length, "issue")} · ${plural(bad, "import")} needing a look`);
    },
  });

  /** A node the proposal points at must exist in this project and not be held. */
  async function checkNodes(ids: string[], signal?: AbortSignal) {
    for (const id of ids) {
      if (id.startsWith("seq:")) continue;
      const n = await k.get<Node>(`/source-nodes/${enc(id)}`, signal);
      if (held(n)) throw new Error(`${id} is held for privacy review; proposals can't use it until a person clears it.`);
    }
  }

  async function propose(kind: string, payload: Record<string, unknown>, evidence: Record<string, unknown>, strength: string, signal?: AbortSignal) {
    const r = await k.post<any>(`/projects/${pid()}/proposals`, { kind, payload, evidence, strength }, signal);
    return { proposal: { id: r.id, kind: r.kind, status: r.status, strength: r.strength, createdBy: r.createdBy }, explore: { section: "explore", proposalId: r.id } };
  }

  const strengthParam = Type.Optional(Type.Union([Type.Literal("strong"), Type.Literal("possible"), Type.Literal("weak")], { description: "How sure you are. Default: possible." }));

  const proposeSchema = defineTool({
    name: "propose_schema",
    label: "Proposing a table layout",
    description:
      "Propose how a table's columns should be read (type and role of each column, e.g. an ID that links to images, or a label column). Creates a proposal the user reviews and confirms in Explore; it changes no data. The user approves creating it first.",
    promptSnippet: "Propose a table's column layout (a proposal, confirmed in Explore)",
    parameters: Type.Object({
      nodeId: Type.String({ description: "The table's node id (from list_sources)." }),
      columns: Type.Array(
        Type.Object({
          name: Type.String(),
          type: Type.Union([Type.Literal("id"), Type.Literal("category"), Type.Literal("number"), Type.Literal("date"), Type.Literal("text"), Type.Literal("path")]),
          role: Type.Optional(Type.String({ description: "e.g. 'links to images', 'label', 'patient id'. Mark exactly one column 'label': the kernel reads its values as the label classes and computes the evidence itself." })),
        }),
        { minItems: 1, maxItems: 200 },
      ),
      reason: Type.String({ description: "One plain sentence: why this layout." }),
      strength: strengthParam,
    }),
    async execute(_id, args, signal) {
      await checkNodes([args.nodeId], signal);
      const r = await propose("mapping", { nodeId: args.nodeId, columns: args.columns }, { reason: args.reason }, args.strength ?? "possible", signal);
      return out(r, "Proposed · confirm in Explore");
    },
  });

  const proposeRelationship = defineTool({
    name: "propose_relationship",
    label: "Proposing a relationship",
    description:
      "Propose how two parts of the project fit together, e.g. 'diagnosis.csv column patient_id matches the MRI folders by name'. Creates a proposal the user reviews and confirms in Explore; it never merges, links or changes anything by itself. The user approves creating it first.",
    promptSnippet: "Propose a link between a table and files (a proposal, confirmed in Explore)",
    parameters: Type.Object({
      from: Type.Object({ nodeId: Type.String(), column: Type.Optional(Type.String({ description: "For a table: the column that holds the key." })) }),
      to: Type.Object({ nodeId: Type.String(), key: Type.Optional(Type.String({ description: "What on this side matches, e.g. 'folder name' or 'file name without extension'." })) }),
      rule: Type.String({ description: "The matching rule in plain words, e.g. 'P001 matches patient_001'." }),
      reason: Type.String({ description: "One plain sentence of evidence." }),
      strength: strengthParam,
    }),
    async execute(_id, args, signal) {
      await checkNodes([args.from.nodeId, args.to.nodeId], signal);
      const r = await propose("relationship", { from: args.from, to: args.to, rule: args.rule }, { reason: args.reason }, args.strength ?? "possible", signal);
      return out(r, "Proposed · confirm in Explore");
    },
  });

  const confirm = defineTool({
    name: "confirm_proposal",
    label: "Asking to confirm",
    description:
      "Ask the kernel to confirm a proposal. Only a person can confirm (docs: 'nothing proposed changes data until the user confirms it'), so the kernel refuses this for the assistant with 403. " +
      "Don't use it to get something done: offer open_location to Explore instead so the user confirms there. If it was refused, say so plainly.",
    promptSnippet: "Refused for the assistant (403): people confirm proposals in Explore",
    parameters: Type.Object({ proposalId: Type.String() }),
    async execute(_id, args, signal) {
      try {
        await k.post(`/proposals/${enc(args.proposalId)}/confirm`, {}, signal);
      } catch (e) {
        if (e instanceof KernelError && e.status === 403) throw new Error(`Refused by the API (403): ${e.message}. Ask the user to confirm it in Explore.`);
        throw e;
      }
      // Never expected: the kernel lets only people confirm.
      return out({ confirmed: true }, "Confirmed");
    },
  });

  const LIST_MAX = 200;

  const listFolder = defineTool({
    name: "list_folder",
    label: "Listing folder",
    description:
      "One folder of the project's Sources (the drive): its subfolders and files by current name, with kind, status and counts. Leave nodeId out for the top of the drive. " +
      "Never file contents or the names files were uploaded with. Numbered runs (scan001–scan120.dcm) are one row; list the run's id to see its files. Use the ids with propose_reorganization.",
    promptSnippet: "One Files folder: names, kinds and counts",
    parameters: Type.Object({ nodeId: Type.Optional(Type.String({ description: "A folder (or numbered run) id from an earlier listing or find_files. Default: the top of the drive." })) }),
    async execute(_id, args, signal) {
      const p = await project(signal);
      const restricted = !!p.restricted;
      let folder: Record<string, unknown>;
      let writable: boolean | undefined;
      if (args.nodeId && !args.nodeId.startsWith("seq:")) {
        const n = await k.get<Node & { pathText?: string; locked?: boolean }>(`/source-nodes/${enc(args.nodeId)}`, signal);
        if (held(n)) return out({ nodeId: args.nodeId, note: HELD }, "Held for privacy review");
        if (n.kind === "file") throw new Error(`${args.nodeId} is a file, not a folder. Use describe_source_node for one file.`);
        folder = { id: n.id, ...(restricted ? {} : { name: n.name, path: n.pathText }), kind: n.kind, ...(n.locked ? { locked: true } : {}) };
      } else if (args.nodeId) {
        folder = { id: args.nodeId, kind: "sequence" };
      } else {
        const drive = await k.get<{ rootNodeId: string; writable: boolean }>(`/projects/${pid()}/fs`, signal);
        writable = drive.writable;
        folder = { id: drive.rootNodeId, name: "Sources", kind: "folder", root: true };
      }
      const q = new URLSearchParams({ limit: String(LIST_MAX), ...(args.nodeId ? { node: args.nodeId } : {}) });
      const r = await k.get<{ items: (Node & { parentId?: string | null; locked?: boolean })[]; total: number }>(`/projects/${pid()}/fs/children?${q}`, signal);
      const items = r.items.slice(0, LIST_MAX).map((n) => fileEntry(n, restricted));
      return out(
        { folder, ...(writable === false ? { writable, note: "Files can't be changed on this server (needs the full stack)." } : {}), total: r.total, shown: items.length, items, more: r.total > items.length, restricted },
        plural(r.total, "item"),
      );
    },
  });

  const findFiles = defineTool({
    name: "find_files",
    label: "Finding files",
    description:
      "Search the project's Sources by name (part of the current name, any case) and/or detected kind (image, dicom, dicom-series, volume, video, waveform, slide, table, document, mask, annotations, archive, unknown). " +
      "Returns ids, current names, kinds and the parent folder id (to group by folder), at most 200. Never contents or the names files were uploaded with.",
    promptSnippet: "Find files by name or kind",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Part of the name, e.g. 'patient_002' or '.csv'." })),
      kind: Type.Optional(Type.String({ description: "A detected kind, e.g. 'table' for spreadsheets." })),
    }),
    async execute(_id, args, signal) {
      const query = (args.query ?? "").trim().slice(0, 200);
      const kind = (args.kind ?? "").trim();
      if (!query && !kind) throw new Error("Pass a query, a kind, or both.");
      const p = await project(signal);
      const restricted = !!p.restricted;
      if (restricted && query) throw new Error("This project's licence is restricted: names aren't shared, so search by kind only.");
      const r = await k.get<{ items: (Node & { parentId?: string | null })[] }>(`/projects/${pid()}/search?${new URLSearchParams({ q: query, ...(kind ? { kind } : {}) })}`, signal);
      const live = r.items.filter((n) => !(n as { trashed?: boolean }).trashed);
      const items = live.slice(0, LIST_MAX).map((n) => fileEntry(n, restricted, true));
      return out({ query, kind: kind || undefined, total: live.length, shown: items.length, items, more: live.length > items.length }, `${live.length} match${live.length === 1 ? "" : "es"}`);
    },
  });

  const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$", description: "A stable id you choose (never a position): 'col-xray', 'normal'. Keep the ids the draft already has." });
  const suggested = Type.Optional(Type.Boolean({ description: "true for anything you inferred; the person confirms it." }));
  const proposeStructure = defineTool({
    name: "propose_structure",
    label: "Drafting the dataset structure",
    description:
      "Draft a dataset's structure: its collections (one kind each), their fields (from inspection facts: dimensions, modality, column names and types), relationships between collections, and the annotation definitions with stable label ids (from the person's request). Writes your own work branch, never the person's draft, and returns what changed against the draft; the person accepts it. Send the whole structure (read the current one from the plan or dataset first) and keep existing ids.",
    promptSnippet: "Draft a dataset's structure.json on your own branch (the person accepts it)",
    parameters: Type.Object({
      datasetId: Type.String({ description: "The dataset (from a drop plan, a boot or the project overview)." }),
      structure: Type.Object({
        schemaVersion: Type.Literal(1),
        collections: Type.Array(
          Type.Object({
            id,
            name: Type.String({ minLength: 1, maxLength: 200 }),
            kind: Type.String({ description: "A detected kind: image, dicom, dicom-series, volume, video, waveform, slide, table…" }),
            formats: Type.Array(Type.String(), { maxItems: 32 }),
            fields: Type.Array(
              Type.Object({
                id,
                name: Type.String({ minLength: 1, maxLength: 200 }),
                type: Type.Union(["integer", "number", "decimal", "text", "category", "id", "date", "boolean", "list", "path", "empty"].map((t) => Type.Literal(t))),
                unit: Type.Optional(Type.String({ maxLength: 32 })),
                required: Type.Boolean(),
                suggested,
              }),
              { maxItems: 500 },
            ),
            suggested,
          }),
          { maxItems: 200 },
        ),
        relationships: Type.Array(
          Type.Object({ id, from: id, to: id, cardinality: Type.Union(["1:1", "1:N", "N:1", "N:N"].map((t) => Type.Literal(t))), keys: Type.Array(Type.String(), { maxItems: 8 }), suggested }),
          { maxItems: 500 },
        ),
        annotations: Type.Array(
          Type.Object({
            id,
            collectionId: id,
            geometry: Type.String({ description: "A core geometry: class, box, polygon, mask, span, instant…" }),
            labels: Type.Array(Type.Object({ id, name: Type.String({ minLength: 1, maxLength: 200 }), color: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })) }), { maxItems: 1000 }),
            suggested,
          }),
          { maxItems: 200 },
        ),
      }),
      reason: Type.String({ description: "One plain sentence: what you drafted and why." }),
    }),
    async execute(_id, args, signal) {
      const r = await k.request<any>("PUT", `/datasets/${enc(args.datasetId)}/structure`, { json: { structure: args.structure }, signal });
      const diff = (r.diff ?? []) as { op: string; path: string }[];
      const result = { datasetId: args.datasetId, branch: r.branch, hash: r.hash, diff, accepted: !!r.accepted };
      return out(result, r.accepted ? `Structure drafted · ${plural(diff.length, "change")} (accepted on your draft)` : `Structure proposed · ${plural(diff.length, "change")} to accept`);
    },
  });

  return [overview, listSources, describeNode, listProposals, importIssues, proposeSchema, proposeRelationship, confirm, listFolder, findFiles, proposeStructure];
}
