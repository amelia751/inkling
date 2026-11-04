import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AiIcon, DeleteIcon, DoneIcon, ShowIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { kernelEnabled } from "@/extension-host/kernel";
import { api } from "@/studio/lib/projects-api";
import { projectUrl } from "@/studio/lib/routes";
import { useStudio } from "@/studio/stores/studio";

/** One preview (todo23 D8): `GET /api/v1/projects/{id}/previews` lists only the caller's. */
export interface StudioPreview {
  id: string;
  projectId: string;
  taskId: string;
  status: "active" | "kept" | "discarded";
  expiresAt: string | null;
}

export const previewKeys = { list: (projectId: string) => ["previews", projectId] as const };

/** The caller's active preview whose Studio is `taskId`, if any. Only the requester ever gets one. */
export function useStudioPreview(projectId: string, taskId: string): StudioPreview | undefined {
  const q = useQuery({
    queryKey: previewKeys.list(projectId),
    queryFn: () => api<{ previews: StudioPreview[] }>(`/projects/${encodeURIComponent(projectId)}/previews`),
    enabled: kernelEnabled() && !!projectId && projectId !== taskId,
    staleTime: 30_000,
    retry: false,
  });
  return q.data?.previews.find((p) => p.taskId === taskId && p.status === "active");
}

/**
 * The "Preview" badge in the Studio header (todo23 W6): shown only when the open Studio is a
 * preview, which only its requester can open. Keep moves it to the project; Change opens the
 * assistant (it boots a new preview); Discard deletes it and every annotation made in it.
 */
export function PreviewBadge({ projectId, taskId }: { projectId: string; taskId: string }) {
  const preview = useStudioPreview(projectId, taskId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const aiOpen = useStudio((s) => s.aiOpen);
  const toggleAi = useStudio((s) => s.toggleAi);
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  const path = `/projects/${encodeURIComponent(projectId)}/previews/${encodeURIComponent(preview.id)}`;
  const act = (what: "keep" | "discard") => {
    setBusy(true);
    api(`${path}/${what}`, { method: "POST" })
      .then(() => {
        void qc.invalidateQueries({ queryKey: previewKeys.list(projectId) });
        if (what === "keep") toast("Kept: this Studio is now in the project");
        else {
          toast("Preview discarded");
          navigate(projectUrl(projectId));
        }
      })
      .catch((e: unknown) => toast(`Couldn't ${what} the preview: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false));
  };
  return (
    <span className="flex shrink-0 items-center gap-1" data-testid="preview-badge" data-preview-id={preview.id}>
      <Badge theme="info" title={preview.expiresAt ? `Only you see this preview. It expires ${new Date(preview.expiresAt).toLocaleString()}.` : "Only you see this preview."}>
        <ShowIcon /> Preview
      </Badge>
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => act("keep")} data-testid="preview-keep">
        <DoneIcon /> <span className="hidden @[760px]:inline">Keep</span>
      </Button>
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => !aiOpen && toggleAi()} data-testid="preview-change">
        <AiIcon /> <span className="hidden @[760px]:inline">Change</span>
      </Button>
      <Button variant="ghost" size="xs" className="text-danger" disabled={busy} onClick={() => act("discard")} data-testid="preview-discard">
        <DeleteIcon /> <span className="hidden @[760px]:inline">Discard</span>
      </Button>
    </span>
  );
}
