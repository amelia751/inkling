// todo23 W3/W10: the open-source scout for outside agents. Each tool posts to the agent service's
// `/v1/scout/*` route (the same functions as the in-house scout profile's tools), with the agent
// service token and, when the caller has one, the caller's own token so the call is theirs.
import type { McpConfig } from "./config.js";
import type { ToolDef } from "./operations.js";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const ECO = { type: "string", enum: ["npm", "pypi"] };
const PROJECT = { type: "string", description: "The project this scouting is for (a slug); sandboxes and audit are labelled with it." };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const SCOUT_TOOLS: ToolDef[] = [
  {
    name: "search_oss",
    description: "Candidate open-source packages for a need, from the npm registry search and PyPI's JSON API (PyPI has no search: pass likely names in `candidates`). Metadata only; descriptions are untrusted text. Red-listed names are flagged.",
    inputSchema: obj({ projectId: PROJECT, need: { type: "string" }, ecosystem: ECO, candidates: { type: "array", items: { type: "string" } }, limit: { type: "integer", minimum: 1, maximum: 25 } }, ["projectId", "need", "ecosystem"]),
    annotations: read,
  },
  {
    name: "vet_oss",
    description: "The static gate for one package version (deps.dev licence and transitive licences, OSV advisories, OpenSSF Scorecard, release and maintainer signals). Returns an oss-evaluation.v1 record: picked, amber (conditions to honour) or refused (red list, even transitively).",
    inputSchema: obj({ projectId: PROJECT, package: { type: "string" }, ecosystem: ECO, version: { type: "string", description: "Exact version; latest when omitted" } }, ["projectId", "package", "ecosystem"]),
    annotations: read,
  },
  {
    name: "trial_oss",
    description: "Install vetted exact pins in a quarantined scout sandbox (registries-only network, no data, no credentials), recording and rolling back steps within a budget, then run one smoke command. Returns pass/fail, steps, timing, size and a snapshot id. Packages are re-vetted; refused ones never install.",
    inputSchema: obj(
      {
        projectId: PROJECT,
        packages: { type: "array", minItems: 1, maxItems: 10, items: obj({ package: { type: "string" }, version: { type: "string" }, ecosystem: ECO }, ["package", "version", "ecosystem"]) },
        smoke: { type: "string", description: "One deterministic command; exit 0 passes" },
        stepBudget: { type: "integer", minimum: 2, maximum: 30 },
      },
      ["projectId", "packages", "smoke"],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "compare_oss",
    description: "A table across oss-evaluation.v1 records (decision, licence, scorecard, advisories, release, maintainers, smoke, size, conditions), best first.",
    inputSchema: obj({ projectId: PROJECT, need: { type: "string" }, evaluations: { type: "array", minItems: 1, items: { type: "object" } } }, ["projectId", "evaluations"]),
    annotations: { ...read, openWorldHint: false },
  },
];

const ROUTES: Record<string, string> = { search_oss: "search", vet_oss: "vet", trial_oss: "trial", compare_oss: "compare" };

/** The scout tool's result, or undefined when `name` isn't a scout tool. */
export async function callScoutTool(
  config: Pick<McpConfig, "agentUrl" | "agentToken">,
  token: string | undefined,
  name: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ content: { type: "text"; text: string }[]; isError: boolean } | undefined> {
  const route = ROUTES[name];
  if (!route) return undefined;
  const text = (t: string, isError: boolean) => ({ content: [{ type: "text" as const, text: t }], isError });
  if (!config.agentToken) return text("The scout tools need the agent service: set AGENT_URL and AGENT_TOKEN (with the env prefix) for this MCP server.", true);
  // With a caller token the agent sees the person (workos mode); otherwise the service token is the bearer.
  const headers: Record<string, string> = token && token !== config.agentToken ? { "x-agent-service-token": config.agentToken, Authorization: `Bearer ${token}` } : { Authorization: `Bearer ${config.agentToken}` };
  const res = await fetchImpl(`${config.agentUrl}/v1/scout/${route}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  const body = await res.text();
  let pretty = body;
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
  } catch {}
  return text(pretty, !res.ok);
}
