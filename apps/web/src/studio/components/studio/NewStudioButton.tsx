import { useState } from "react";
import { PlusIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Input } from "@studio/ui/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { presetFor, studioName } from "@/studio/lib/studio-boot";
import { useBoots } from "@/studio/stores/boots";

/**
 * **New Studio** (todo11 D5): say what it's for ("chest x-ray"), the preset table picks the
 * preset, and the boot route creates a draft task straight away. This tab then opens it.
 */
export function NewStudioButton({ projectId, variant = "secondary" }: { projectId: string; variant?: "default" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = presetFor(words);
  const create = async () => {
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    const b = await useBoots.getState().start(projectId, { preset: match.preset, name: studioName(words) || undefined });
    setBusy(false);
    if (b.state === "failed") setError(b.message ?? "The Studio couldn't be created.");
    else {
      setOpen(false);
      setWords("");
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={variant} data-testid="new-studio">
          <PlusIcon />
          New Studio
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label htmlFor="new-studio-words" className="font-semibold">What will you annotate?</label>
          <Input id="new-studio-words" autoFocus value={words} onChange={(e) => setWords(e.target.value)} placeholder="chest x-ray, CT, ECG, video…" data-testid="new-studio-input" />
          <p className="text-caption text-hint" data-testid="new-studio-preset">
            {match ? `Starts from ${match.preset}` : words.trim() ? "No preset matches yet. Try x-ray, CT, MRI, ECG or video." : "A draft Studio opens right away; publish it when it's ready."}
          </p>
          {error && <p className="text-danger" role="alert">{error}</p>}
          <Button type="submit" size="sm" className="self-end" disabled={!match || busy} data-testid="new-studio-create">
            Create Studio
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
