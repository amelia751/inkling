import { BranchIcon, MergeIcon, TagIcon, type IconComponent } from "@studio/ui/icons";
import { NestedPage } from "@/studio/components/layout/app-layout";
import { VersionsPage } from "@/studio/core/versioning";
import type { DatasetViewProps } from "../DatasetLayout";

const STATES: { icon: IconComponent; title: string; body: string }[] = [
  { icon: BranchIcon, title: "Working draft", body: "Your edits. Editable, not published." },
  { icon: MergeIcon, title: "main", body: "The latest approved version. Changes reach it through a review." },
  { icon: TagIcon, title: "Release", body: "A pinned, read-only snapshot for training and audit." },
];

/**
 * History (docs/datasets.md §9): versioning inside the dataset, one view of six. The three states
 * are named first so a draft is never mistaken for a release; the versions page below keeps
 * history, reviews, releases and the Studio setup.
 */
export function DatasetHistory(_: DatasetViewProps) {
  return (
    <div className="flex flex-col gap-5" data-testid="dataset-history">
      <ul className="grid gap-3 sm:grid-cols-3" aria-label="Kinds of version">
        {STATES.map((s) => (
          <li key={s.title} className="flex items-start gap-2.5 rounded-lg bg-generic px-3 py-2.5 text-sm">
            <s.icon className="mt-0.5 size-4 shrink-0 text-hint" />
            <span>
              <span className="block font-medium">{s.title}</span>
              <span className="text-muted-foreground">{s.body}</span>
            </span>
          </li>
        ))}
      </ul>
      <NestedPage>
        <VersionsPage />
      </NestedPage>
    </div>
  );
}
