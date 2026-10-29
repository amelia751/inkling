import { Fragment } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Shortcut } from "@/components/ui/kbd";
import { GROUP_ORDER, shortcutsFor, TOOL_KEYS, type ShortcutDef, type ShortcutGroup, type ShortcutId } from "@/lib/shortcuts";
import type { Tool } from "@/stores/studio";
import type { ViewerKind } from "@/types";
import { TOOL_META } from "./CanvasToolbar";

/** The "?" sheet. Built from the shortcut registry, filtered to what this viewer binds. */
export function ShortcutsDialog({ open, onOpenChange, viewer, tools }: { open: boolean; onOpenChange: (open: boolean) => void; viewer: ViewerKind; tools: Tool[] }) {
  const byGroup = new Map<ShortcutGroup, [ShortcutId, ShortcutDef][]>();
  for (const [id, def] of shortcutsFor(viewer, tools)) byGroup.set(def.group, [...(byGroup.get(def.group) ?? []), [id, def]]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle className="text-body-2 font-semibold">Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts don't fire while you're typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 px-6 py-5 sm:grid-cols-2">
          {tools.length > 0 && (
            <Section title="Tools">
              {tools.map((t) => (
                <Row key={t} label={TOOL_META[t].label}>
                  <Shortcut combo={TOOL_KEYS[t]} />
                </Row>
              ))}
            </Section>
          )}
          {GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => (
            <Section key={g} title={g}>
              {byGroup.get(g)!.map(([id, def]) => (
                <Row key={id} label={def.label}>
                  {def.display ? <Shortcut id={id} /> : def.keys.slice(0, 2).map((k, i) => (
                    <Fragment key={k}>
                      {i > 0 && <span className="text-hint">or</span>}
                      <Shortcut combo={k} />
                    </Fragment>
                  ))}
                </Row>
              ))}
            </Section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 border-b border-border/60 py-1 last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex shrink-0 items-center gap-1.5 text-sm">{children}</dd>
    </div>
  );
}
