import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LicenseIcon, LockIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { copySample, projectKeys, useSamples, type SampleTemplate } from "@/studio/lib/projects-api";
import { projectUrl } from "@/studio/lib/routes";
import { cn } from "@studio/ui/utils";

/**
 * "Or try a sample project" (todo14 §4.1, §4.3): one quiet line under an empty Home or Projects
 * list, shown only when the api offers samples (`GET /v1/samples`). It opens a small picker
 * (title, modality, license); "Use this sample" makes a private copy in the person's organization
 * (`POST /v1/projects/from-sample`) and opens its Overview. A second use makes a second copy.
 */
export function TrySample({ className }: { className?: string }) {
  const query = useSamples();
  const samples = query.data;
  const [open, setOpen] = useState(false);
  // todo18: a quiet placeholder while the api answers, not a line that pops in later.
  if (query.isLoading)
    return (
      <div className={cn("text-center", className)}>
        <Button variant="ghost-secondary" size="sm" disabled aria-busy data-testid="try-sample-loading">
          Loading samples…
        </Button>
      </div>
    );
  if (!samples?.enabled) return null;
  return (
    <div className={cn("text-center", className)}>
      <Button variant="ghost-secondary" size="sm" onClick={() => setOpen(true)} data-testid="try-sample">
        Or try a sample project
      </Button>
      <SamplePicker open={open} onOpenChange={setOpen} samples={samples.samples} />
    </div>
  );
}

function SamplePicker({ open, onOpenChange, samples }: { open: boolean; onOpenChange: (o: boolean) => void; samples: SampleTemplate[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const copy = useMutation({
    mutationFn: copySample,
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      onOpenChange(false);
      navigate(projectUrl(p.id));
    },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => (copy.reset(), onOpenChange(o))}>
      <DialogContent className="max-w-lg" data-testid="sample-picker">
        <DialogHeader>
          <DialogTitle>Try a sample project</DialogTitle>
          <DialogDescription>You get your own copy: rename it, add files, label it. Nobody outside your organization sees what you do with it.</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {samples.map((s) => (
            <li key={s.id} className="flex items-start gap-3 rounded-lg border border-border p-3" data-testid="sample-option" data-sample-id={s.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-body-2 font-semibold" title={s.title}>{s.title}</span>
                  {s.restricted && (
                    <Badge theme="warning" title="The source license restricts commercial use or redistribution">
                      <LockIcon />Local dev only
                    </Badge>
                  )}
                </div>
                {s.modality && <p className="mt-0.5 text-sm text-muted-foreground">{s.modality}</p>}
                {s.license && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <LicenseIcon className="mt-0.5 size-3 shrink-0" />
                    <span className="line-clamp-2">{s.license}</span>
                  </p>
                )}
              </div>
              <Button size="sm" variant="outline" className="shrink-0" disabled={copy.isPending} onClick={() => copy.mutate(s.id)} data-testid="use-sample">
                {copy.isPending && copy.variables === s.id ? "Copying…" : "Use this sample"}
              </Button>
            </li>
          ))}
        </ul>
        {copy.error && (
          <p className="text-sm text-danger" role="alert" data-testid="sample-error">
            Couldn't copy the sample: {copy.error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
