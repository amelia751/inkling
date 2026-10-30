import { execute } from "./commands";

/**
 * The command gateway client (docs/plugins.md §8.2): one path for every caller (toolbar,
 * palette, agent) to run a plugin command or capability. Declarative toolbar actions name a
 * command such as `<namespace>.segmentation.segment_objects`; they never call plugin code
 * directly.
 *
 * Today (todo2 Phase 2) a command runs only if a local handler is registered (`execute`).
 * The kernel gateway (`POST /api/v1/commands`, Phase 4) takes over for commands that no
 * local handler claims.
 */
export interface GatewayContext {
  /** The item the command acts on (asset ids, media type). */
  itemId?: string;
  assetIds?: string[];
  selection?: string[];
}

export type GatewayResult = { ok: true; via: "local" | "kernel"; result?: unknown } | { ok: false; error: string; status?: number };

export type GatewayTransport = (command: string, input: Record<string, unknown>, ctx: GatewayContext) => Promise<GatewayResult>;

let remote: GatewayTransport | null = null;

/** Install the kernel transport (Phase 4). Without one, only local handlers run. */
export function setGatewayTransport(t: GatewayTransport | null): void {
  remote = t;
}

export async function dispatch(command: string, input: Record<string, unknown> = {}, ctx: GatewayContext = {}): Promise<GatewayResult> {
  if (execute(command, { ...input, context: ctx })) return { ok: true, via: "local" };
  if (remote) return remote(command, input, ctx);
  return { ok: false, error: `No handler for command "${command}"` };
}
