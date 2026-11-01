import { create } from "zustand";
import { apiUrl } from "@/extension-host/runtime-config";

/**
 * Product feature flags (todo13 §7.1): the api's `API_FEATURE_*` keys, served at
 * `GET /api/v1/features` and read once at start (main.tsx, before the app renders, so the
 * sidebar doesn't change under the person). Each flag gates its UI here and its routes there.
 * Not the extension host's experimental flags (`extension-host/flags.ts`).
 *
 * Without an answer (no api, an error, a slow start) every flag is off: the product behaves as
 * before todo13 (§6 J12). The dev seed server answers with every flag on, as dev runs (§7.4).
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
  /** True once the api answered (false: the defaults, all off). */
  loaded: boolean;
}

export const useFeatures = create<FeaturesState>(() => ({ ...FEATURES_OFF, loaded: false }));

/** One flag, reactive: `const tab = useFeature("datasetsTab")`. */
export const useFeature = (f: Feature): boolean => useFeatures((s) => s[f]);

/** Outside React (adapters, stores). */
export const feature = (f: Feature): boolean => useFeatures.getState()[f];

/**
 * Fetch the flags once. Resolves within `timeoutMs` whatever happens; a late answer still
 * applies when it arrives.
 */
export function loadFeatures(timeoutMs = 1500): Promise<void> {
  const req = fetch(apiUrl("/v1/features"), { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((body: unknown) => useFeatures.setState({ ...parseFeatures(body), loaded: true }))
    .catch(() => undefined);
  return Promise.race([req, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}
