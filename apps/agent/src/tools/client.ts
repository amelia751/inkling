import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CARD_TOOLS } from "../agent/profiles.ts";
import type { ClientToolResultRequest, ClientToolSpec } from "../protocol.ts";

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
    private readonly opts: { timeoutS: number; emit: (req: { callId: string; name: string; input: unknown }) => void },
  ) {}

  request(callId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ClientToolResultRequest> {
    if (signal?.aborted) return Promise.reject(new ClientToolError("cancelled"));
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.pending.delete(callId);
        signal?.removeEventListener("abort", onAbort);
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
      label: spec.name.replace(/_/g, " "),
      description: spec.description.slice(0, 4000),
      parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", ...spec.input_schema }),
      async execute(callId: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
        if (card) {
          bridge.request(callId, spec.name, params, signal).catch(() => {});
          bridge.answer(callId, { ok: true, output: { shown: true } });
          return { content: [{ type: "text" as const, text: JSON.stringify({ shown: true }) }], details: { card: { name: spec.name, input: params } } };
        }
        const res = await bridge.request(callId, spec.name, params, signal);
        const textOut = typeof res.output === "string" ? res.output : JSON.stringify(res.output ?? null);
        if (!res.ok) throw new ClientToolError(textOut.slice(0, 8000));
        return { content: [{ type: "text" as const, text: textOut.slice(0, 64 * 1024) }], details: res.output };
      },
    } satisfies ToolDefinition<any, any, any>;
  });
}
