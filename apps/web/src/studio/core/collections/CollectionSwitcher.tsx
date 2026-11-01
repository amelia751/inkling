import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { CheckIcon, ChevronDownIcon } from "@studio/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { kernelEnabled } from "@/extension-host/kernel";
import { api, fetchTask } from "@/studio/lib/projects-api";
import { studioUrl } from "@/studio/lib/routes";

/** `GET /v1/projects/:p/datasets/:d/collections` (todo13 D7). */
export interface CollectionSummary {
  id: string;
  datasetId: string;
  name: string;
  kind: string;
  files: number;
  suggested: boolean;
  viewable: boolean;
  taskIds: string[];
}

export const fetchCollections = (projectId: string, datasetId: string) =>
  api<{ datasetId: string; collections: CollectionSummary[] }>(`/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}/collections`);

/**
 * The Studio header's collection switcher (todo13 D7): shown only when the task's dataset has
 * several collections. Each collection's Studio is its own task; picking one opens it, so the
 * current Studio never changes underneath the person. A collection without a Studio yet is
 * listed but not selectable (a drop plan makes one when it adds the collection).
 */
export function CollectionSwitcher({ projectId, taskId }: { projectId: string; taskId: string }) {
  const navigate = useNavigate();
  const kernel = kernelEnabled();
  const task = useQuery({ queryKey: ["tasks", taskId, "summary"], queryFn: () => fetchTask(taskId), enabled: kernel && !!taskId, staleTime: 30_000 });
  const datasetId = task.data?.datasetId;
  const cols = useQuery({ queryKey: ["datasets", datasetId, "collections"], queryFn: () => fetchCollections(projectId, datasetId!), enabled: kernel && !!datasetId, staleTime: 10_000 });
  const list = (cols.data?.collections ?? []).filter((c) => c.viewable || c.taskIds.length);
  if (list.length < 2) return null;
  const mine = task.data?.collectionId ? list.find((c) => c.id === task.data!.collectionId) : list.find((c) => c.taskIds.includes(taskId));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="press flex h-7 min-w-0 items-center gap-1 rounded-lg bg-generic py-1.5 pl-[9px] pr-1.5 text-sm text-foreground hover:bg-generic-hover data-[state=open]:bg-generic-hover"
          aria-label="Collection"
          data-testid="collection-switcher"
        >
          <span className="truncate">{mine?.name ?? "All collections"}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-hint" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>Collections in this dataset</DropdownMenuLabel>
        {list.map((c) => {
          const target = c.taskIds.includes(taskId) ? taskId : c.taskIds[0];
          return (
            <DropdownMenuItem key={c.id} disabled={!target} onSelect={() => target && target !== taskId && navigate(studioUrl(projectId, target))} data-testid="collection-option" data-collection-id={c.id}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{c.name}</span>
                <span className="text-xs text-muted-foreground">
                  {c.files} file{c.files === 1 ? "" : "s"}
                  {target ? "" : " · no Studio yet"}
                </span>
              </span>
              {c.id === mine?.id && <CheckIcon className="size-4 shrink-0" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
