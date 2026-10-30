import { formatCombo } from "./keys";

/**
 * Presentation helpers for keyboard shortcuts. Shortcuts are commands contributed by
 * modules and bound by the resolved environment; which binding a command id has right now
 * is the extension host's business, so it plugs in a resolver at boot
 * (`configureShortcuts`, apps/web/src/extension-host/host.tsx). Key syntax: ./keys.ts.
 */
export { comboParts, formatCombo, parseCombo, type ParsedCombo } from "./keys";

export type ShortcutGroup = "Edit" | "Navigate" | "Labels" | "Drawing" | "View" | "Playback" | "Sources" | "Help";
export const GROUP_ORDER: ShortcutGroup[] = ["Edit", "Navigate", "Labels", "Drawing", "View", "Playback", "Sources", "Help"];

/** A command id; bare names mean Studio core commands (`undo` → `<namespace>.core.commands.undo`). */
export type ShortcutId = string;

/** What the UI needs to show a binding. */
export interface ShortcutDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  keys: string[];
  display?: string;
  description?: string;
}

let resolver: (id: ShortcutId) => ShortcutDef | undefined = () => undefined;

export function configureShortcuts(fn: (id: ShortcutId) => ShortcutDef | undefined): void {
  resolver = fn;
}

export function resolveShortcut(id: ShortcutId): ShortcutDef | undefined {
  return resolver(id);
}

/** The UI string for a command: its `display`, else its first combo. */
export function shortcutLabel(id: ShortcutId): string {
  const d = resolveShortcut(id);
  return d ? (d.display ?? (d.keys[0] ? formatCombo(d.keys[0]) : "")) : "";
}
