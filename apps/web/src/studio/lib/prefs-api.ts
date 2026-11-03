import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/studio/lib/projects-api";

/**
 * Per-person preferences (todo14 §5.2 `user_prefs`): `GET /v1/me/prefs` → `{prefs}`,
 * `PUT /v1/me/prefs/{key}` `{value}`. Server-side, not localStorage, so a second browser
 * doesn't repeat what the person already dismissed (D8).
 */
export type Prefs = Record<string, unknown>;

const KEY = ["me", "prefs"] as const;

export const fetchPrefs = () => api<{ prefs?: Prefs }>("/me/prefs").then((r) => r.prefs ?? {});
export const putPref = (key: string, value: unknown) => api<unknown>(`/me/prefs/${encodeURIComponent(key)}`, { method: "PUT", json: { value } });

/** The person's prefs; `undefined` while loading or when the api has none to give (then nothing first-run shows). */
export function usePrefs() {
  return useQuery({ queryKey: KEY, queryFn: fetchPrefs, staleTime: 5 * 60_000, retry: false });
}

export function useSetPref() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => putPref(key, value),
    onMutate: ({ key, value }) => qc.setQueryData<Prefs>(KEY, (p) => ({ ...(p ?? {}), [key]: value })),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** todo22 D8 key (`firstRunHintsDismissed` before; still read so a dismissal isn't asked again). */
export const FIRST_RUN_HINTS = "first-run-hints-dismissed";
const FIRST_RUN_HINTS_LEGACY = "firstRunHintsDismissed";

/**
 * D8: the drawer's empty conversation shows the three todo13 prompts until the person dismisses
 * them, once per person. Shown only when the prefs loaded and say not dismissed: an api without
 * prefs (or an error) shows nothing rather than nagging.
 */
export function useFirstRunHints(): { show: boolean; dismiss: () => void } {
  const prefs = usePrefs();
  const set = useSetPref();
  return {
    show: prefs.isSuccess && prefs.data[FIRST_RUN_HINTS] !== true && prefs.data[FIRST_RUN_HINTS_LEGACY] !== true,
    dismiss: () => set.mutate({ key: FIRST_RUN_HINTS, value: true }),
  };
}
