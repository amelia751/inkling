import type { Surface } from "@studio/plugin-contracts/ui-contributions";
import type { PanelSlot } from "@studio/plugin-ui-sdk";

/**
 * Where declarative contributions (`ui/contributions.json`, docs/plugins.md §5.3) land:
 * the same places today's code-backed contributions do.
 *
 *   image.viewer.toolbar          → the canvas toolbar (next to tool contributions)
 *   annotation.inspector          → the right panel slot (next to the inspector rows)
 *   studio.panel.left/right/bottom → PanelSlot left / right / bottom
 *   command.palette               → a command contribution (menus, run_command, keys)
 */
export type Placement = { kind: "toolbar" } | { kind: "command" } | { kind: "panel"; slot: PanelSlot };

export const SURFACE_PLACEMENT: Record<Surface, Placement> = {
  "image.viewer.toolbar": { kind: "toolbar" },
  "annotation.inspector": { kind: "panel", slot: "right" },
  "studio.panel.left": { kind: "panel", slot: "left" },
  "studio.panel.right": { kind: "panel", slot: "right" },
  "studio.panel.bottom": { kind: "panel", slot: "bottom" },
  "command.palette": { kind: "command" },
};
