import type { Ref } from "react";
import { CloseIcon, CollapseAllIcon, NewFolderIcon, SearchIcon, SortIcon, UploadIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { ReasonButton } from "./shared";

/**
 * The tree header (todo7 §2, kiwifs `AppSidebar` "Pages" header): a 32px row with the "Files"
 * label and icon buttons (New folder, Upload, Collapse all, Sort ▾), then a filter field that
 * narrows the *loaded* tree as you type ("Filter folders shown"; the toolbar's search is the one
 * for files not loaded yet). Esc in the field clears it. The sort is applied server-side by the
 * caller; folders always come first.
 */

export type TreeSortKey = "name" | "kind" | "size" | "added";

export const TREE_SORT_LABEL: Record<TreeSortKey, string> = { name: "Name", kind: "Kind", size: "Size", added: "Date added" };

export interface TreeHeaderProps {
  /** Default "Files". */
  label?: string;
  sort: TreeSortKey;
  onSort: (key: TreeSortKey) => void;
  filter: string;
  onFilter: (value: string) => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
  onCollapseAll?: () => void;
  /** Reasons that make New folder / Upload inert (e.g. "Needs the full stack", locked folder). */
  disabled?: { newFolder?: string | null; upload?: string | null };
  /** To focus the filter from a command. */
  filterRef?: Ref<HTMLInputElement>;
}

export function TreeHeader({ label = "Files", sort, onSort, filter, onFilter, onNewFolder, onUpload, onCollapseAll, disabled = {}, filterRef }: TreeHeaderProps) {
  return (
    <div className="shrink-0 px-2 pt-1" data-testid="tree-header">
      <div className="flex h-8 items-center gap-0.5">
        <h2 className="min-w-0 flex-1 truncate px-2 text-xs font-semibold uppercase tracking-wide text-hint">{label}</h2>
        {onNewFolder && (
          <ReasonButton variant="ghost-secondary" size="icon-sm" reason={disabled.newFolder} tip="New folder" aria-label="New folder" onClick={onNewFolder} data-testid="tree-new-folder">
            <NewFolderIcon />
          </ReasonButton>
        )}
        {onUpload && (
          <ReasonButton variant="ghost-secondary" size="icon-sm" reason={disabled.upload} tip="Upload" aria-label="Upload" onClick={onUpload} data-testid="tree-upload">
            <UploadIcon />
          </ReasonButton>
        )}
        {onCollapseAll && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" size="icon-sm" aria-label="Collapse all folders" onClick={onCollapseAll} data-testid="tree-collapse-all">
                <CollapseAllIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Collapse all folders</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost-secondary" size="icon-sm" aria-label={`Sort by ${TREE_SORT_LABEL[sort]}`} data-testid="tree-sort" data-sort={sort}>
                  <SortIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Sort: {TREE_SORT_LABEL[sort]}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-hint">Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSort(v as TreeSortKey)}>
              {(Object.keys(TREE_SORT_LABEL) as TreeSortKey[]).map((k) => (
                <DropdownMenuRadioItem key={k} value={k} data-testid={`tree-sort-${k}`}>
                  {TREE_SORT_LABEL[k]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-xs text-hint">Folders always come first.</p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative pb-1">
        <SearchIcon className="pointer-events-none absolute left-2 top-3 size-3.5 -translate-y-1/2 text-hint" aria-hidden />
        <Input
          ref={filterRef}
          value={filter}
          inputSize="sm"
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.preventDefault();
              e.stopPropagation();
              onFilter("");
            }
          }}
          placeholder="Filter folders shown"
          aria-label="Filter folders shown"
          className="pl-7 pr-7"
          data-testid="tree-filter"
        />
        {filter && (
          <Button variant="ghost-secondary" size="icon-xs" className="absolute right-0.5 top-0.5" aria-label="Clear filter" onClick={() => onFilter("")} data-testid="tree-filter-clear">
            <CloseIcon />
          </Button>
        )}
      </div>
    </div>
  );
}
