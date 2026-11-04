import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { STUDIO_TOOLS, type StudioClient, type StudioToolName, StudioToolError, createStudioHandlers } from "@studio/studio-tools";
import type { StudioCatalog } from "../agent/catalog.ts";

/**
 * Studio tools (todo11 Milestone 2 item 6) as pi **server** tools: they call the API directly with
 * the session's kernel token, so no open Studio is needed. Schemas, descriptions and behaviour
 * come from `@studio/studio-tools` (shared with apps/mcp later); this file only adapts them.
 *
 * - `boot_studio` POSTs the boot route as soon as the call executes: preset from the call, else
 *   from the intent table. Its bootId is derived from run id + tool-call id, so a retried call
 *   gets the same boot back instead of a second task.
 * - `offer_studio` is the "Create X-ray Studio?" card: a server tool whose result
 *   (`{offer: {preset, title, reason}}`) the chat renders as a button (todo11-live renders it;
 *   until then it shows as an ordinary tool row). Clicking it is the explicit intent; it creates
 *   nothing itself.
 *
 * Results are small JSON (task ids, states, revisions, errors with paths), never item bytes.
 */

export interface StudioToolsDeps {
  client: StudioClient;
  studio: StudioCatalog;
  projectId: string;
  /** The active run, for idempotent bootIds. */
  runId: () => string | undefined;
  /** The item open in the Studio (latest snapshot), for get_studio_state (todo19 D12). */
  activeItem?: () => { id: string; kind?: string } | undefined;
}

const out = (value: unknown, summary: string) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { summary } });

const SUMMARY: Record<StudioToolName, (r: any) => string> = {
  boot_studio: (r) => `Studio ${r.state === "failed" ? "failed" : r.state === "ready" ? "ready" : "setting up"} (${r.accepts ? `${r.accepts.length} kinds` : r.preset})`,
  patch_studio: (r) => `Studio updated (revision ${r.revision})`,
  get_studio_state: (r) => `Studio at revision ${r.revision}${r.activeItem?.kind ? ` (open item: ${r.activeItem.kind.split(".").pop()})` : ""}`,
  search_catalog: (r) => `${r.results.length} match${r.results.length === 1 ? "" : "es"}`,
  offer_studio: (r) => (r.preview ? `Preview booted: ${r.offer.title}` : `Offered: ${r.offer.title}`),
};

/** The result a stale-revision write returns (todo21 D6). */
export function studioChanged(e: StudioToolError) {
  return {
    ok: false,
    conflict: true,
    status: 409,
    ...(e.info.current !== undefined ? { current: e.info.current } : {}),
    message: "The Studio changed since you read it (another chat or a person edited it). Re-read it with get_studio_state, then redo your change on the current revision.",
  };
}

export function createStudioTools(deps: StudioToolsDeps): ToolDefinition<any, any, any>[] {
  const handlers = createStudioHandlers({ client: deps.client, catalog: deps.studio.catalog, intents: deps.studio.intents, projectId: deps.projectId, activeItem: deps.activeItem });
  // STUDIO_TOOLS has a fixed order (prompt caching).
  return STUDIO_TOOLS.map((spec) =>
    defineTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters as any,
      async execute(callId, args, signal) {
        const run = deps.runId();
        try {
          const handler = handlers[spec.name] as (a: unknown, c: { seed?: string; signal?: AbortSignal }) => Promise<unknown>;
          const result = await handler(args, { seed: run ? `${run}/${callId}` : callId, signal });
          return out(result, SUMMARY[spec.name](result));
        } catch (e) {
          // todo21 D6: two chats can edit one Studio; a stale revision is not a failure. The model
          // gets an ordinary result telling it to re-read and redo the change on the current revision.
          if (e instanceof StudioToolError && e.info.status === 409) return out(studioChanged(e), "The Studio changed; re-reading");
          // The model reads the status, the errors with their paths and the current revision.
          if (e instanceof StudioToolError) throw new Error(JSON.stringify(e.toJSON()));
          throw e;
        }
      },
    }),
  );
}
