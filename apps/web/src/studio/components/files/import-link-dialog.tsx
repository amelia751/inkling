import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { api, projectKeys } from "@/studio/lib/projects-api";
import { problemMessage } from "@/studio/lib/problem";
import { useUploads } from "@/studio/stores/uploads";

/** A link the kernel can fetch: https:// or gs:// (the kernel checks the rest: pinned DNS, size cap). */
export const linkOk = (s: string) => /^(https|gs):\/\/\S+$/i.test(s.trim());

/**
 * "Import from a link" (todo18): the same rights attestation as an upload, then
 * `POST /projects/{id}/imports/url`; the import shows in Sources' Imports as "Fetching…".
 */
export async function importFromLink(projectId: string, url: string, folderId?: string | null): Promise<{ importId: string } | null> {
  if (!(await useUploads.getState().attest(projectId, 1))) return null;
  return api<{ importId: string }>(`/projects/${encodeURIComponent(projectId)}/imports/url`, { method: "POST", json: { url: url.trim(), attested: true, ...(folderId ? { folderId } : {}) } });
}

export function ImportLinkDialog({ open, onOpenChange, projectId, folderId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; folderId?: string | null }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Close first: the attestation dialog may open next.
      onOpenChange(false);
      const r = await importFromLink(projectId, url, folderId);
      if (r) {
        toast.success("Importing from the link", { description: "It shows under Imports while it downloads." });
        setUrl("");
        void qc.invalidateQueries({ queryKey: projectKeys.imports(projectId) }); // todo18 D1: invalidateFor
      }
    } catch (e) {
      setError(problemMessage(e));
      onOpenChange(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="import-link-dialog">
        <DialogHeader>
          <DialogTitle>Import from a link</DialogTitle>
          <DialogDescription>An https:// or gs:// link to one file. It lands in this folder.</DialogDescription>
        </DialogHeader>
        <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" onKeyDown={(e) => e.key === "Enter" && linkOk(url) && void submit()} data-testid="import-link-url" />
        {error && (
          <p className="text-sm text-danger" role="alert" data-testid="import-link-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!linkOk(url) || busy} loading={busy} onClick={() => void submit()} data-testid="import-link-submit">
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
