import { Fragment, useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Kbd, Shortcut } from "@studio/ui/ui/kbd";
import { ChevronRightIcon, SearchIcon } from "@studio/ui/icons";
import { formatCombo } from "@studio/ui/keys";
import { GROUP_ORDER, type ShortcutGroup } from "@studio/ui/shortcuts";
import { cn } from "@studio/ui/utils";
import type { ResolvedCommand, ResolvedEnv } from "@/extension-host/resolve";
import type { Registered } from "@/extension-host/registry";
import { coreCommand, ESSENTIALS } from "@/studio/core/manifest";
import { useToolPrefs } from "@/studio/stores/tool-prefs";
import { GROUP_TITLES, groupTools } from "./toolbar-layout";

const MAX_ESSENTIALS = 8;

/** One row of the sheet: a label and the combos that trigger it (a family such as 1–9 shows `display`). */
export interface SheetRow {
  id: string;
  label: string;
  keys: string[];
  display?: string;
}

export interface Sheet {
  essentials: SheetRow[];
  tools: { title: string; rows: SheetRow[] }[];
  commands: { title: ShortcutGroup; rows: SheetRow[] }[];
  whileDrawing: SheetRow[];
}

/**
 * Search: a key typed alone matches its combo (`b` finds Brush), and labels match by word
 * start for one letter (`b` also finds "Smaller brush", bound to `[`) or by substring beyond.
 */
export function rowMatches(row: SheetRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const keys = row.keys.flatMap((k) => [k.toLowerCase(), formatCombo(k).toLowerCase()]);
  if (row.display) keys.push(row.display.toLowerCase());
  if (keys.includes(q)) return true;
  const label = row.label.toLowerCase();
  return q.length === 1 ? label.split(/[^a-z0-9]+/).some((w) => w.startsWith(q)) : label.includes(q);
}

const commandRow = (c: ResolvedCommand): SheetRow => ({ id: c.id, label: c.label, keys: c.keys, display: c.display });
const toolRow = (t: Registered<"tools">): SheetRow => ({ id: t.id, label: t.label, keys: [t.hotkey!] });

/**
 * The sheet's content for an environment (todo8 D6): Essentials (the fixed core list), this
 * task's tools by toolbar group, the other commands by group, and contextual keys (finish
 * shape, cancel, Tab through suggestions) apart under "While drawing".
 */
export function buildSheet(env: ResolvedEnv, query = ""): Sheet {
  const bound = env.commands.filter((c) => c.keys.length);
  const byId = new Map(bound.map((c) => [c.id, c]));
  const used = new Set<string>();

  const essentials: SheetRow[] = [];
  for (const e of ESSENTIALS) {
    const cmds = e.commands.map((n) => byId.get(coreCommand(n))).filter((c): c is ResolvedCommand => !!c);
    if (!cmds.length) continue;
    cmds.forEach((c) => used.add(c.id));
    const single = cmds.length === 1 ? cmds[0] : undefined;
    // Pairs (undo / redo, previous / next) show each command's first key.
    essentials.push({ id: e.label, label: e.label, keys: single ? single.keys.slice(0, 2) : cmds.map((c) => c.keys[0]), display: single?.display });
  }

  const tools = groupTools(env.tools.filter((t) => t.hotkey)).map(({ group, tools: list }) => ({ title: GROUP_TITLES[group], rows: list.map(toolRow) }));

  const whileDrawing = bound.filter((c) => c.contextual && !used.has(c.id)).map(commandRow);
  const commands = GROUP_ORDER.map((title) => ({ title, rows: bound.filter((c) => c.group === title && !c.contextual && !used.has(c.id)).map(commandRow) }));

  const keep = (rows: SheetRow[]) => rows.filter((r) => rowMatches(r, query));
  return {
    essentials: keep(essentials).slice(0, MAX_ESSENTIALS),
    tools: tools.map((g) => ({ ...g, rows: keep(g.rows) })).filter((g) => g.rows.length),
    commands: commands.map((g) => ({ ...g, rows: keep(g.rows) })).filter((g) => g.rows.length),
    whileDrawing: keep(whileDrawing),
  };
}

/** The "?" sheet (todo8 D6): essentials first, searchable, and its Tools mirror the toolbar. */
export function ShortcutsDialog({ open, onOpenChange, env }: { open: boolean; onOpenChange: (open: boolean) => void; env: ResolvedEnv }) {
  const [query, setQuery] = useState("");
  const [drawingOpen, setDrawingOpen] = useState(false);
  const markSeen = useToolPrefs((s) => s.markShortcutsSeen);
  useEffect(() => {
    if (open) markSeen();
    else setQuery("");
  }, [open, markSeen]);
  const sheet = useMemo(() => buildSheet(env, query), [env, query]);
  const searching = query.trim().length > 0;
  const empty = !sheet.essentials.length && !sheet.tools.length && !sheet.commands.length && !sheet.whileDrawing.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0" aria-describedby={undefined} data-testid="shortcuts-dialog">
        <DialogHeader className="gap-3 border-b border-border px-6 pb-4 pt-5 text-left">
          <DialogTitle className="text-body-2 font-semibold">Keyboard shortcuts</DialogTitle>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            {/* Typing here never fires shortcuts: the dispatcher skips inputs and dialogs. */}
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or key" aria-label="Search shortcuts" className="pl-7" data-testid="shortcuts-search" />
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {empty && <p className="text-sm text-muted-foreground">No shortcut matches "{query.trim()}".</p>}
          {sheet.essentials.length > 0 && (
            <section data-testid="shortcuts-essentials">
              <Heading>Essentials</Heading>
              <dl className="grid gap-x-8 sm:grid-cols-2">
                {sheet.essentials.map((r) => (
                  <Row key={r.id} row={r} pair={r.label.includes(" / ")} />
                ))}
              </dl>
            </section>
          )}
          {sheet.tools.length > 0 && (
            <section data-testid="shortcuts-tools">
              <Heading>Tools</Heading>
              <div className="space-y-3">
                {sheet.tools.map((g) => (
                  <div key={g.title}>
                    <h4 className="mb-1 text-xs text-muted-foreground">{g.title}</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
                      {g.rows.map((r) => (
                        <div key={r.id} className="flex min-h-7 items-center gap-2 text-sm" data-testid="shortcut-row">
                          <Kbd className="min-w-6">{formatCombo(r.keys[0])}</Kbd>
                          <span className="truncate text-muted-foreground">{r.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          {sheet.commands.length > 0 && (
            <section>
              <Heading>Commands</Heading>
              <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {sheet.commands.map((g) => (
                  <div key={g.title}>
                    <h4 className="mb-0.5 text-xs text-muted-foreground">{g.title}</h4>
                    <dl>
                      {g.rows.map((r) => (
                        <Row key={r.id} row={r} />
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            </section>
          )}
          {sheet.whileDrawing.length > 0 && (
            <section data-testid="shortcuts-while-drawing">
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-semibold"
                aria-expanded={drawingOpen || searching}
                onClick={() => setDrawingOpen((o) => !o)}
              >
                <ChevronRightIcon className={cn("size-3.5 transition-transform", (drawingOpen || searching) && "rotate-90")} />
                While drawing
              </button>
              {(drawingOpen || searching) && (
                <dl className="mt-1.5 grid gap-x-8 sm:grid-cols-2">
                  {sheet.whileDrawing.map((r) => (
                    <Row key={r.id} row={r} />
                  ))}
                </dl>
              )}
            </section>
          )}
        </div>
        <p className="border-t border-border px-6 py-3 text-xs text-muted-foreground">Keys don't fire while you type in a field</p>
      </DialogContent>
    </Dialog>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-sm font-semibold">{children}</h3>;
}

/** A label and its keys; `pair` rows (undo / redo) join their two combos with a slash, others with "or". */
function Row({ row, pair = false }: { row: SheetRow; pair?: boolean }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 py-0.5" data-testid="shortcut-row">
      <dt className="text-sm text-muted-foreground">{row.label}</dt>
      <dd className="flex shrink-0 items-center gap-1.5 text-sm">
        {row.display ? (
          <Kbd>{row.display}</Kbd>
        ) : (
          row.keys.slice(0, 2).map((k, i) => (
            <Fragment key={k}>
              {i > 0 && <span className="text-hint">{pair ? "/" : "or"}</span>}
              <Shortcut combo={k} />
            </Fragment>
          ))
        )}
      </dd>
    </div>
  );
}
