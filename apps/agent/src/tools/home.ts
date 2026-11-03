import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ClientToolSpec } from "@studio/agent-protocol";
import { KernelError, type KernelClient } from "./kernel.ts";

/**
 * todo21 D8 / §1: a Home chat routes, it never works on project data. Its only server tools are
 * `list_projects` (metadata from the kernel's project list: no trees, no file names, no contents)
 * and `open_in_project` (a new chat in one project, seeded with the request). `create_project` is a
 * client tool (the browser's new-project dialog, so the person confirms the name).
 */

export const HOME_SERVER_TOOLS = ["list_projects", "open_in_project"] as const;
export const HOME_CLIENT_TOOLS = ["create_project"] as const;

/** The default spec when the browser didn't declare one; the result is `{project:{id,title}}` or `{cancelled:true}`. */
export const HOME_CLIENT_TOOL_SPECS: Record<(typeof HOME_CLIENT_TOOLS)[number], ClientToolSpec> = {
  create_project: {
    name: "create_project",
    title: "New project",
    description:
      "Open the new-project dialog with a suggested name. The person confirms (or edits) the name, or cancels. Returns {project:{id,title}} or {cancelled:true}.",
    input_schema: { type: "object", properties: { suggestion: { type: "string", description: "A short suggested name, e.g. \"Liver CT\"." } }, additionalProperties: false },
  },
};

/** What Home may know about a project. Everything else in the kernel's row is dropped. */
export interface ProjectMetadata {
  id: string;
  title: string;
  kinds: string[];
  counts: { files: number; byKind: Record<string, number> };
  lastActivity: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const enc = encodeURIComponent;

export function projectMetadata(p: Record<string, unknown>): ProjectMetadata {
  const kinds = Array.isArray(p.kinds) ? (p.kinds as { kind?: unknown; count?: unknown }[]).filter((k) => typeof k?.kind === "string") : [];
  const byKind = Object.fromEntries(kinds.map((k) => [String(k.kind), Number(k.count) || 0]));
  return {
    id: String(p.id),
    title: String(p.title ?? ""),
    kinds: kinds.map((k) => String(k.kind)),
    counts: { files: Object.values(byKind).reduce((a, b) => a + b, 0), byKind },
    lastActivity: typeof p.lastActivityAt === "string" ? p.lastActivityAt : typeof p.updatedAt === "string" ? p.updatedAt : null,
  };
}

export interface HomeToolsDeps {
  /** A kernel client with no workspace (the person's delegated token). */
  kernel: KernelClient;
  /** Create a project chat for the same owner seeded with `request`, and start its run. */
  open: (projectId: string, request: string) => Promise<{ projectId: string; sessionId: string }>;
}

const out = (value: unknown, summary: string) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { summary } });

export function createHomeTools(d: HomeToolsDeps): ToolDefinition<any, any, any>[] {
  const listProjects = defineTool({
    name: "list_projects",
    label: "Listing projects",
    description:
      "The person's projects: id, title, the kinds of files each holds with counts, and last activity. Metadata only: no file names, folders or contents. Use it to answer which project has what, or to pick one for open_in_project.",
    promptSnippet: "List the person's projects (metadata only)",
    parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Filter by title (optional)." })) }),
    async execute(_id, args, signal) {
      const q = args.query ? `?q=${enc(args.query)}` : "";
      const r = await d.kernel.get<{ projects?: Record<string, unknown>[] }>(`/projects${q}`, signal);
      const projects = (r.projects ?? []).map(projectMetadata);
      return out({ projects }, `${projects.length} project${projects.length === 1 ? "" : "s"}`);
    },
  });

  const openInProject = defineTool({
    name: "open_in_project",
    label: "Opening a chat in a project",
    description:
      "Start a new chat in one project with the person's request as its first message; the work happens there and the person is taken to it. Use it for anything that reads or changes a project's files, labels or Studios.",
    promptSnippet: "Hand a request to a new chat in one project",
    parameters: Type.Object({
      projectId: Type.String({ description: "A project id from list_projects." }),
      request: Type.String({ description: "The person's request, in their words, for the project's chat." }),
    }),
    async execute(_id, args, signal) {
      const projectId = String(args.projectId ?? "");
      const request = String(args.request ?? "").trim();
      if (!SLUG.test(projectId)) throw new Error(`"${projectId}" is not a project id; use one from list_projects.`);
      if (!request) throw new Error("request must not be empty.");
      // The person must be able to open the project (the kernel decides: membership, visibility).
      try {
        await d.kernel.request("GET", `/projects/${enc(projectId)}`, { signal, headers: { "X-Workspace-Id": projectId } });
      } catch (err) {
        if (err instanceof KernelError && (err.status === 403 || err.status === 404)) throw new Error(`No project "${projectId}" you can open.`);
        throw err;
      }
      const r = await d.open(projectId, request.slice(0, 32_000));
      // The web reads the target from the tool-result summary (the run-event stream carries only
      // summary + input), so the summary is exactly this JSON.
      return out(r, JSON.stringify({ projectId: r.projectId, sessionId: r.sessionId }));
    },
  });

  return [listProjects, openInProject];
}
