import { type Catalog, presetRefs, searchCatalog } from "./catalog.ts";
import { StudioApiError, type StudioClient } from "./client.ts";
import { type IntentTable, resolveIntent } from "./intents.ts";
import type { BootStudioArgs, GetStudioStateArgs, OfferStudioArgs, PatchStudioArgs, SearchCatalogArgs } from "./schemas.ts";

/**
 * What each Studio tool does, independent of the agent framework: apps/agent wraps these in pi
 * tools, apps/mcp will wrap them in MCP tools. Results are small JSON for a model (ids, states,
 * revisions, errors): never item bytes, never the resolved environment.
 */

export interface StudioToolDeps {
  client: StudioClient;
  catalog: Catalog;
  intents: IntentTable;
  /** The project a session is bound to (the in-app agent); `projectId` in the args wins otherwise. */
  projectId?: string;
}

/** Per-call context: `seed` makes the derived bootId stable across retries of one call (run id + call id). */
export interface CallContext {
  seed?: string;
  signal?: AbortSignal;
}

/** A tool failure the model can act on: the message plus the API's status, `errors[]` and `current` revision. */
export class StudioToolError extends Error {
  override name = "StudioToolError";
  constructor(
    message: string,
    readonly info: { status?: number; errors?: { path: string; code: string; message: string }[]; current?: number } = {},
  ) {
    super(message);
  }

  /** The text the model reads. */
  toJSON() {
    return { error: this.message, ...this.info };
  }
}

const HINTS: Record<number, string> = {
  401: "No API access for this session.",
  403: "Outside what the assistant may change (an agent can only edit draft Studio setups, and only labels, layout, module config and overrides; only a person publishes).",
  404: "Not found.",
  409: "Stale revision: someone changed it since you read it. Read it again with get_studio_state and redo the change on the current revision.",
  422: "The change doesn't validate. Fix each error at its path (use search_catalog for ids) and try again.",
};

export function asToolError(e: unknown): unknown {
  if (!(e instanceof StudioApiError)) return e;
  const hint = HINTS[e.status] ?? `The API returned ${e.status}.`;
  return new StudioToolError(`${hint} ${e.message}`.trim(), {
    status: e.status,
    ...(e.errors.length ? { errors: e.errors.slice(0, 20) } : {}),
    ...(e.current !== undefined ? { current: e.current } : {}),
  });
}

/** A stable bootId from a seed (SHA-256, Web Crypto, so it works in Node and browsers alike). */
export async function deriveBootId(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return `boot_${[...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const randomBootId = () => `boot_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

export function createStudioHandlers(deps: StudioToolDeps) {
  const { client, catalog, intents } = deps;
  const known = new Set(presetRefs(catalog));
  const project = (id?: string) => {
    const p = id ?? deps.projectId;
    if (!p) throw new StudioToolError("projectId is required here (this client isn't bound to a project).");
    return p;
  };
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw asToolError(e);
    }
  };

  /** The preset for a call: the explicit one, else the intent table on `intent` (then `name`). */
  function pickPreset(args: BootStudioArgs): { preset: string; from: "args" | "intent"; matched?: string[] } {
    if (args.preset) {
      if (!known.has(args.preset)) throw new StudioToolError(`Unknown preset ${args.preset}. Use one from the preset index: ${[...known].join(", ")}.`, { status: 422 });
      return { preset: args.preset, from: "args" };
    }
    const m = resolveIntent([args.intent, args.name].filter(Boolean).join(" "), intents);
    if (!m || !known.has(m.preset)) throw new StudioToolError(`No preset matches that request. Pass \`preset\`, one of: ${[...known].join(", ")}.`, { status: 422 });
    return { preset: m.preset, from: "intent", matched: m.matched };
  }

  return {
    async boot_studio(args: BootStudioArgs, ctx: CallContext = {}) {
      const projectId = project(args.projectId);
      const { preset, from, matched } = pickPreset(args);
      const bootId = args.bootId ?? (ctx.seed ? await deriveBootId(`${projectId}\n${ctx.seed}`) : randomBootId());
      const accepted = await wrap(() =>
        client.boot(
          projectId,
          {
            bootId,
            preset,
            ...(args.patch?.length ? { patch: args.patch } : {}),
            ...(args.files?.length ? { files: args.files } : {}),
            ...(args.folders?.length ? { folders: args.folders } : {}),
            ...(args.name ? { name: args.name } : {}),
            ...(args.intent ? { intent: args.intent } : {}),
          },
          ctx.signal,
        ),
      );
      const taskId = accepted.taskIds[0];
      // The revision to patch against next; best effort (the boot already succeeded).
      const revision = taskId && accepted.state !== "failed" ? await client.getEnvironment(taskId, ctx.signal).then((s) => s.revision, () => undefined) : undefined;
      return {
        bootId: accepted.bootId,
        state: accepted.state,
        preset: accepted.preset ?? preset,
        presetFrom: from,
        ...(matched ? { matched } : {}),
        taskIds: accepted.taskIds,
        ...(taskId ? { taskId } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(accepted.ms !== undefined ? { ms: accepted.ms } : {}),
        draft: true,
        note: "Draft Studio: only a person can publish it.",
      };
    },

    async patch_studio(args: PatchStudioArgs, ctx: CallContext = {}) {
      if (!args.patch.length) throw new StudioToolError("Empty patch: nothing to change.");
      const saved = await wrap(() => client.patchEnvironment(args.taskId, args.patch, args.revision, ctx.signal));
      return { taskId: args.taskId, revision: saved.revision, ...(saved.contentHash ? { contentHash: saved.contentHash } : {}), ...(saved.author ? { author: saved.author } : {}), ops: args.patch.length };
    },

    async get_studio_state(args: GetStudioStateArgs, ctx: CallContext = {}) {
      const [env, task] = await Promise.all([wrap(() => client.getEnvironment(args.taskId, ctx.signal)), client.getTask(args.taskId, ctx.signal).catch(() => undefined)]);
      return {
        taskId: args.taskId,
        revision: env.revision,
        ...(task?.state ? { state: task.state } : {}),
        ...(env.author ? { author: env.author } : {}),
        ...(env.savedAt ? { savedAt: env.savedAt } : {}),
        // The stored spec (small: it `extends` a preset); the resolved one stays server-side.
        environment: env.environment ?? null,
        ...(env.environment ? {} : { note: "Nothing saved yet: the task runs its default setup. Patch at revision 0 to start one." }),
      };
    },

    async search_catalog(args: SearchCatalogArgs) {
      const results = searchCatalog(catalog, args.query, { detail: args.detail, kind: args.kind });
      return { query: args.query, results: results.map(({ score: _s, ...r }) => r), ...(results.length ? {} : { note: "Nothing matched; try other words or a broader kind." }) };
    },

    async offer_studio(args: OfferStudioArgs) {
      if (!known.has(args.preset)) throw new StudioToolError(`Unknown preset ${args.preset}. Use one from the preset index.`, { status: 422 });
      return { offer: { preset: args.preset, title: args.title, reason: args.reason }, note: "Shown as a button. Nothing was created; boot_studio runs when the person clicks it or asks explicitly." };
    },
  };
}

export type StudioHandlers = ReturnType<typeof createStudioHandlers>;
