// Environment writes (todo17 M0): the API requires the `revision` an edit was based on (422
// without it, 409 when stale), so the MCP tools always send one.

export type Result = { ok: boolean; status?: number; data: any };
export type Http = (method: string, path: string, body?: unknown) => Promise<Result>;

/**
 * PATCH or PUT a project's environment with a revision: the caller's (from get_environment), else
 * the current one fetched just before. A 409 becomes a tool error that says what to do next.
 */
export async function writeEnvironment(http: Http, method: "PATCH" | "PUT", projectId: string, body: Record<string, unknown>, revision?: unknown): Promise<Result> {
  const path = `/api/environments/${encodeURIComponent(projectId)}`;
  let rev = typeof revision === "number" && Number.isInteger(revision) ? revision : undefined;
  if (rev === undefined) {
    const cur = await http("GET", path);
    if (!cur.ok) return cur;
    rev = typeof cur.data?.revision === "number" ? cur.data.revision : 0;
  }
  const r = await http(method, path, { ...body, revision: rev });
  if (r.status === 409) {
    const current = r.data?.current?.revision;
    return {
      ok: false,
      status: 409,
      data: {
        error: `Revision conflict: you edited revision ${rev} of ${projectId}, but it is now at ${current ?? "a newer revision"}. Call get_environment, re-apply your change to the new source, and retry with that revision.`,
        current: r.data?.current,
      },
    };
  }
  return r;
}
