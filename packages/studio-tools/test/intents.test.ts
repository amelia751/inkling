import { describe, expect, it } from "vitest";
import { isCreationIntent, resolveIntent, termPattern } from "../src/intents.ts";
import { presetRefs } from "../src/catalog.ts";
import { catalog, environmentSchema, intents } from "./fixtures.ts";

describe("isCreationIntent (todo11 D5)", () => {
  it.each([
    ["Can you explain what pneumothorax means?", "none"],
    ["explain what pneumothorax means", "none"],
    ["What is a Studio?", "none"],
    ["Make sure the labels are right", "none"],
    ["Don't create a Studio yet, just list the files", "none"],
    ["What's new in this project?", "none"],
    ["Could we make a chest X-ray Studio?", "offer"],
    ["can you set up a CT task?", "offer"],
    ["How do I build a Studio for these videos?", "offer"],
    ["Create a chest X-ray Studio with five classification labels.", "create"],
    ["make me a CT studio", "create"],
    ["Please set up an ECG task for these recordings", "create"],
    ["Build a pathology studio", "create"],
  ] as const)("%s → %s", (text, want) => {
    expect(isCreationIntent(text, intents)).toBe(want);
  });
});

describe("resolveIntent", () => {
  it.each([
    ["Create a chest X-ray Studio with five classification labels", "preset:image-2d"],
    ["radiographs of the hand", "preset:image-2d"],
    ["CXR triage", "preset:image-2d"],
    ["a CT liver studio", "preset:volume-3d"],
    ["brain MRI segmentation", "preset:volume-3d"],
    ["cardiac MRI cine", "preset:cine-4d"],
    ["12-lead ECGs", "preset:ecg"],
    ["EKG rhythm strips", "preset:ecg"],
    ["label these videos", "preset:video"],
    ["drone footage of traffic", "preset:drone-video-tracks"],
    ["whole-slide histology", "preset:pathology"],
    ["satellite tiles of the city", "preset:satellite-tiles"],
    ["named entities in clinical notes", "preset:ner"],
    ["accelerometer recordings", "preset:sensor-timeseries-events"],
  ] as const)("%s → %s", (text, preset) => {
    expect(resolveIntent(text, intents)?.preset).toBe(preset);
  });

  it("returns null for unrelated text", () => {
    expect(resolveIntent("hello there", intents)).toBeNull();
  });

  it("is word-bounded and case-insensitive", () => {
    expect(termPattern("ct").test("a CT scan")).toBe(true);
    expect(termPattern("ct").test("select the object")).toBe(false);
    expect(termPattern("x-ray").test("XRAYS")).toBe(true);
    expect(termPattern("x-ray").test("x ray")).toBe(true);
    expect(termPattern("mr").test("Mrs Smith")).toBe(false);
  });

  it("uses file kinds", () => {
    expect(resolveIntent("", intents, { fileKinds: ["slide"] })?.preset).toBe("preset:pathology");
    expect(resolveIntent("set up a studio", intents, { fileKinds: ["video", "video"] })?.preset).toBe("preset:video");
  });

  it("only names presets that exist, and covers every one", () => {
    const known = presetRefs(catalog);
    const schemaEnum: string[] = environmentSchema.$defs.EnvironmentSpec.properties.extends.anyOf[0].enum;
    expect(known.sort()).toEqual([...schemaEnum].sort());
    const table = intents.intents.map((e) => e.preset);
    for (const p of table) expect(known).toContain(p);
    expect(new Set(table)).toEqual(new Set(known));
  });
});
