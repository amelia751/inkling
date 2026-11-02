import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { DropCard } from "./drop-card";
import { useConversationDrops, useDropEvents } from "./hooks";

/**
 * A conversation's Shared files (todo13 D4), like the files of a Messenger chat: its drops,
 * newest first. Removing a file here or on its card takes it out of the chat only; it stays in
 * Files until someone deletes it there.
 */
export function SharedFiles({ projectId, conversationId, canEdit }: { projectId: string; conversationId: string | undefined; canEdit: boolean }) {
  useDropEvents(projectId);
  const q = useConversationDrops(projectId, conversationId);
  if (conversationId && q.isLoading)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3" role="status" aria-busy aria-label="Loading shared files">
        {Array.from({ length: 3 }, (_, i) => (
          <section key={i} className="flex flex-col gap-1.5">
            <SkeletonText className="w-32" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </section>
        ))}
      </div>
    );
  const drops = (q.data?.drops ?? []).filter((d) => d.files.some((f) => f.state !== "removed"));
  if (!drops.length)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-testid="chat-files-empty">
        <p className="text-body-2 font-semibold">No shared files yet</p>
        <p className="text-muted-foreground">Files you share in this chat appear here.</p>
      </div>
    );
  return (
    <div className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3" data-testid="chat-files">
      {drops.map((d) => (
        <section key={d.id} className="flex flex-col gap-1.5">
          <h3 className="px-0.5 text-caption text-hint">{new Date(d.createdAt).toLocaleString()}</h3>
          <DropCard dropId={d.id} projectId={projectId} canEdit={canEdit} />
        </section>
      ))}
    </div>
  );
}
