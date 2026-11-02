import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Rules, RuleSeverity } from "@studio/contracts/rules";
import { lintRule } from "@studio/contracts/lint-rules";
import { api } from "@/studio/lib/projects-api";

/**
 * todo17 Milestones 2–4 from the browser: change requests, findings (Health), the rules document
 * and connected agents. Typed fetchers and React Query hooks over the contracts in the round-2
 * brief; every write's errors go through `parseProblem` (lib/problem.ts).
 */

const P = encodeURIComponent;

// ---- Change requests ---------------------------------------------------------------------------

export type ChangeState = "open" | "checking" | "passed" | "failed" | "needs-update" | "merged" | "closed";

export interface Finding {
  id?: string;
  rule: string;
  severity: "error" | "warn" | "info";
  path: string;
  message: string;
  fix?: string;
  fixable?: boolean;
  mode?: "enforce" | "evaluate";
  resourceKind?: string;
  resourceId?: string;
  source?: string;
  firstSeen?: string;
  resolvedAt?: string | null;
}

export interface ChangeComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ChangeRequest {
  id: string;
  projectId: string;
  title: string;
  actor: string;
  onBehalfOf: string | null;
  agent: string | null;
  state: ChangeState;
  operations: { op: string; input: unknown; base_revision?: number }[];
  findings: Finding[];
  base: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  mergedBy: string | null;
  mergedAt: string | null;
  comments: ChangeComment[];
}

export interface DiffRow {
  op: string;
  path: string;
  before: unknown;
  after: unknown;
}

export type ChangeDetail = ChangeRequest & { diff: DiffRow[] };

export const governanceKeys = {
  changes: (projectId: string, state: string) => ["changes", projectId, state] as const,
  change: (projectId: string, id: string) => ["change", projectId, id] as const,
  findings: (projectId: string) => ["findings", projectId] as const,
  rules: (projectId: string) => ["rules", projectId] as const,
  rulesHistory: (projectId: string) => ["rules-history", projectId] as const,
  agents: () => ["connected-agents"] as const,
};

export const fetchChanges = (projectId: string, state: "open" | "all" = "open") => api<{ changes: ChangeRequest[] }>(`/projects/${P(projectId)}/changes?state=${state}`).then((r) => r.changes ?? []);
export const fetchChange = (projectId: string, id: string) => api<ChangeDetail>(`/projects/${P(projectId)}/changes/${P(id)}`).then((c) => ({ ...c, diff: c.diff ?? [], findings: c.findings ?? [], comments: c.comments ?? [] }));
export const mergeChange = (projectId: string, id: string) => api<ChangeRequest>(`/projects/${P(projectId)}/changes/${P(id)}/merge`, { method: "POST" });
export const closeChange = (projectId: string, id: string) => api<ChangeRequest>(`/projects/${P(projectId)}/changes/${P(id)}/close`, { method: "POST" });
export const commentOnChange = (projectId: string, id: string, body: string) => api<ChangeComment>(`/projects/${P(projectId)}/changes/${P(id)}/comments`, { method: "POST", json: { body } });

export function useChanges(projectId: string, state: "open" | "all") {
  return useQuery({ queryKey: governanceKeys.changes(projectId, state), queryFn: () => fetchChanges(projectId, state), enabled: !!projectId, retry: false });
}

export function useChange(projectId: string, id: string | undefined) {
  return useQuery({ queryKey: governanceKeys.change(projectId, id ?? ""), queryFn: () => fetchChange(projectId, id ?? ""), enabled: !!projectId && !!id, retry: false });
}

/** Merge, Close and Comment, each refreshing the list and the open change. */
export function useChangeActions(projectId: string, id: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["changes", projectId] });
    void qc.invalidateQueries({ queryKey: governanceKeys.change(projectId, id) });
  };
  return {
    merge: useMutation({ mutationFn: () => mergeChange(projectId, id), onSettled: refresh }),
    close: useMutation({ mutationFn: () => closeChange(projectId, id), onSettled: refresh }),
    comment: useMutation({ mutationFn: (body: string) => commentOnChange(projectId, id, body), onSuccess: refresh }),
  };
}

export const CHANGE_STATE_LABEL: Record<ChangeState, string> = {
  open: "Open",
  checking: "Checking",
  passed: "Checks passed",
  failed: "Checks failed",
  "needs-update": "Needs update",
  merged: "Merged",
  closed: "Closed",
};

export const CHANGE_STATE_THEME: Record<ChangeState, "normal" | "info" | "success" | "warning" | "danger" | "utility" | "unknown"> = {
  open: "info",
  checking: "info",
  passed: "success",
  failed: "danger",
  "needs-update": "warning",
  merged: "utility",
  closed: "unknown",
};

/** Whether a change can still be merged or closed. */
export const isOpenChange = (c: Pick<ChangeRequest, "state">) => c.state !== "merged" && c.state !== "closed";

/** `agent:Claude Code` → "Claude Code"; a person id stays as it is. */
export function actorName(actor: string | null | undefined): string {
  if (!actor) return "Someone";
  return actor.startsWith("agent:") ? actor.slice("agent:".length) || "An agent" : actor;
}

/** "Claude Code for amelia" when an agent acted on someone's behalf. */
export function authorLine(c: Pick<ChangeRequest, "actor" | "agent" | "onBehalfOf">): string {
  const agent = c.agent ?? (c.actor?.startsWith("agent:") ? actorName(c.actor) : null);
  if (agent) return c.onBehalfOf ? `${agent} for ${c.onBehalfOf}` : agent;
  return actorName(c.actor);
}

/** A diff value as one short line: strings bare, the rest as JSON, `—` for nothing. */
export function diffValue(v: unknown, max = 160): string {
  if (v === undefined || v === null) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A tool result that opened (or appended to) a change request: `{ changeRequest: { id, title } }`. */
export function changeRequestOf(output: unknown): { id: string; title: string } | null {
  let o = output;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const cr = (o as { changeRequest?: unknown }).changeRequest;
  if (!cr || typeof cr !== "object") return null;
  const { id, title } = cr as { id?: unknown; title?: unknown };
  return typeof id === "string" && id ? { id, title: typeof title === "string" && title ? title : "Untitled change" } : null;
}

// ---- Findings (Health) -------------------------------------------------------------------------

export interface FindingsResponse {
  findings: Finding[];
  counts: { error: number; warn: number; info: number };
  wouldHaveRejected: Record<string, number>;
}

export const fetchFindings = (projectId: string) =>
  api<Partial<FindingsResponse>>(`/projects/${P(projectId)}/findings?state=open`).then(
    (r): FindingsResponse => ({ findings: r.findings ?? [], counts: { error: 0, warn: 0, info: 0, ...(r.counts ?? {}) }, wouldHaveRejected: r.wouldHaveRejected ?? {} }),
  );

export type FixResult = { applied: true } | { changeRequest: ChangeRequest };
export const fixFinding = (projectId: string, findingId: string) => api<FixResult>(`/projects/${P(projectId)}/findings/${P(findingId)}/fix`, { method: "POST" });
export const promoteRule = (projectId: string, rule: string, severity: RuleSeverity = "error") => api<unknown>(`/projects/${P(projectId)}/rules/promote`, { method: "POST", json: { rule, severity } });
/** The gardener (D10): an assistant mode that works through findings and only opens change requests. */
export const startGardener = (projectId: string) => api<{ runId?: string; changeRequests?: ChangeRequest[]; opened?: number }>(`/projects/${P(projectId)}/gardener`, { method: "POST" });

export function useFindings(projectId: string) {
  return useQuery({ queryKey: governanceKeys.findings(projectId), queryFn: () => fetchFindings(projectId), enabled: !!projectId, retry: false });
}

export interface RuleGroup {
  rule: string;
  title: string;
  severity: Finding["severity"];
  findings: Finding[];
}

const RANK = { error: 0, warn: 1, info: 2 } as const;

/** Findings grouped by rule, worst severity first, then most findings; titles from the lint catalogue. */
export function groupFindings(findings: Finding[]): RuleGroup[] {
  const by = new Map<string, Finding[]>();
  for (const f of findings) by.set(f.rule, [...(by.get(f.rule) ?? []), f]);
  return [...by.entries()]
    .map(([rule, fs]) => ({
      rule,
      title: lintRule(rule)?.title ?? rule,
      severity: fs.reduce<Finding["severity"]>((w, f) => (RANK[f.severity] < RANK[w] ? f.severity : w), "info"),
      findings: fs,
    }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.findings.length - a.findings.length || a.rule.localeCompare(b.rule));
}

/** "Would have rejected 3 writes" rows: rules with a count above zero, most first. */
export function wouldHaveRejectedRows(counts: Record<string, number>): { rule: string; title: string; count: number }[] {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([rule, count]) => ({ rule, title: lintRule(rule)?.title ?? rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

export const writesLine = (n: number) => `Would have rejected ${n.toLocaleString()} ${n === 1 ? "write" : "writes"}`;

// ---- Rules -------------------------------------------------------------------------------------

export interface RulesDocument {
  rules: Rules;
  revision: number;
  source: "project" | "preset" | "default";
  preset: string | null;
  updatedBy?: string | null;
  updatedAt?: string | null;
}

export interface RulesRevision {
  revision: number;
  actor: string;
  onBehalfOf?: string | null;
  createdAt: string;
}

export const fetchRules = (projectId: string) => api<RulesDocument>(`/projects/${P(projectId)}/rules`);
export const putRules = (projectId: string, rules: Rules, baseRevision: number) => api<RulesDocument>(`/projects/${P(projectId)}/rules`, { method: "PUT", json: { rules, baseRevision } });
export const fetchRulesHistory = (projectId: string) => api<{ history: RulesRevision[] }>(`/projects/${P(projectId)}/rules/history?limit=20`).then((r) => r.history ?? []);

export function useRules(projectId: string) {
  return useQuery({ queryKey: governanceKeys.rules(projectId), queryFn: () => fetchRules(projectId), enabled: !!projectId, retry: false });
}

export function useRulesHistory(projectId: string) {
  return useQuery({ queryKey: governanceKeys.rulesHistory(projectId), queryFn: () => fetchRulesHistory(projectId), enabled: !!projectId, retry: false });
}

/** "Using the chest-xray rules" while the project hasn't customised its own. */
export function rulesSourceLine(doc: Pick<RulesDocument, "source" | "preset"> | undefined): string | null {
  if (!doc || doc.source === "project") return null;
  return doc.source === "preset" && doc.preset ? `Using the ${doc.preset} rules` : "Using the default rules";
}

/** "a, b , c" → ["a", "b", "c"]; empty parts dropped. */
export const splitList = (s: string, sep: RegExp = /[,\n]/) =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

/** A label id from its name: lower-case, dashes, never empty. */
export const labelId = (name: string, taken: string[] = []) => {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "label";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
};

// ---- Connected agents --------------------------------------------------------------------------

export interface ConnectedAgent {
  id: string;
  clientName: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export const fetchConnectedAgents = () => api<{ agents: ConnectedAgent[] }>("/me/connected-agents").then((r) => r.agents ?? []);
export const revokeConnectedAgent = (id: string) => api<void>(`/me/connected-agents/${P(id)}`, { method: "DELETE" });

export function useConnectedAgents() {
  return useQuery({ queryKey: governanceKeys.agents(), queryFn: fetchConnectedAgents, retry: false });
}

export function useRevokeConnectedAgent() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: revokeConnectedAgent, onSettled: () => void qc.invalidateQueries({ queryKey: governanceKeys.agents() }) });
}
