import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DropMessagePart } from "@studio/agent-protocol";
import type { KernelClient } from "./kernel.ts";

/**
 * Drops (todo13 D2/D3): files the person dropped, pasted or attached in the chat. Their bytes
 * went to Files through the browser; the agent only ever reads the drop's `DropSummary` from the
 * kernel (`GET /api/v1/drops/:id`, agent view): counts, groups, and per file its node id, its
 * screened name, its kind and technical facts. This module keeps it that way on our side too:
 * `safeSummary` keeps only the summary's known fields and drops any value that looks like bytes
 * or a link to them (base64, data or signed URLs), whatever the kernel sent.
 */

export const DROP_ID = /^drp-[a-z0-9]{8,40}$/;

export interface DropSummary {
  dropId: string;
  origin?: string;
  state?: string;
  total: number;
  byKind: Record<string, number>;
  bytes: number;
  states: Record<string, number>;
  groups: { groupId: string; kind: string; count: number; shape?: string; suggestedAction?: string }[];
  files: { nodeId: string; agentName: string; kind?: string; facts?: Record<string, unknown> }[];
  nextOffset?: number;
  /** Files the browser declared (todo20 D8): "still uploading (12 of 35)". */
  expected?: number;
  /** Grouped findings (rule, outcome, count): never file names. */
  findings?: { rule: string; outcome: string; count: number; message?: string }[];
  failure?: { step?: string; reason: string };
  /** One line for the model and the tool row: where the drop is ("Still uploading (12 of 35)"). */
  status?: string;
}

/** Strings that may carry bytes or a way to fetch them: never in the model's context. */
const UNSAFE = /data:[^,]*,|base64|https?:\/\/|[?&](X-Goog-Signature|X-Amz-Signature|sig|signature|token)=|[A-Za-z0-9+/=_-]{120,}/i;
const FACT_KEYS = new Set(["format", "width", "height", "frames", "fps", "duration", "modality", "columns", "rows", "pages", "channels", "sampleRate", "sample_rate", "dims", "spacing", "sliceCount", "bitDepth", "signals", "leads"]);
const ID = /^[A-Za-z0-9:_.-]{1,128}$/;
const SAFE_NAME = /^[^/\\]{1,255}$/;

const str = (v: unknown, max = 64) => (typeof v === "string" && v.length <= max && !UNSAFE.test(v) ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const counts = (o: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k, v]) => ID.test(k) && typeof v === "number").map(([k, v]) => [k, v as number]));

function safeFact(v: unknown, depth = 0): unknown {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return str(v, 120);
  if (depth > 2) return undefined;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => safeFact(x, depth + 1)).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, safeFact(x, depth + 1)]).filter(([k, x]) => x !== undefined && ID.test(String(k))));
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

export function safeSummary(raw: any): DropSummary {
  const files = (Array.isArray(raw?.files) ? raw.files : [])
    .filter((f: any) => typeof f?.nodeId === "string" && ID.test(f.nodeId))
    .map((f: any) => {
      const name = typeof f.agentName === "string" && SAFE_NAME.test(f.agentName) && !UNSAFE.test(f.agentName) ? f.agentName : "file";
      const facts = Object.fromEntries(Object.entries(f.facts && typeof f.facts === "object" ? f.facts : {}).filter(([k]) => FACT_KEYS.has(k)).map(([k, v]) => [k, safeFact(v)]).filter(([, v]) => v !== undefined));
      return { nodeId: f.nodeId, agentName: name, ...(str(f.kind) ? { kind: f.kind } : {}), ...(Object.keys(facts).length ? { facts } : {}) };
    });
  const groups = (Array.isArray(raw?.groups) ? raw.groups : []).slice(0, 50).map((g: any) => ({
    groupId: str(g?.groupId) ?? "group",
    kind: str(g?.kind) ?? "unknown",
    count: num(g?.count),
    ...(str(g?.shape) ? { shape: g.shape } : {}),
    ...(str(g?.suggestedAction) ? { suggestedAction: g.suggestedAction } : {}),
  }));
  return {
    dropId: String(raw?.dropId ?? ""),
    ...(str(raw?.origin) ? { origin: raw.origin } : {}),
    ...(str(raw?.state) ? { state: raw.state } : {}),
    total: num(raw?.total),
    byKind: counts(raw?.byKind),
    bytes: num(raw?.bytes),
    states: counts(raw?.states),
    groups,
    files,
    ...(typeof raw?.nextOffset === "number" ? { nextOffset: raw.nextOffset } : {}),
    ...(num(raw?.expected) ? { expected: num(raw.expected) } : {}),
    ...(Array.isArray(raw?.findings) && raw.findings.length
      ? { findings: raw.findings.slice(0, 20).map((g: any) => ({ rule: str(g?.rule) ?? "rule", outcome: str(g?.outcome) ?? "reported", count: num(g?.count), ...(str(g?.message, 200) ? { message: g.message } : {}) })) }
      : {}),
    ...(raw?.failure && str(raw.failure.reason, 300) ? { failure: { reason: raw.failure.reason, ...(str(raw.failure.step) ? { step: raw.failure.step } : {}) } } : {}),
  };
}

/** States a drop ends in (todo20 D8); the classifier's own states count as settled too. */
export const SETTLED_DROP_STATES = new Set(["ready", "partly_ready", "duplicate", "failed", "classified", "planned", "applied"]);

const plural = (n: number, one = "file") => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;

/** Where the drop is, in one line: never "0 files" while it's still uploading. */
export function dropStatus(s: DropSummary): string {
  const st = s.state ?? "uploading";
  const total = s.total;
  const failed = s.states.failed ?? 0;
  const findings = (s.findings ?? []).map((g) => `${plural(g.count)}: ${g.rule} (${g.outcome})`).join("; ");
  switch (st) {
    case "uploading": {
      const of = Math.max(s.expected ?? 0, total);
      const arrived = total - (s.states.uploading ?? 0);
      return of ? `Still uploading (${arrived.toLocaleString("en-US")} of ${of.toLocaleString("en-US")})` : "Still uploading: no file has arrived yet";
    }
    case "inspecting": {
      const checking = s.states.checking ?? 0;
      return checking ? `Still checking (${(total - checking).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} checked)` : `Still checking ${plural(total)}`;
    }
    case "duplicate": {
      const n = s.states.duplicate ?? total;
      return `These ${plural(n)} are already in this project`;
    }
    case "failed":
      return `The drop failed: ${s.failure?.reason ?? (failed ? `${plural(failed)} didn't upload` : "nothing was added")}${findings ? ` (${findings})` : ""}`;
    case "partly_ready":
      return `${plural(total - failed)} ready, ${failed.toLocaleString("en-US")} failed`;
    default:
      return `${plural(total)} ready`;
  }
}

export interface WaitOptions {
  /** Give up after this long and report where the drop is (default 20 s). */
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stop waiting once this holds (default: the drop settled). */
  done?: (s: DropSummary) => boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * todo20 D5/D8: read a drop once it has settled (ready, partly ready, duplicate, failed, or
 * classified), polling at most `timeoutMs`. A drop still uploading after that comes back with
 * `settled: false` and a status such as "Still uploading (12 of 35)".
 */
export async function waitForDrop(k: KernelClient, dropId: string, opts: WaitOptions = {}): Promise<{ summary: DropSummary; settled: boolean }> {
  const { timeoutMs = 20_000, intervalMs = 1_000, signal, sleep = realSleep, now = Date.now, done } = opts;
  const until = now() + timeoutMs;
  for (;;) {
    const summary = await fetchDropSummary(k, dropId, 0, signal);
    const settled = SETTLED_DROP_STATES.has(summary.state ?? "");
    if (settled || done?.(summary) || now() + intervalMs > until || signal?.aborted) return { summary: { ...summary, status: dropStatus(summary) }, settled };
    await sleep(intervalMs);
  }
}

export async function fetchDropSummary(k: KernelClient, dropId: string, offset = 0, signal?: AbortSignal): Promise<DropSummary> {
  if (!DROP_ID.test(dropId)) throw new Error("dropId must look like drp-…");
  const raw = await k.get(`/drops/${encodeURIComponent(dropId)}${offset ? `?offset=${offset}` : ""}`, signal);
  return safeSummary(raw);
}

/** The drop part of the user message, as stored and emitted (`custom` name `drop`). */
export function dropPart(s: DropSummary): DropMessagePart {
  return { type: "drop", dropId: s.dropId, files: s.files.map((f) => ({ nodeId: f.nodeId, agentName: f.agentName, ...(f.kind ? { kind: f.kind } : {}), state: f.kind ? "ready" : "checking" })) };
}

/** What the model reads with the user's message: the summary, never bytes, names or links. */
export function dropBlock(s: DropSummary | undefined, dropId: string, error?: string): string {
  if (!s) return `<drop id="${dropId}" unavailable="${(error ?? "the drop couldn't be read").replace(/"/g, "'")}"/>`;
  return [
    `<drop id="${s.dropId}">`,
    "The user dropped files into the chat. They are in the project's Files (Shared in chat). Names are screened; read more with get_drop.",
    `Status: ${s.status ?? dropStatus(s)}.${SETTLED_DROP_STATES.has(s.state ?? "") ? "" : " The drop hasn't settled: call get_drop (it waits) before saying how many files there are."}`,
    JSON.stringify(s),
    "</drop>",
  ].join("\n");
}

export function createDropTools(k: KernelClient): ToolDefinition<any, any, any>[] {
  const getDrop = defineTool({
    name: "get_drop",
    label: "Reading dropped files",
    description:
      "Files the user dropped, pasted or attached in the chat (a drop): counts by kind and state, groups, and for each file its node id, its screened name, its kind and technical facts (dimensions, frames, duration, modality, column names and types, pages), refreshed as inspection proceeds. Never contents. Pages 50 files at a time (offset).",
    promptSnippet: "A chat drop's files: kinds, states, groups, screened names and facts",
    parameters: Type.Object({
      dropId: Type.String({ description: "The drop's id (drp-…), from the <drop> block on the user's message." }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many files (for drops of more than 50)." })),
    }),
    async execute(_id, args, signal) {
      // todo20 D8: wait (bounded) for the drop to settle; never report "0 files" mid-upload.
      const s = args.offset ? { ...(await fetchDropSummary(k, args.dropId, args.offset, signal)) } : (await waitForDrop(k, args.dropId, { signal })).summary;
      s.status ??= dropStatus(s);
      const kinds = Object.entries(s.byKind).map(([kind, n]) => `${n} ${kind}`).join(", ");
      const settled = SETTLED_DROP_STATES.has(s.state ?? "");
      const label = settled && s.state !== "duplicate" && s.state !== "failed" ? `${s.status}${kinds ? ` · ${kinds}` : ""}` : s.status;
      return { content: [{ type: "text" as const, text: JSON.stringify(s) }], details: { summary: label } };
    },
  });
  return [getDrop, ...createAddDataTools(k)];
}

/** What an import from a link or a copy tells the model (todo16 D10): file facts, never bytes or links. */
export function safeImport(raw: any): { importId: string; state?: string; files: { name: string; size: number; state?: string; reason?: string }[]; committed: number } {
  const files = (Array.isArray(raw?.files) ? raw.files : []).slice(0, 200).map((f: any) => ({
    name: typeof f?.name === "string" && SAFE_NAME.test(posixBase(f.name)) && !UNSAFE.test(f.name) ? posixBase(f.name) : "file",
    size: num(f?.size),
    ...(str(f?.state) ? { state: f.state } : {}),
    ...(str(f?.reason, 200) ? { reason: f.reason } : {}),
  }));
  return { importId: String(raw?.importId ?? ""), ...(str(raw?.state) ? { state: raw.state } : {}), files, committed: num(raw?.totals?.committed) };
}

const posixBase = (n: string) => n.split("/").pop() ?? n;
const importSummary = (r: ReturnType<typeof safeImport>) => (r.state === "fetching" ? "fetching the link" : `${r.committed} file${r.committed === 1 ? "" : "s"} added`);

export function createAddDataTools(k: KernelClient): ToolDefinition<any, any, any>[] {
  const pid = () => encodeURIComponent(k.workspaceId);
  const importFromUrl = defineTool({
    name: "import_from_url",
    label: "Importing from a link",
    description:
      "Import one file from a public https:// link or a gs:// object this project can read into the project's Sources. The person is asked to confirm they have the rights to add it first. The kernel fetches it in the background (state \"fetching\"), then inspects it; you get only its import id and state, never its contents. Private and local addresses are refused; the size limit is set by the deployment.",
    promptSnippet: "Add a file to Sources from an https:// or gs:// link (facts only)",
    parameters: Type.Object({
      url: Type.String({ description: "The https:// or gs:// link the user gave." }),
      folderId: Type.Optional(Type.String({ description: "A folder id from list_folder to land in (optional)." })),
    }),
    // Runs only after the policy's approval card ("Do you have the rights to add this data?")
    // was approved by the person, so `attested: true` is their answer, not the model's.
    async execute(_id, args, signal) {
      const r = safeImport(await k.post(`/projects/${pid()}/imports/url`, { url: args.url, attested: true, ...(args.folderId ? { folderId: args.folderId } : {}) }, signal));
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }], details: { summary: importSummary(r) } };
    },
  });
  const copyInto = defineTool({
    name: "copy_into_project",
    label: "Copying files",
    description:
      "Copy files into this project's Sources from a sample (sampleId) or from another project the user can read (fromProjectId), optionally only some nodes (nodeIds). The person is asked to confirm they have the rights to add them first. The files are inspected as for an upload; you get only names, sizes and states.",
    promptSnippet: "Copy files from a sample or another readable project into Sources",
    parameters: Type.Object({
      sampleId: Type.Optional(Type.String({ description: "A sample's id." })),
      fromProjectId: Type.Optional(Type.String({ description: "Another project's id." })),
      nodeIds: Type.Optional(Type.Array(Type.String(), { description: "Files or folders of that project to copy (default: all)." })),
      folderId: Type.Optional(Type.String({ description: "A folder id of this project to land in (optional)." })),
    }),
    async execute(_id, args, signal) {
      if (!args.sampleId === !args.fromProjectId) throw new Error("Give exactly one of sampleId or fromProjectId.");
      // Runs only after the person approved the rights card (policy), so `attested` is theirs.
      const r = safeImport(await k.post(`/projects/${pid()}/imports/copy`, { ...args, attested: true }, signal));
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }], details: { summary: importSummary(r) } };
    },
  });
  return [importFromUrl, copyInto];
}
