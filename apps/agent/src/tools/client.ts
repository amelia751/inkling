import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CARD_TOOLS } from "../agent/profiles.ts";
import type { ClientToolResultRequest, ClientToolSpec } from "@studio/agent-protocol";

export class ClientToolError extends Error {
  override name = "ClientToolError";
}

interface Pending {
  name: string;
  resolve: (r: ClientToolResultRequest) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Tools that run in the browser: emit a request on the event feed, then wait for the POSTed result. */
export class ClientToolBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly opts: {
      timeoutS: number;
      emit: (req: { callId: string; name: string; input: unknown }) => void;
      /** Every awaited request ends here once: answered, timed out or cancelled. */
      onSettled?: (callId: string) => void;
    },
  ) {}

  request(callId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ClientToolResultRequest> {
    if (signal?.aborted) return Promise.reject(new ClientToolError("cancelled"));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.pending.delete(callId);
        signal?.removeEventListener("abort", onAbort);
        this.opts.onSettled?.(callId);
      };
      const onAbort = () => {
        done();
        reject(new ClientToolError("cancelled"));
      };
      const timer = setTimeout(() => {
        done();
        reject(new ClientToolError(`${name} got no response from the Studio within ${this.opts.timeoutS}s`));
      }, this.opts.timeoutS * 1000);
      this.pending.set(callId, {
        name,
        timer,
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.opts.emit({ callId, name, input });
    });
  }

  /** Fire-and-forget request (card tools): the panel renders it; nothing is awaited. */
  notify(callId: string, name: string, input: unknown): void {
    this.opts.emit({ callId, name, input });
  }

  /** Returns false for unknown or already-answered calls (idempotent POSTs). */
  answer(callId: string, result: ClientToolResultRequest): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    p.resolve(result);
    return true;
  }

  cancelAll(reason = "cancelled"): void {
    for (const p of [...this.pending.values()]) p.reject(new ClientToolError(reason));
  }

  get size(): number {
    return this.pending.size;
  }
}

export const STUDIO_CHANGED = "The Studio changed since you read it (another chat or a person edited it). Re-read it (get_environment), then redo your change on the current revision.";
const isConflict = (o: unknown) => !!o && typeof o === "object" && ((o as { conflict?: unknown }).conflict === true || (o as { status?: unknown }).status === 409);

const isCard = (name: string) => (CARD_TOOLS as readonly string[]).includes(name);
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Validate browser-declared tools against the profile allowlist and wrap them as pi tools. */
export function createClientTools(specs: ClientToolSpec[], allowed: readonly string[], bridge: ClientToolBridge): ToolDefinition<any, any, any>[] {
  const seen = new Set<string>();
  return specs.map((spec) => {
    if (!NAME_RE.test(spec.name) || !allowed.includes(spec.name)) throw new ClientToolError(`client tool "${spec.name}" is not allowed for this profile`);
    if (seen.has(spec.name)) throw new ClientToolError(`duplicate client tool "${spec.name}"`);
    seen.add(spec.name);
    const card = isCard(spec.name);
    return {
      name: spec.name,
      label: (spec.title ?? spec.name.replace(/_/g, " ")).slice(0, 80),
      promptSnippet: spec.description.split(". ")[0]!.slice(0, 200),
      description: spec.description.slice(0, 4000),
      parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", ...spec.input_schema }),
      async execute(callId: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
        if (card) {
          // Cards only act on the expert's click, so there is nothing to wait for.
          bridge.notify(callId, spec.name, params);
          return { content: [{ type: "text" as const, text: JSON.stringify({ shown: true, note: "Shown to the expert as a card; it only acts if they click it." }) }], details: { summary: "Shown as a card" } };
        }
        const res = await bridge.request(callId, spec.name, params, signal);
        const textOut = typeof res.output === "string" ? res.output : JSON.stringify(res.output ?? null);
        // todo21 D6: the browser's environment tools report a stale revision as {conflict: true} or
        // status 409. That is not a failure: tell the model to re-read and redo the change.
        if (!res.ok && isConflict(res.output))
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, conflict: true, message: STUDIO_CHANGED, detail: res.output }).slice(0, 8000) }], details: { summary: "The Studio changed; re-reading", output: res.output } };
        if (!res.ok) throw new ClientToolError(textOut.slice(0, 8000));
        // The browser shows its own one-line summary; the model gets the full output.
        return { content: [{ type: "text" as const, text: textOut.slice(0, 64 * 1024) }], details: { summary: "Done", output: res.output } };
      },
    } satisfies ToolDefinition<any, any, any>;
  });
}
