import type { Daytona, Sandbox } from "@daytona/sdk";
import { APP_LABEL } from "./defaults.ts";

export interface SweepCandidate {
  id: string;
  name: string;
  state: string | undefined;
  labels: Record<string, string>;
  createdAt?: string;
  lastActivityAt?: string;
}

export interface SweepPolicy {
  env: string;
  now: number;
  /** Sessions with a run in flight: never touched. */
  activeSessions: ReadonlySet<string>;
  /** Sessions the service still knows about; others are orphans. `undefined` skips orphan deletion. */
  knownSessions?: ReadonlySet<string>;
  idleStopMin: number;
  retentionDays: number;
  maxDeletes: number;
}

export interface SweepPlan {
  stop: SweepCandidate[];
  delete: { sandbox: SweepCandidate; reason: "orphan" | "retention" }[];
}

const MIN = 60_000;
const ts = (s?: string) => (s ? Date.parse(s) : NaN);
const lastSeen = (c: SweepCandidate) => {
  const t = ts(c.lastActivityAt);
  return Number.isFinite(t) ? t : ts(c.createdAt);
};

/** Only `app=<resourcePrefix>` sandboxes in this env are ever considered, even if the list call returned more. */
export function ownedBy(c: SweepCandidate, env: string): boolean {
  return c.labels.app === APP_LABEL && c.labels.env === env;
}

export function planSweep(candidates: SweepCandidate[], p: SweepPolicy): SweepPlan {
  const plan: SweepPlan = { stop: [], delete: [] };
  const mine = candidates.filter((c) => ownedBy(c, p.env) && !p.activeSessions.has(c.labels.session ?? ""));
  const oldestFirst = [...mine].sort((a, b) => (lastSeen(a) || 0) - (lastSeen(b) || 0));

  for (const c of oldestFirst) {
    if (plan.delete.length >= p.maxDeletes) break;
    const created = ts(c.createdAt);
    const session = c.labels.session ?? "";
    if (p.knownSessions && !p.knownSessions.has(session)) plan.delete.push({ sandbox: c, reason: "orphan" });
    else if (Number.isFinite(created) && p.now - created > p.retentionDays * 24 * 60 * MIN) plan.delete.push({ sandbox: c, reason: "retention" });
  }
  const deleting = new Set(plan.delete.map((d) => d.sandbox.id));
  for (const c of oldestFirst) {
    if (deleting.has(c.id) || c.state !== "started") continue;
    const seen = lastSeen(c);
    if (Number.isFinite(seen) && p.now - seen > p.idleStopMin * MIN) plan.stop.push(c);
  }
  return plan;
}

/** Quota pressure: stop the oldest idle started sandboxes first. Never deletes. */
export function planReclaim(candidates: SweepCandidate[], p: Pick<SweepPolicy, "env" | "activeSessions">, max = 5): SweepCandidate[] {
  return candidates
    .filter((c) => ownedBy(c, p.env) && c.state === "started" && !p.activeSessions.has(c.labels.session ?? ""))
    .sort((a, b) => (lastSeen(a) || 0) - (lastSeen(b) || 0))
    .slice(0, max);
}

export function toCandidate(s: Sandbox): SweepCandidate {
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    labels: s.labels ?? {},
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
  };
}

export async function listOwned(daytona: Daytona, env: string, extraLabels: Record<string, string> = {}): Promise<Sandbox[]> {
  const out: Sandbox[] = [];
  for await (const s of daytona.list({ labels: { app: APP_LABEL, env, ...extraLabels } })) out.push(s);
  return out;
}

export interface SweepResult {
  plan: SweepPlan;
  stopped: string[];
  deleted: string[];
  errors: { id: string; message: string }[];
}

export async function runSweep(
  daytona: Daytona,
  policy: Omit<SweepPolicy, "now"> & { now?: number },
  opts: { dryRun?: boolean; log?: (msg: string) => void } = {},
): Promise<SweepResult> {
  const sandboxes = await listOwned(daytona, policy.env);
  const byId = new Map(sandboxes.map((s) => [s.id, s]));
  const plan = planSweep(sandboxes.map(toCandidate), { ...policy, now: policy.now ?? Date.now() });
  const result: SweepResult = { plan, stopped: [], deleted: [], errors: [] };
  if (opts.dryRun) return result;
  for (const c of plan.stop) {
    try {
      await byId.get(c.id)!.stop(60);
      result.stopped.push(c.id);
      opts.log?.(`stopped ${c.name} (idle)`);
    } catch (err) {
      result.errors.push({ id: c.id, message: (err as Error).message });
    }
  }
  for (const { sandbox: c, reason } of plan.delete) {
    try {
      await byId.get(c.id)!.delete(60);
      result.deleted.push(c.id);
      opts.log?.(`deleted ${c.name} (${reason}) labels=${JSON.stringify(c.labels)}`);
    } catch (err) {
      result.errors.push({ id: c.id, message: (err as Error).message });
    }
  }
  return result;
}

export async function reclaimForQuota(daytona: Daytona, env: string, activeSessions: ReadonlySet<string>, log?: (msg: string) => void): Promise<string[]> {
  const sandboxes = await listOwned(daytona, env);
  const byId = new Map(sandboxes.map((s) => [s.id, s]));
  const stopped: string[] = [];
  for (const c of planReclaim(sandboxes.map(toCandidate), { env, activeSessions })) {
    await byId.get(c.id)!.stop(60).then(
      () => {
        stopped.push(c.id);
        log?.(`reclaim: stopped ${c.name}`);
      },
      () => {},
    );
  }
  return stopped;
}
