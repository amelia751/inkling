import { create } from "zustand";
import { apiUrl } from "@/extension-host/runtime-config";
import { apiFetch } from "@/extension-host/http";

/**
 * Product feature flags (todo13 §7.1): the api's `API_FEATURE_*` keys, served at
 * `GET /api/v1/features` and read once at start (main.tsx, before the app renders, so the
 * sidebar doesn't change under the person). Each flag gates its UI here and its routes there.
 * Not the extension host's experimental flags (`extension-host/flags.ts`).
 *
 * An error (no api, a 5xx) settles every flag off: the product behaves as before todo13 (§6 J12).
 * A slow answer is not "off" (todo15 D5): `loaded` stays false and what depends on a flag waits
 * (the composer's attach shows a skeleton) until it arrives. The dev seed server answers with
 * every flag on, as dev runs (§7.4).
 */
export interface Features {
  /** Composer drop, paste and attach; the Shared files view. */
  chatDrops: boolean;
  /** Drop plans that only touch the person's drafts apply on their own. */
  autoApply: boolean;
  /** Boot a Studio from a drop before the agent answers. */
  fastPath: boolean;
  /** Datasets in the project sidebar. */
  datasetsTab: boolean;
}

export type Feature = keyof Features;

export const FEATURES_OFF: Features = { chatDrops: false, autoApply: false, fastPath: false, datasetsTab: false };

/** Keep known keys only, booleans only; anything else is off. */
export function parseFeatures(raw: unknown): Features {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { chatDrops: o.chatDrops === true, autoApply: o.autoApply === true, fastPath: o.fastPath === true, datasetsTab: o.datasetsTab === true };
}

interface FeaturesState extends Features {
  /** True once the api answered or failed (false: still waiting; the flags read off meanwhile). */
  loaded: boolean;
}

export const useFeatures = create<FeaturesState>(() => ({ ...FEATURES_OFF, loaded: false }));

/** One flag, reactive: `const tab = useFeature("datasetsTab")`. */
export const useFeature = (f: Feature): boolean => useFeatures((s) => s[f]);

/** Outside React (adapters, stores). */
export const feature = (f: Feature): boolean => useFeatures.getState()[f];

/**
 * Fetch the flags once. Resolves within `timeoutMs` (so the app isn't held up), but only the
 * api's answer (or its failure) sets `loaded`: a late answer applies when it arrives.
 */
export function loadFeatures(timeoutMs = 1500): Promise<void> {
  const req = apiFetch(apiUrl("/v1/features"), { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: unknown) => useFeatures.setState({ ...parseFeatures(body), loaded: true }))
    .catch(() => useFeatures.setState({ ...FEATURES_OFF, loaded: true }));
  return Promise.race([req, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}
