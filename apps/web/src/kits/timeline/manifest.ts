import { tool } from "@/kits/tool-catalog";
import { defineModule } from "@/platform/module";
import { ns } from "@studio/plugin-contracts/naming";

/**
 * Time-axis tools for renderers with the `time` capability: spans and instants on a timeline.
 * Renderers draw the axis with `Timeline.tsx` (ruler, playhead, A–B range, filmstrip and lanes of
 * span / instant items).
 */
const TIME = "'time' in renderer.capabilities";

export default defineModule({
  id: ns("timeline"),
  version: "1.0.0",
  title: "Timeline tools",
  description: "Label spans and point-in-time events on any renderer with a time axis.",
  contributes: {
    tools: [
      tool("segment", { creates: "span", when: TIME, description: "Drag along the timeline to label a span" }),
      tool("event", { creates: "instant", when: TIME, description: "Mark the current frame as an event" }),
    ],
  },
});
