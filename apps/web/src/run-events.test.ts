import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * todo11 D4 rule 3: `reduce()` in the agent store is the only consumer of raw run events. Other
 * files read the reduced message parts. This greps `src/`: imports from the protocol package are
 * type-only everywhere, and only the agent store and the agent client name the run-event types
 * (`AgentEvent`, `AgentEventBody`), import the AG-UI table or subscribe to a run (`followRun`).
 */
const SRC = path.resolve(__dirname);
const RAW_EVENT_FILES = new Set(["studio/stores/agent.ts", "studio/lib/agent/client.ts"]);
const RUN_EVENT_NAMES = /\b(AgentEvent|AgentEventBody|AG_UI_MAP)\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Every import statement (multi-line ones included) naming `spec`. */
const importsOf = (src: string, spec: RegExp) => [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm)].filter((m) => spec.test(m[1]!)).map((m) => m[0].trim());

describe("run events are consumed only by reduce() (todo11 D4)", () => {
  const files = sources(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join("/"), src: readFileSync(f, "utf8") }));

  it("finds the agent store and the client", () => {
    for (const f of RAW_EVENT_FILES) expect(files.some((x) => x.rel === f), f).toBe(true);
  });

  it("imports the protocol package for types only", () => {
    const bad = files.flatMap(({ rel, src }) => importsOf(src, /^@studio\/agent-protocol(\/|$)/).filter((s) => !/^(import|export)\s+type\s/.test(s)).map((s) => `${rel}: ${s}`));
    expect(bad).toEqual([]);
  });

  it("names run-event types, the AG-UI table and followRun only in the agent store and client", () => {
    const bad = files
      .filter(({ rel }) => !RAW_EVENT_FILES.has(rel))
      .flatMap(({ rel, src }) => [
        ...importsOf(src, /^@studio\/agent-protocol(\/|$)/).filter((s) => RUN_EVENT_NAMES.test(s) || /agent-protocol\/ag-ui-map/.test(s)),
        ...importsOf(src, /lib\/agent\/client$/).filter((s) => /\bfollowRun\b/.test(s)),
      ].map((s) => `${rel}: ${s}`));
    expect(bad).toEqual([]);
  });
});
