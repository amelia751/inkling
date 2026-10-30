import { commandDef } from "@/platform/commands";
import { formatCombo } from "@/platform/keys";
import type { CommandGroup } from "@/platform/module";
import { NS } from "@studio/plugin-contracts/naming";

/**
 * Keyboard shortcuts are commands contributed by modules (`commands` in a manifest) and
 * bound by the resolved environment; see platform/commands.ts. This file keeps the
 * presentation helpers the UI shares. Key syntax: platform/keys.ts.
 */
export { comboParts, formatCombo, parseCombo, type ParsedCombo } from "@/platform/keys";

export type ShortcutGroup = CommandGroup;
export const GROUP_ORDER: ShortcutGroup[] = ["Edit", "Navigate", "Labels", "Drawing", "View", "Playback", "Help"];

/** A command id; bare names mean Studio core commands (`undo` → `inkling.core.commands.undo`). */
export type ShortcutId = string;

export function resolveShortcut(id: ShortcutId) {
  return commandDef(id) ?? commandDef(`${NS}.core.commands.${id}`);
}

/** The UI string for a command: its `display`, else its first combo. */
export function shortcutLabel(id: ShortcutId): string {
  const d = resolveShortcut(id);
  return d ? (d.display ?? (d.keys[0] ? formatCombo(d.keys[0]) : "")) : "";
}
