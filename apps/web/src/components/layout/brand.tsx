import { Link } from "react-router";
import { Droplet } from "lucide-react";

export function BrandMark() {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label="Inkling workspace">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95">
        <Droplet className="h-4 w-4" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">Inkling</span>
    </Link>
  );
}
