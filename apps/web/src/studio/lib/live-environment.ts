import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import { regionLabelNames, type EnvironmentSpec } from "@studio/contracts/environment";
import type { Project } from "@studio/contracts/types";
import { patchSpec, type JsonPatchOperation } from "@/extension-host/patch";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment, type ResolvedEnv } from "@/extension-host/resolve";
import { LOCAL_AUTHOR, useStudio } from "@/studio/stores/studio";
import { fetchEnvironment, type EnvironmentDocument } from "./api";
import { installEnvironment, knownRevision, noteRevision } from "./environment-edits";
import { onProjectEvent } from "./use-project-events";

/**
 * Live environment updates (todo11 Milestone 2 item 7): the project stream's
 * `environment.updated` for the open task applies its JSON Patch to the running environment
 * (only new modules load, inside a transition; nothing remounts). Without a patch (a PUT, a
 * rollback) or after a revision gap the tab refetches. Revisions at or below the one this tab
 * already has (its own writes, replays) are ignored. A refetch of the environment query that
 * brings a newer revision (a missed event, a reconnect) applies the same way.
 */
export interface EnvironmentUpdated {
  taskId: string;
  revision: number;
  author?: string;
  authorKind?: string;
  contentHash?: string;
  parentHash?: string;
  runId?: string;
  patch?: JsonPatchOperation[];
}

const envKey = (taskId: string) => ["environment", taskId] as const;

/**
 * todo18 §2 C: a newer setup arrived that this tab can't run (a plugin it needs was disabled or
 * isn't installed). The Studio keeps working on the old one and shows "reload" (setup-stale-banner).
 */
export const useSetupStale = create<{ stale: { revision: number; reason: string } | null; set: (s: { revision: number; reason: string } | null) => void }>((set) => ({
  stale: null,
  set: (stale) => set({ stale }),
}));

function resolved(spec: EnvironmentSpec | null | undefined, qc: QueryClient, taskId: string, revision?: number): ResolvedEnv | undefined {
  const manifest = qc.getQueryData<Project>(["tasks", taskId, "document"])?.environment;
  const r = resolveEnvironment((spec ?? manifest) as EnvironmentSpec, registry);
  if (!r.env && revision !== undefined) useSetupStale.getState().set({ revision, reason: r.errors?.[0]?.message ?? "a module it needs isn't available" });
  return r.env;
}

/**
 * todo18 §2 C: the label being drawn with was removed (or renamed) by a setup change. Keep it
 * when it's still there; otherwise fall back to the first region label (or none) and say so.
 */
export function labelAfterSetupChange(active: string | null, labels: string[]): { active: string | null; removed: string | null } {
  if (active == null || labels.includes(active)) return { active, removed: null };
  return { active: labels[0] ?? null, removed: active };
}

/** "Setup updated by <who>" (todo18 P2), and the label notice when the active label went away. */
function announce(doc: Partial<EnvironmentDocument>, removed: string | null, next: string | null) {
  const who = doc.authorKind === "agent" ? "the assistant" : doc.author && doc.author !== LOCAL_AUTHOR ? doc.author : null;
  const lines = [who ? `Setup updated by ${who}` : "Setup updated"];
  if (removed) lines.push(next ? `Label "${removed}" was removed; now drawing with "${next}".` : `Label "${removed}" was removed.`);
  toast(lines[0], { description: lines[1], id: "setup-updated" });
}

async function install(qc: QueryClient, taskId: string, env: ResolvedEnv, doc: Partial<EnvironmentDocument> & { revision: number }) {
  if (useStudio.getState().projectId !== taskId) return;
  await installEnvironment(env, { record: false });
  noteRevision(taskId, doc.revision);
  useSetupStale.getState().set(null);
  const label = labelAfterSetupChange(useStudio.getState().activeLabel, regionLabelNames(env.labels));
  if (label.removed) useStudio.setState({ activeLabel: label.active });
  announce(doc, label.removed, label.active);
  qc.setQueryData<EnvironmentDocument | null>(envKey(taskId), (old) => ({ ...(old ?? {}), ...doc, environment: env.source }) as EnvironmentDocument);
}

/** Apply one event (exported for tests). Resolves once the environment is swapped in, or skipped. */
export async function applyEnvironmentUpdate(qc: QueryClient, taskId: string, e: EnvironmentUpdated): Promise<"patched" | "refetched" | "ignored"> {
  if (e.taskId !== taskId || useStudio.getState().projectId !== taskId) return "ignored";
  const current = knownRevision(taskId) ?? qc.getQueryData<EnvironmentDocument | null>(envKey(taskId))?.revision ?? 0;
  if (e.revision <= current) return "ignored";
  const running = useStudio.getState().env;
  if (e.patch && e.revision === current + 1 && running) {
    const p = patchSpec(running.source, e.patch);
    const env = p.errors ? undefined : resolveEnvironment(p.spec, registry).env;
    if (env) {
      await install(qc, taskId, env, { revision: e.revision, author: e.author, contentHash: e.contentHash });
      return "patched";
    }
  }
  const fresh = await fetchEnvironment(taskId);
  if (fresh.revision <= (knownRevision(taskId) ?? current)) return "ignored";
  const env = resolved(fresh.environment, qc, taskId, fresh.revision);
  if (!env) return "ignored";
  await install(qc, taskId, env, fresh);
  return "refetched";
}

export function useLiveEnvironment(taskId: string, safe: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (safe) return;
    // The environment the Studio opened on is the baseline.
    const doc = qc.getQueryData<EnvironmentDocument | null>(envKey(taskId));
    if (doc) noteRevision(taskId, doc.revision);
    let chain = Promise.resolve();
    const run = (fn: () => Promise<unknown>) => {
      chain = chain.then(fn).then(
        () => undefined,
        () => undefined,
      );
    };
    const off = onProjectEvent("environment.updated", (data) => {
      const e = data as EnvironmentUpdated | null;
      if (e?.taskId === taskId && typeof e.revision === "number") run(() => applyEnvironmentUpdate(qc, taskId, e));
    });
    // A refetch (focus, reconnect) that brings a newer revision than the one running.
    const unsub = qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== "updated" || ev.action.type !== "success") return;
      const key = ev.query.queryKey;
      if (key[0] !== "environment" || key[1] !== taskId) return;
      const d = ev.query.state.data as EnvironmentDocument | null | undefined;
      if (!d || d.revision <= (knownRevision(taskId) ?? 0)) return;
      run(async () => {
        if (d.revision <= (knownRevision(taskId) ?? 0)) return;
        const env = resolved(d.environment, qc, taskId, d.revision);
        if (env) await install(qc, taskId, env, d);
      });
    });
    return () => {
      off();
      unsub();
    };
  }, [qc, taskId, safe]);
}
