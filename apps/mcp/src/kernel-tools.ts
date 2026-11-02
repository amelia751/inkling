// todo16 D7: kernel tools generated from the operations catalogue (schemas/operations.json,
// emitted from packages/contracts/src/operations.ts by `pnpm emit:schemas`), called on the
// kernel API with a person token (<envPrefix>MCP_PERSON_TOKEN, or the org API key). The kernel
// applies that person's project role. Destroy operations need `confirm: true`: they can't be undone.
import { readFileSync } from "node:fs";

export interface CatalogOperation {
  id: string;
  tool: string;
  tier: "read" | "write" | "trash" | "destroy";
  method: string;
  path: string;
  description: string;
  removes?: string;
  input: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export const OPERATIONS: CatalogOperation[] = JSON.parse(readFileSync(new URL("../../../schemas/operations.json", import.meta.url), "utf8")).operations;

/** Server tool names must not clash with the environment tools. */
const toolName = (op: CatalogOperation) => `kernel_${op.tool}`;

export function kernelTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return OPERATIONS.map((op) => {
    const props: Record<string, unknown> = { projectId: { type: "string", description: "The project to act in" }, ...(op.input.properties ?? {}) };
    const required = ["projectId", ...(op.input.required ?? [])];
    if (op.tier === "destroy") {
      props.confirm = { type: "boolean", description: "Must be true: this deletes forever and can't be undone. Ask the person first." };
      required.push("confirm");
    }
    const note = op.tier === "trash" ? " Goes to the Trash (restorable for 30 days)." : op.tier === "destroy" ? " Permanent; ask the person first and pass confirm: true." : "";
    return { name: toolName(op), description: `${op.description}${note}`, inputSchema: { type: "object", properties: props, required, additionalProperties: false } };
  });
}

const FS_OPS: Record<string, string> = { "source.mkdir": "mkdir", "source.rename": "rename", "source.move": "move", "source.copy": "copy", "source.trash": "trash", "source.restore": "restore", "source.purge": "purge" };

/** The HTTP request for a call, or an error message. Mirrors `operationRequest` in the contracts package. */
export function kernelRequest(name: string, args: Record<string, unknown>): { method: string; path: string; body?: unknown } | { error: string } | undefined {
  const op = OPERATIONS.find((o) => toolName(o) === name);
  if (!op) return undefined;
  const { projectId, confirm, ...rest } = args;
  if (typeof projectId !== "string" || !projectId) return { error: "projectId is required" };
  if (op.tier === "destroy" && confirm !== true) return { error: `${op.id} deletes forever and can't be undone: ask the person, then call again with confirm: true` };
  let path = `/api/v1${op.path.replace("{pid}", encodeURIComponent(projectId))}`;
  for (const m of op.path.matchAll(/\{(\w+)\}/g)) {
    if (m[1] === "pid") continue;
    path = path.replace(m[0], encodeURIComponent(String(rest[m[1]!] ?? "")));
    delete rest[m[1]!];
  }
  if (path.startsWith("/api/v1/api/")) path = path.slice("/api/v1".length);
  if (FS_OPS[op.id]) return { method: op.method, path, body: { ops: [{ kind: FS_OPS[op.id], ...rest }] } };
  if (op.method === "GET" || op.method === "DELETE") {
    const qs = new URLSearchParams(Object.entries(rest).map(([k, v]): [string, string] => [k, String(v)])).toString();
    return { method: op.method, path: qs ? `${path}?${qs}` : path };
  }
  return { method: op.method, path, body: rest };
}
