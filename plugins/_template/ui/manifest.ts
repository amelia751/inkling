import * as z from "zod";
import { FileIcon, KeypointIcon } from "@studio/ui/icons";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import type { Project, StudioItem } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";
import { assetName } from "@studio/plugin-ui-sdk/assets";

/**
 * Copy this folder to start a module (AGENTS.md). Rename `example` everywhere, keep the
 * manifest pure data (types, icons, zod schemas, small pure functions), put components in
 * impl.ts, register it in src/bundle.ts and run `pnpm emit:schemas`.
 */
export const EXAMPLE = ns("example");

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({ id: a.path, name: assetName(a), group: "Files", assets: [a], dataKind: `${EXAMPLE}.dataKinds.file` }));
}

export default defineModule({
  id: EXAMPLE,
  version: "0.1.0",
  title: "Example module",
  description: "A minimal module: one data kind, one renderer, one tool and one panel.",
  contributes: {
    dataKinds: [{ id: "file", label: "File", icon: FileIcon, itemNoun: "file", groupItems, description: "One item per file" }],
    renderers: [
      {
        id: "canvas",
        consumes: [`${EXAMPLE}.dataKinds.file`],
        space: "image2d",
        capabilities: [],
        description: "Draws the item name and its points on a canvas",
        configSchema: z.object({ background: z.string().default("#111").describe("Canvas background") }),
        example: { viewports: [{ name: "main", renderer: `${EXAMPLE}.renderers.canvas`, config: { background: "#222" } }] },
      },
    ],
    tools: [{ id: "dot", label: "Dot", hint: "Click to place a dot", icon: KeypointIcon, group: "shape", hotkey: "d", creates: "keypoint", when: `renderer == ${EXAMPLE}.renderers.canvas`, description: "Place a keypoint" }],
    panels: [{ id: "count", title: "Count", slot: "right", description: "How many dots the current item has" }],
  },
  load: () => import("./impl"),
});
