import type { QueryClient } from "@tanstack/react-query";
import type { StateStorage } from "zustand/middleware";
import { RES } from "@studio/contracts/naming";
import { runtimeConfig } from "@/extension-host/runtime-config";
import { devPrincipal } from "@/studio/lib/dev-principal";
import { clearKernelTokens } from "@/studio/lib/agent/kernel-token";

/**
 * Per-person browser state (todo15 D1). Everything the Studio keeps in localStorage or
 * sessionStorage under a `${RES}-…` key is scoped to the person (and, with WorkOS sign-in, the
 * organization) it belongs to, so a second person on the same browser, or the same person in
 * another organization, starts clean. `forgetClient()` drops what the client holds for the
 * person on sign-out and before an organization switch.
 *
 * - `workos` mode: `<base>:<user id>:<org id>` from the signed-in session (`setPersonSession`,
 *   called by session.ts whenever it loads one); `<base>:signed-out` before it has loaded.
 * - dev mode: unchanged for the default principal (existing local state stays), suffixed with the
 *   dev principal after "Start as a new person" (todo14 M0).
 */

interface PersonIds {
  userId: string;
  orgId: string;
}

let current: PersonIds | null = null;
const listeners = new Set<() => void>();

const workos = () => runtimeConfig().auth?.mode === "workos";

/** The suffix `personKey` adds (empty for the default dev principal). */
export function personSuffix(): string {
  if (workos()) return current ? `:${current.userId}:${current.orgId}` : ":signed-out";
  const p = devPrincipal();
  return p ? `:${p}` : "";
}

/** A per-person storage key for `base` (a `${RES}-…` key). Compute it at use, never at module load. */
export function personKey(base: string): string {
  return `${base}${personSuffix()}`;
}

/** Called by session.ts with each session it loads (and with null once signed out). */
export function setPersonSession(session: { user?: { id?: string }; organization?: { id?: string } } | null): void {
  const userId = session?.user?.id;
  const next = userId ? { userId, orgId: session?.organization?.id ?? "" } : null;
  if (next?.userId === current?.userId && next?.orgId === current?.orgId) return;
  const before = personSuffix();
  current = next;
  if (personSuffix() === before) return;
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.warn("[person-key] listener failed", e);
    }
  }
}

/** Run `fn` whenever the person (or their organization) changes, so stores re-read their keys. */
export function onPersonChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** A zustand `persist` storage whose item names are `personKey(name)`, read at each access. */
export function personStorage(storage: () => Storage): StateStorage {
  const safe = <T>(f: (s: Storage) => T, fallback: T): T => {
    try {
      return f(storage());
    } catch {
      return fallback;
    }
  };
  return {
    getItem: (name) => safe((s) => s.getItem(personKey(name)), null),
    setItem: (name, value) => safe((s) => s.setItem(personKey(name), value), undefined),
    removeItem: (name) => safe((s) => s.removeItem(personKey(name)), undefined),
  };
}

interface PersistedStore {
  getInitialState: () => unknown;
  setState: (s: never, replace: true) => void;
  persist: { rehydrate: () => Promise<void> | void; getOptions: () => { name?: string } };
}

/**
 * Keep a persisted store on the current person: when the person changes, load their stored state,
 * or start from the initial state when they have none (rehydrating alone would keep the last
 * person's state in memory).
 */
export function followPerson(store: PersistedStore, storage: () => Storage): void {
  onPersonChange(() => {
    const name = store.persist.getOptions().name;
    let stored: string | null = null;
    try {
      stored = name ? storage().getItem(personKey(name)) : null;
    } catch {
      /* storage blocked */
    }
    if (stored == null) store.setState(store.getInitialState() as never, true);
    else void store.persist.rehydrate();
  });
}

/** Whether `key` is one of ours (`${RES}-…`) and belongs to the current person. */
function ownedKey(key: string, suffix: string): boolean {
  if (!key.startsWith(`${RES}-`) || key === `${RES}-dev-principal`) return false;
  if (suffix) return key.endsWith(suffix);
  // The default dev principal's keys carry no suffix: keep other people's (`…:user:…`).
  return !key.includes(":user:") && !key.endsWith(":signed-out");
}

function clearStorage(storage: () => Storage, suffix: string): void {
  try {
    const s = storage();
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && ownedKey(k, suffix)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    /* storage blocked: nothing to forget */
  }
}

/**
 * Forget what this browser holds for the current person: every cached query, the agent's kernel
 * tokens and status, and their `${RES}-…` local and session storage. Call it on sign-out and before
 * an organization switch navigates away.
 */
export function forgetClient(client?: QueryClient): void {
  const suffix = personSuffix();
  client?.removeQueries({ queryKey: ["agent-status"] });
  // Everything but the session itself: SessionGate keeps rendering until the page navigates away.
  client?.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  client?.getMutationCache().clear();
  clearKernelTokens();
  clearStorage(() => localStorage, suffix);
  clearStorage(() => sessionStorage, suffix);
}
