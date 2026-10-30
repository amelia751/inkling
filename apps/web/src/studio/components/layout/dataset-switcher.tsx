import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { CheckIcon, ChevronDownIcon, DatasetsIcon } from "@studio/studio-ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@studio/studio-ui/ui/dropdown-menu";
import { fetchProjects } from "@/studio/lib/api";
import { projectIcon } from "@/studio/lib/format";
import { cn } from "@studio/studio-ui/utils";

/**
 * Header context selector (the Nebius project selector): names the open
 * dataset and switches to another one on the same page (Studio, Review or
 * Export).
 */
export function DatasetSwitcher({ datasetId, title, className }: { datasetId: string; title: string; className?: string }) {
  const { data: projects } = useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: Infinity });
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const page = pathname.match(/^\/datasets\/[^/]+(\/.*)?$/)?.[1] ?? "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "press flex h-7 min-w-0 max-w-[280px] items-center gap-1 rounded-lg bg-generic py-1.5 pl-[9px] pr-1.5 text-sm text-foreground hover:bg-generic-hover data-[state=open]:bg-generic-hover [outline-offset:-2px]",
          className,
        )}
        aria-label={`Dataset: ${title}. Switch dataset`}
      >
        <span className="truncate">{title}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        <DropdownMenuLabel className="font-normal text-hint">Datasets</DropdownMenuLabel>
        {projects?.map((p) => {
          const Icon = projectIcon(p);
          const current = p.id === datasetId;
          return (
            <DropdownMenuItem key={p.id} onSelect={() => !current && navigate(`/datasets/${p.id}${page}`)}>
              <Icon className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              {current && <CheckIcon className="text-brand-heavy" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/">
            <DatasetsIcon className="text-muted-foreground" /> All datasets
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
