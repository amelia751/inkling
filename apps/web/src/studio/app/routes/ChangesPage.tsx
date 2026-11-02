import { useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, MergeIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Textarea } from "@studio/ui/ui/textarea";
import { ErrorView } from "@/studio/app/routes/errors";
import { relativeTime } from "@/studio/components/files";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { canEditTaskSetup } from "@/studio/lib/task-setup";
import { changesUrl } from "@/studio/lib/routes";
import { parseProblem, problemText } from "@/studio/lib/problem";
import {
  authorLine,
  CHANGE_STATE_LABEL,
  CHANGE_STATE_THEME,
  diffValue,
  isOpenChange,
  useChange,
  useChangeActions,
  useChanges,
  type ChangeDetail,
  type ChangeRequest,
  type Finding,
} from "@/studio/lib/governance-api";

const FILTERS: { value: "open" | "all"; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "all", label: "All" },
];

export const CHANGES_EMPTY = "No change requests.";

const SEVERITY_THEME = { error: "danger", warn: "warning", info: "info" } as const;
const SEVERITY_LABEL = { error: "Error", warn: "Warning", info: "Info" } as const;

/**
 * Changes (todo17 M2, D7): change requests from agents and people. Agents never merge;
 * owners and editors review, Merge or Close. `:changeId` opens one with its diff, findings
 * and comments.
 */
export function ChangesPage() {
  const { projectId = "", changeId } = useParams();
  return <AppLayout>{changeId ? <ChangeView projectId={projectId} changeId={changeId} /> : <ChangeList projectId={projectId} />}</AppLayout>;
}

function ChangeList({ projectId }: { projectId: string }) {
  const [state, setState] = useState<"open" | "all">("open");
  const changes = useChanges(projectId, state);
  const rows = changes.data ?? [];
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="changes-page">
      <PageHeading title="Changes" description="Changes that wait for review before they apply. Agents open them; people merge them." />
      <SegmentedControl
        value={state}
        onValueChange={setState}
        size="md"
        options={FILTERS}
        aria-label="Show"
      />
      <div className="mt-4">
        {changes.error ? (
          <ErrorView variant="section" error={changes.error} what="change requests" onRetry={() => void changes.refetch()} />
        ) : changes.isLoading ? (
          <div className="space-y-2" aria-busy>
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState art="review" title={CHANGES_EMPTY} description="When an agent changes something published, its change waits here for you." data-testid="changes-empty" />
        ) : (
          <Card className="divide-y divide-border overflow-hidden" role="list">
            {rows.map((c) => <ChangeRow key={c.id} projectId={projectId} change={c} />)}
          </Card>
        )}
      </div>
    </div>
  );
}

function ChangeRow({ projectId, change: c }: { projectId: string; change: ChangeRequest }) {
  return (
    <Link
      role="listitem"
      to={changesUrl(projectId, c.id)}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-generic"
      data-testid="change-row"
      data-change-id={c.id}
      data-state={c.state}
    >
      <MergeIcon className="size-4 shrink-0 text-hint" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={c.title}>{c.title}</span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span className="truncate" data-testid="change-author">{authorLine(c)}</span>
          {c.agent && <Badge theme="ai" size="xs" data-testid="change-agent">Agent</Badge>}
        </span>
      </span>
      <Badge theme={CHANGE_STATE_THEME[c.state] ?? "unknown"} data-testid="change-state">{CHANGE_STATE_LABEL[c.state] ?? c.state}</Badge>
      <span className="w-24 text-right text-muted-foreground" title={c.updatedAt}>{relativeTime(c.updatedAt)}</span>
    </Link>
  );
}

function ChangeView({ projectId, changeId }: { projectId: string; changeId: string }) {
  const change = useChange(projectId, changeId);
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6" data-testid="change-detail">
      <Link to={changesUrl(projectId)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-3.5" /> Changes
      </Link>
      {change.error ? (
        <ErrorView variant="section" error={change.error} what="this change request" onRetry={() => void change.refetch()} />
      ) : !change.data ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <ChangeBody projectId={projectId} change={change.data} />
      )}
    </div>
  );
}

function ChangeBody({ projectId, change: c }: { projectId: string; change: ChangeDetail }) {
  const canEdit = canEditTaskSetup(useProjectSummary(projectId).data);
  const { merge, close, comment } = useChangeActions(projectId, c.id);
  const [draft, setDraft] = useState("");
  const open = isOpenChange(c);
  const mergeProblem = merge.error ? parseProblem(merge.error) : null;
  const needsUpdate = mergeProblem?.status === 409 || c.state === "needs-update";
  const actionError = close.error ?? (mergeProblem && mergeProblem.status !== 409 ? merge.error : null);

  return (
    <div className="flex flex-col gap-6" data-state={c.state}>
      <PageHeading
        title={c.title}
        description={`${authorLine(c)} · updated ${relativeTime(c.updatedAt)}`}
        actions={
          open && (
            <>
              <Button variant="outline" disabled={close.isPending} onClick={() => close.mutate()} data-testid="change-close">
                <CloseIcon /> Close
              </Button>
              {canEdit && (
                <Button disabled={merge.isPending || c.state === "checking"} onClick={() => merge.mutate()} data-testid="change-merge">
                  <MergeIcon /> Merge
                </Button>
              )}
            </>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge theme={CHANGE_STATE_THEME[c.state] ?? "unknown"} data-testid="change-state">{CHANGE_STATE_LABEL[c.state] ?? c.state}</Badge>
        {c.agent && <Badge theme="ai" data-testid="change-agent">Agent: {c.agent}</Badge>}
        {c.mergedBy && <span className="text-muted-foreground">Merged by {c.mergedBy}</span>}
      </div>
      {needsUpdate && (
        <Alert theme="warning" data-testid="change-needs-update">
          This change needs an update: what it changes moved since it was opened, and its checks don't pass any more.
        </Alert>
      )}
      {actionError && <Alert theme="danger" data-testid="change-error">{problemText(actionError)}</Alert>}

      <section aria-labelledby="diff-heading">
        <h2 id="diff-heading" className="mb-2 text-body-2 font-semibold">What changes</h2>
        {c.diff.length === 0 ? (
          <p className="text-sm text-muted-foreground">No differences.</p>
        ) : (
          <Card className="divide-y divide-border overflow-hidden" data-testid="change-diff">
            {c.diff.map((d, i) => (
              <div key={i} className="grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:grid-cols-[8rem_14rem_1fr]" data-testid="change-diff-row">
                <span className="font-mono text-code text-muted-foreground">{d.op}</span>
                <span className="truncate font-mono text-code" title={d.path}>{d.path}</span>
                <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1">
                  <span className="min-w-0 break-all font-mono text-code text-danger line-through decoration-danger/50" data-testid="change-before">{diffValue(d.before)}</span>
                  <ArrowRightIcon className="size-3.5 shrink-0 text-hint" aria-label="becomes" />
                  <span className="min-w-0 break-all font-mono text-code text-positive" data-testid="change-after">{diffValue(d.after)}</span>
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section aria-labelledby="findings-heading">
        <h2 id="findings-heading" className="mb-2 text-body-2 font-semibold">Checks</h2>
        {c.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="change-findings-clear">{c.state === "checking" ? "Checking…" : "Every check passes."}</p>
        ) : (
          <Card className="divide-y divide-border overflow-hidden" data-testid="change-findings">
            {c.findings.map((f, i) => <FindingLine key={f.id ?? i} finding={f} />)}
          </Card>
        )}
      </section>

      <section aria-labelledby="comments-heading">
        <h2 id="comments-heading" className="mb-2 text-body-2 font-semibold">Comments</h2>
        <div className="flex flex-col gap-3" data-testid="change-comments">
          {c.comments.map((m) => (
            <div key={m.id} className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="change-comment">
              <div className="mb-1 text-muted-foreground">
                <span className="font-medium text-foreground">{m.author}</span> · {relativeTime(m.createdAt)}
              </div>
              <p className="whitespace-pre-wrap">{m.body}</p>
            </div>
          ))}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) comment.mutate(draft.trim(), { onSuccess: () => setDraft("") });
            }}
          >
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Leave a comment" aria-label="Comment" data-testid="change-comment-input" />
            <div className="flex items-center gap-3">
              <Button type="submit" variant="outline" size="sm" disabled={!draft.trim() || comment.isPending} data-testid="change-comment-submit">Comment</Button>
              {comment.error && <span className="text-sm text-danger">{problemText(comment.error)}</span>}
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

export function FindingLine({ finding: f, action, hideRule }: { finding: Finding; action?: React.ReactNode; hideRule?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm" data-testid="finding" data-rule={f.rule} data-severity={f.severity}>
      <Badge theme={SEVERITY_THEME[f.severity] ?? "unknown"} size="xs" className="mt-0.5">{SEVERITY_LABEL[f.severity] ?? f.severity}</Badge>
      <span className="min-w-0 flex-1">
        <span className="block">{f.message}</span>
        <span className="block truncate font-mono text-code text-muted-foreground" title={f.path}>
          {[hideRule ? null : f.rule, f.path || null, f.resourceKind ? `${f.resourceKind}${f.resourceId ? ` ${f.resourceId}` : ""}` : null].filter(Boolean).join(" · ")}
        </span>
        {f.fix && <span className="block text-muted-foreground">{f.fix}</span>}
      </span>
      {action}
    </div>
  );
}
