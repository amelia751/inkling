import { useRef, useState, type DragEvent } from "react";
import { UploadIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { cn } from "@studio/ui/utils";
import type { AgentCard } from "@studio/agent-protocol";
import { DropCard, pastedFiles, startDrop } from "@/studio/core/drops";

/**
 * request_upload (todo16 D10): the assistant asks, the person picks or drops files here. The
 * bytes go the normal import path (`startDrop`, into the folder the assistant named or the
 * chat's landing folder); the assistant only ever reads the drop's facts, as for any chat drop.
 */
export function UploadCard({ projectId, card }: { projectId: string; card: Extract<AgentCard, { kind: "upload-request" }> }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [dropId, setDropId] = useState<string>();

  const take = (files: FileList | File[] | null) => {
    if (!files || !files.length) return;
    setDropId(startDrop({ projectId, origin: "chat", files: pastedFiles(files), ...(card.folderId ? { targetNodeId: card.folderId } : {}), ...(dropId ? { dropId } : {}) }));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    take(e.dataTransfer.files);
  };

  return (
    <div data-testid="upload-card" className="rounded-md border border-border bg-card text-sm">
      {card.reason && <p className="px-3 pt-3 text-muted-foreground">{card.reason}</p>}
      <div
        data-testid="upload-card-zone"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn("m-3 flex flex-col items-center gap-2 rounded-md border border-dashed border-border px-3 py-5 text-center", over && "border-primary bg-primary/5")}
      >
        <UploadIcon className="size-4 text-muted-foreground" />
        <span>Drop files or a folder here</span>
        <Button size="sm" variant="outline" onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="upload-card-input"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      {dropId && (
        <div className="px-3 pb-3">
          <DropCard dropId={dropId} projectId={projectId} />
        </div>
      )}
    </div>
  );
}
