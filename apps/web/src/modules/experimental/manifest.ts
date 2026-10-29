import * as z from "zod";
import { defineModule } from "@/platform/module";

/**
 * Agent-generated UI, behind the `agentPanels` flag (docs/modules.md, safety tiers 2 and 3).
 *
 * Tier 2, `panels.declarative`: the agent writes JSON blocks (text, stats, lists, progress)
 *   bound to whitelisted runtime keys and store selectors. No code runs.
 * Tier 3, `panels.sandbox`: agent-written HTML/JS in a sandboxed iframe (no same-origin, no
 *   top navigation). Its only channel is a postMessage bridge that can read the current
 *   item's annotations and propose new ones, which arrive validated and `ai-suggested`.
 */
export const EXPERIMENTAL = "inkling.experimental";

export const STORE_SELECTORS = ["annotations.count", "annotations.item", "items.total", "items.annotated", "selection.count", "activeLabel", "tool", "labels.counts"] as const;

const Binding = z
  .union([z.string(), z.number(), z.object({ runtime: z.string().describe("Runtime key published for the current item") }), z.object({ store: z.enum(STORE_SELECTORS) })])
  .describe("A literal, { runtime: key } or { store: selector }");

const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("stat"), label: z.string(), value: Binding, unit: z.string().optional() }),
  z.object({ type: z.literal("list"), label: z.string(), items: Binding.describe("An array, or an object shown as key: value rows") }),
  z.object({ type: z.literal("progress"), label: z.string(), value: Binding, max: Binding }),
]);

export const DeclarativeConfig = z.object({
  title: z.string().default("Agent panel"),
  blocks: z.array(Block).default([]),
});

export const SandboxConfig = z.object({
  title: z.string().default("Sandboxed tool"),
  html: z.string().default("<p>No content.</p>").describe("A complete HTML document; talk to the Studio with window.inkling.getAnnotations() / .propose([...])"),
  height: z.number().int().min(120).max(2000).default(480),
});

export default defineModule({
  id: EXPERIMENTAL,
  version: "0.1.0",
  title: "Agent-generated panels (experimental)",
  description: "Declarative JSON panels and sandboxed agent-written tools. Only registered when the agentPanels flag is on.",
  contributes: {
    panels: [
      {
        id: "declarative",
        title: "Agent panel",
        slot: "right",
        configSchema: DeclarativeConfig,
        description: "Tier 2: JSON blocks (text, stat, list, progress) bound to runtime keys and store selectors; no code",
        example: {
          panels: { right: [`${EXPERIMENTAL}.panels.declarative`] },
          overrides: [{ id: `${EXPERIMENTAL}.panels.declarative`, config: { title: "Progress", blocks: [{ type: "progress", label: "Items annotated", value: { store: "items.annotated" }, max: { store: "items.total" } }, { type: "list", label: "Per class", items: { store: "labels.counts" } }] } }],
        },
      },
      {
        id: "sandbox",
        title: "Sandboxed tool",
        slot: "right",
        configSchema: SandboxConfig,
        description: "Tier 3: agent-written HTML/JS in a sandboxed iframe that can only read the item's annotations and propose ai-suggested ones",
      },
    ],
  },
  load: () => import("./impl"),
});
