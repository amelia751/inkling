import { useCallback, useSyncExternalStore } from "react";
import { RES } from "@studio/contracts/naming";
import { onForgetClient, onPersonChange, personKey } from "@/studio/lib/person-key";
import { fetchPrefs, putPref } from "@/studio/lib/prefs-api";

/**
 * Per-person preferences on the server (todo22 D3, D4, D8), over `/v1/me/prefs`.
 *
 * - The server is the source of truth. localStorage is a write-through cache so the first paint
 *   doesn't wait for it: a read gives the cached value, then the server's once it has loaded.
 * - Writes go to memory and the cache at once, and to the server debounced (500 ms) per key,
 *   last writer wins.
 * - When the server has no value for a key but this browser's cache does, the cached value is
 *   uploaded, so what people kept in localStorage before todo22 moves to the server.
 * - A value over 64 KB of JSON is refused (kept local, with a warning); keys match
 *   `^[a-z][a-z0-9:._-]{0,127}$` (the api enforces both).
 * - Without an api (the seed server's stand-in has prefs; a failed load means none), it works
 *   from the cache alone.
 * - Sign-out (`forgetClient`) clears the person's cache; a person change reloads from the server.
 *
 * Use `usePersonPref` in components and `personPrefs` from zustand stores
 * (`personPrefs.subscribe` to re-read when the server's values arrive).
 */

export const PREF_KEY = /^[a-z][a-z0-9:._-]{0,127}$/;
export const MAX_PREF_BYTES = 64 * 1024;
export const PREF_DEBOUNCE_MS = 500;

export interface PrefOptions {
  /** The localStorage key (already per person; pass `personKey(…)` lazily). Default `personKey(`${RES}-pref-<key>`)`. */
  cache?: string | (() => string);
  /** The cached value is a bare string rather than JSON (the theme, an items view). */
  raw?: boolean;
}

type Status = "idle" | "loading" | "ready" | "unavailable";

const specs = new Map<string, PrefOptions>();
const memory = new Map<string, unknown>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: unknown }>();
const listeners = new Set<() => void>();
let server: Record<string, unknown> | null = null;
let status: Status = "idle";
let generation = 0;

/** Map any id into a key segment D8 accepts (lowercase; other characters become `-`). */
export function prefSegment(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

function cacheKey(key: string): string {
  const c = specs.get(key)?.cache;
  return typeof c === "function" ? c() : (c ?? personKey(`${RES}-pref-${key}`));
}

function readCache(key: string): unknown {
  try {
    const raw = localStorage.getItem(cacheKey(key));
    if (raw == null) return undefined;
    return specs.get(key)?.raw ? raw : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) localStorage.removeItem(cacheKey(key));
    else localStorage.setItem(cacheKey(key), specs.get(key)?.raw && typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* storage blocked or full: memory still has it */
  }
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn("[person-prefs] listener failed", e);
    }
  }
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

function upload(key: string, value: unknown): void {
  if (status === "unavailable") return;
  if (!PREF_KEY.test(key)) {
    console.warn(`[person-prefs] "${key}" isn't a valid preference key; kept in this browser only`);
    return;
  }
  if (byteSize(value) > MAX_PREF_BYTES) {
    console.warn(`[person-prefs] "${key}" is over ${MAX_PREF_BYTES} bytes; kept in this browser only`);
    return;
  }
  const gen = generation;
  void putPref(key, value).then(
    () => {
      if (gen === generation && server) server[key] = value;
    },
    (e: unknown) => console.warn(`[person-prefs] couldn't save "${key}"`, e),
  );
}

function schedule(key: string, value: unknown): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    pending.delete(key);
    upload(key, value);
  }, PREF_DEBOUNCE_MS);
  pending.set(key, { timer, value });
}

function cancelPending(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}

function load(): Promise<void> {
  const gen = ++generation;
  status = "loading";
  return fetchPrefs().then(
    (prefs) => {
      if (gen !== generation) return;
      server = { ...prefs };
      status = "ready";
      for (const [k, v] of Object.entries(prefs)) {
        if (pending.has(k)) continue; // a local write is on its way: it wins
        memory.set(k, v);
        if (specs.has(k)) writeCache(k, v);
      }
      for (const k of specs.keys()) adopt(k);
      notify();
    },
    () => {
      if (gen !== generation) return;
      status = "unavailable";
    },
  );
}

/** After the server loaded: a known key the server lacks uploads this browser's cached value. */
function adopt(key: string): void {
  if (!server || key in server || pending.has(key)) return;
  const cached = memory.has(key) ? memory.get(key) : readCache(key);
  if (cached !== undefined) schedule(key, cached);
}

function register(key: string, opts?: PrefOptions): void {
  if (!specs.has(key)) {
    specs.set(key, opts ?? {});
    if (status === "ready" && server) {
      if (key in server) writeCache(key, server[key]);
      else adopt(key);
    }
  }
  if (status === "idle") void load();
}

function get<T>(key: string, fallback: T, opts?: PrefOptions): T {
  register(key, opts);
  if (!memory.has(key)) {
    const v = readCache(key);
    if (v === undefined) return fallback;
    memory.set(key, v);
  }
  return (memory.get(key) as T) ?? fallback;
}

function set(key: string, value: unknown, opts?: PrefOptions): void {
  register(key, opts);
  if (Object.is(memory.get(key), value)) return;
  memory.set(key, value);
  writeCache(key, value);
  notify();
  schedule(key, value);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function reset(): void {
  generation++;
  cancelPending();
  memory.clear();
  server = null;
  status = "idle";
}

/**
 * Sign-out (D4): forget the person's cached preferences in this browser. `forgetClient` calls
 * it; the next read loads them from the server again.
 */
export function clearPersonPrefsCache(): void {
  for (const k of specs.keys()) {
    try {
      localStorage.removeItem(cacheKey(k));
    } catch {
      /* storage blocked */
    }
  }
  reset();
  notify();
}

export const personPrefs = {
  get,
  set,
  subscribe,
  /** Load (or reload) from the server; resolves once loaded or known unavailable. */
  refresh: () => {
    reset();
    return load().then(notify);
  },
  /** Send debounced writes now (tests, page hide). */
  flush: () => {
    const all = [...pending.entries()];
    cancelPending();
    for (const [k, p] of all) upload(k, p.value);
  },
  status: () => status,
};

/** A per-person preference in a component: `[value, setValue]`. */
export function usePersonPref<T>(key: string, fallback: T, opts?: PrefOptions): [T, (value: T) => void] {
  const snap = useSyncExternalStore(
    subscribe,
    () => get<T | undefined>(key, undefined, opts),
    () => undefined,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- options are fixed per key
  const setValue = useCallback((value: T) => set(key, value, opts), [key]);
  return [snap ?? fallback, setValue];
}

// Another person (or organization): their own preferences, from their cache then the server.
onPersonChange(() => {
  reset();
  notify();
  void load();
});
onForgetClient(clearPersonPrefsCache);

if (typeof window !== "undefined") window.addEventListener("pagehide", () => personPrefs.flush());
