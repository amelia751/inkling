import { useEffect, useState } from "react";
import { CopyIcon, DoneIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";

/** Copies `text`; the icon turns into a check for a moment. */
export function CopyButton({ text, label = "Copy", size = "icon-xs", className }: { text: string; label?: string; size?: "icon-xs" | "icon-sm"; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost-secondary"
          size={size}
          className={cn("rounded-full", className)}
          aria-label={copied ? "Copied" : label}
          onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
        >
          {copied ? <DoneIcon /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}
