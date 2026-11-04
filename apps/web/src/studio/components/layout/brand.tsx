import { Link } from "react-router";
import { BrandLogo } from "@studio/ui/icons";
import { cn } from "@studio/ui/utils";
import { NAMING } from "@studio/contracts/naming";

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <Link to="/" className={cn("flex shrink-0 items-center gap-2 rounded-md", className)} aria-label={`${NAMING.displayName} workspace`}>
      <BrandLogo className="press size-7 shrink-0" />
      {!compact && <span className="text-body-2 font-semibold">{NAMING.displayName}</span>}
    </Link>
  );
}
