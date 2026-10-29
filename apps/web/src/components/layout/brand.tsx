import { Link } from "react-router";
import { BrandIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <Link to="/" className={cn("flex shrink-0 items-center gap-2 rounded-md", className)} aria-label="Inkling workspace">
      <span className="press flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <BrandIcon className="size-4" />
      </span>
      {!compact && <span className="text-body-2 font-semibold">Inkling</span>}
    </Link>
  );
}
