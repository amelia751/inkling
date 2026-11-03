import { useQuery } from "@tanstack/react-query";
import { orgQueries } from "@/studio/lib/org-api";
import { usePrefs, useSetPref } from "@/studio/lib/prefs-api";
import { LEGAL_PATHS } from "@/studio/app/routes/legal";

/**
 * todo15 D2: no consent wall. The first send is the acknowledgement; one line under the Home
 * composer and the empty chat says what the model receives, and the first send stores
 * `ai-notice-seen` in the person's prefs (server-side, fire-and-forget).
 */
/** todo22 D8 key (`aiNoticeSeen` before; still read). */
export const AI_NOTICE_SEEN = "ai-notice-seen";
const AI_NOTICE_SEEN_LEGACY = "aiNoticeSeen";

/** The organization turned the assistant off (`aiAssist`, org settings). Unknown counts as on. */
export function useAiAssistOff(): boolean {
  const org = useQuery({ ...orgQueries.settings(), retry: false });
  return org.data?.aiAssist === false;
}

/** Call on a send: records the acknowledgement once per person. Never blocks or throws. */
export function useAckAiNotice(): () => void {
  const prefs = usePrefs();
  const set = useSetPref();
  return () => {
    if (prefs.data?.[AI_NOTICE_SEEN] === true || prefs.data?.[AI_NOTICE_SEEN_LEGACY] === true) return;
    set.mutate({ key: AI_NOTICE_SEEN, value: true }, { onError: () => undefined });
  };
}

export function AiNotice({ className }: { className?: string }) {
  const off = useAiAssistOff();
  if (off) {
    return (
      <span className={className} data-testid="ai-off-notice">
        The assistant is off for this organization. Dropped files still go to the project's Sources.
      </span>
    );
  }
  return (
    <span className={className} data-testid="ai-notice">
      File contents are encrypted and never go to the assistant; names and file facts (sizes, types, counts) do.{" "}
      <a href={LEGAL_PATHS.privacy} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground" data-testid="ai-notice-privacy">Privacy</a>
      {" · "}
      <a href={LEGAL_PATHS.terms} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Terms</a>
    </span>
  );
}
