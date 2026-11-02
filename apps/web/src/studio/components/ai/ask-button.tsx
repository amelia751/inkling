import { AiIcon } from "@studio/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import { NAMING } from "@studio/contracts/naming";
import type { ReactNode } from "react";

/**
 * The assistant's toggle (Nebius "Ask Echo"): a 32px pill with a faint lilac → mint wash and a
 * star that catches the light now and then. The label folds away when there's no room.
 */
export function AskButton({ open, onToggle, labelClassName, tooltip, testId }: { open: boolean; onToggle: () => void; labelClassName?: string; tooltip?: ReactNode; testId?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={open}
          aria-label={`${NAMING.displayName} AI panel`}
          data-testid={testId}
          className={cn(
            "echo-pill press inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border px-3 text-complementary hover:border-border-hover hover:text-foreground",
            open && "border-border-hover text-foreground",
          )}
        >
          <span className="echo-glint inline-flex size-4 shrink-0 items-center justify-center">
            <AiIcon className="size-4 text-ai-text" />
          </span>
          <span className={labelClassName}>Assistant</span>
        </button>
      </TooltipTrigger>
      {tooltip ?? <TooltipContent>{open ? "Close Assistant" : "Launch Assistant"}</TooltipContent>}
    </Tooltip>
  );
}
