import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AG_UI_MAP } from "../src/ag-ui-map.ts";

/**
 * todo11 D4 rule 2: every run event maps onto AG-UI 1.0, and every target exists in the vendored
 * schema. The protocol union is read from the source (types are erased at runtime), so adding an
 * event to `AgentEventBody` without a mapping fails here as well as in `tsc`.
 */
const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("../fixtures/ag-ui-1.0.schema.json", import.meta.url), "utf8"));

function protocolEventTypes(): string[] {
  const m = /export type AgentEventBody =([\s\S]*?);\n/.exec(src);
  if (!m) throw new Error("AgentEventBody not found in src/index.ts");
  return [...m[1]!.matchAll(/\{\s*type:\s*"([^"]+)"/g)].map((x) => x[1]!);
}

describe("AG-UI 1.0 mapping", () => {
  const types = protocolEventTypes();
  const agUi = new Set<string>(schema.$defs.EventType.enum);

  it("reads the protocol union and the vendored schema", () => {
    expect(types.length).toBeGreaterThan(15);
    expect(schema.$id).toBe("https://ag-ui.com/spec/1.0/schema.json");
    expect(agUi.has("CUSTOM")).toBe(true);
  });

  it("maps every protocol event, and nothing else", () => {
    expect(types.filter((t) => !(t in AG_UI_MAP))).toEqual([]);
    expect(Object.keys(AG_UI_MAP).filter((k) => !types.includes(k))).toEqual([]);
  });

  it("names only events that exist in AG-UI 1.0", () => {
    for (const [ours, m] of Object.entries(AG_UI_MAP)) {
      expect(m.targets.length, ours).toBeGreaterThan(0);
      for (const t of m.targets) expect(agUi.has(t), `${ours} → ${t}`).toBe(true);
    }
  });

  it("gives every CUSTOM mapping a name (except the custom envelope, which carries its own)", () => {
    for (const [ours, m] of Object.entries(AG_UI_MAP)) {
      const custom = (m.targets as readonly string[]).includes("CUSTOM");
      if (custom && ours !== "custom") expect("customName" in m && m.customName, ours).toBeTruthy();
    }
  });

  it("uses CUSTOM for run-status, and the start / args / end triple for streamed tool arguments", () => {
    expect(AG_UI_MAP["run-status"].targets).toEqual(["CUSTOM"]);
    expect(AG_UI_MAP["tool-call-start"].targets).toEqual(["TOOL_CALL_START"]);
    expect(AG_UI_MAP["tool-call-args"].targets).toEqual(["TOOL_CALL_ARGS"]);
    expect(AG_UI_MAP["tool-call-end"].targets).toEqual(["TOOL_CALL_END"]);
  });

  it("keeps AgUiEventType in step with the schema's enum", () => {
    const declared = [...readFileSync(new URL("../src/ag-ui-map.ts", import.meta.url), "utf8").matchAll(/^\s*\| "([A-Z_]+)";?$/gm)].map((x) => x[1]);
    expect(new Set(declared)).toEqual(agUi);
  });
});
