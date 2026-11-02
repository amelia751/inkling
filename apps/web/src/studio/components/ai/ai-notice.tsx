import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { fetchAgentStatus } from "@/studio/lib/agent/client";
import { orgQueries } from "@/studio/lib/org-api";
import { usePrefs, useSetPref } from "@/studio/lib/prefs-api";

/**
 * todo15 D2: no consent wall. The first send is the acknowledgement; one line under the Home
 * composer and the empty chat says what the model receives, and the first send stores
 * `aiNoticeSeen` in the person's prefs (server-side, fire-and-forget).
 */
export const AI_NOTICE_SEEN = "aiNoticeSeen";

/** The model provider the agent reports, or a neutral name while it's unknown. */
export function useAiProvider(): string {
  const status = useQuery({ queryKey: ["agent-status"], queryFn: fetchAgentStatus, staleTime: 60_000, retry: false });
  return status.data?.provider || "the model provider";
}

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
    if (prefs.data?.[AI_NOTICE_SEEN] === true) return;
    set.mutate({ key: AI_NOTICE_SEEN, value: true }, { onError: () => undefined });
  };
}

export function AiNotice({ className }: { className?: string }) {
  const provider = useAiProvider();
  const off = useAiAssistOff();
  if (off) {
    return (
      <span className={className} data-testid="ai-off-notice">
        The assistant is off for this organization. Dropped files still go to the project's Files.
      </span>
    );
  }
  return (
    <span className={className} data-testid="ai-notice">
      Messages, file names and file facts go to {provider}. File contents never do.{" "}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="underline underline-offset-2 hover:text-foreground" data-testid="ai-notice-details">
            Details
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-80 text-left text-caption" align="start">
          <p className="font-semibold">What the assistant receives</p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 marker:text-hint">
            <li>Your messages</li>
            <li>The project's title, tasks and what needs attention</li>
            <li>File and folder names, kinds, counts and detected technical facts</li>
            <li>The Studio's setup and each annotation's label, shape type and review status</li>
          </ul>
          <p className="mt-2 text-muted-foreground">
            It never receives images, signals, video or any file contents. Files held for privacy review are left out, and a restricted licence shares kinds, counts and statuses only. It can't confirm anything: you approve every suggestion.
          </p>
        </PopoverContent>
      </Popover>
    </span>
  );
}
