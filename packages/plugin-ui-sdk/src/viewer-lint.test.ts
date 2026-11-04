import { describe, expect, it } from "vitest";
import { VIEWER_MAX_BUNDLE_BYTES, lintViewerFiles, lintViewerSource, viewerLintOk } from "./viewer-lint";

const CLEAN = `
// A token-only viewer: #fff in a comment and fetch() in a comment don't count.
export default {
  async render({ model, el, host }) {
    const item = model.get("item");
    const box = document.createElement("div");
    box.className = "card";
    box.style.color = "var(--g-text-secondary)";
    box.style.fontFamily = "var(--font-mono)";
    const b = document.createElement("button");
    b.textContent = "Propose";
    b.addEventListener("click", () => host.annotations.propose([{ label: "x", geometry: { type: "class" } }]));
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.onclick = () => {};
    el.innerHTML = '<table><tr><th>Asset</th></tr></table><span class="badge" data-tone="ai">AI</span><a href="#top">top</a>';
    box.append(b, row);
    el.append(box);
    if (!item) el.innerHTML = '<div class="empty-state">No item</div>';
  },
};`;

const rules = (src: string) => lintViewerSource("viewer.js", src).map((f) => f.rule);

describe("viewer-lint", () => {
  it("passes a clean, token-only viewer", () => {
    expect(lintViewerSource("viewer.js", CLEAN)).toEqual([]);
  });

  it("fails raw colours", () => {
    const f = lintViewerSource("viewer.js", 'export function render({ el }) {\n  el.style.color = "#ff0000";\n  el.style.background = "rgb(0, 0, 0)";\n  el.innerHTML = `<p style="border-color: hsl(10 50% 50%)">x</p>`;\n}');
    expect(f.map((x) => [x.rule, x.line])).toEqual([["raw-colour", 2], ["raw-colour", 3], ["raw-colour", 4]]);
    expect(f[0]).toEqual({ rule: "raw-colour", file: "viewer.js", line: 2, message: expect.stringContaining("#ff0000"), severity: "error" });
    expect(viewerLintOk(f)).toBe(false);
  });

  it("fails px fonts and font families outside the tokens", () => {
    expect(rules('el.style.fontSize = "14px"; el.innerHTML = "<p style=\\"font-family: Comic Sans\\">";')).toEqual(["raw-font", "raw-font"]);
    expect(rules('el.style.fontFamily = "var(--font-sans)"')).toEqual([]);
  });

  it("fails network APIs", () => {
    expect(rules('export async function render() { const r = await fetch("/x"); }')).toEqual(["network"]);
    expect(rules("new WebSocket(u); new XMLHttpRequest(); new EventSource(u); navigator.sendBeacon(u, d);")).toEqual(["network", "network", "network", "network"]);
    expect(rules('const m = await import("https://cdn.example/x.js");')).toEqual(["network"]);
    expect(rules('import x from "https://cdn.example/x.js";')).toEqual(["network"]);
  });

  it("fails eval and new Function", () => {
    expect(rules('eval("1+1")')).toEqual(["eval"]);
    expect(rules('const f = new Function("return 1")')).toEqual(["eval"]);
    expect(rules('setTimeout("alert(1)", 10)')).toEqual(["eval"]);
  });

  it("fails click handlers on elements a keyboard can't reach", () => {
    expect(rules('const d = document.createElement("div");\nd.addEventListener("click", go);')).toEqual(["keyboard"]);
    expect(rules('el.innerHTML = `<span onclick="go()">x</span>`')).toEqual(["keyboard"]);
    expect(rules('el.innerHTML = `<span tabindex="0" role="button" onclick="go()">x</span>`')).toEqual([]);
  });

  it("caps the bundle at 2 MB, WASM included", () => {
    const f = lintViewerFiles([{ path: "viewer.js", content: CLEAN }, { path: "decoder.wasm", bytes: VIEWER_MAX_BUNDLE_BYTES }], { root: "ui" });
    expect(f).toEqual([expect.objectContaining({ rule: "bundle-size", file: "ui", line: 0, severity: "error" })]);
    expect(lintViewerFiles([{ path: "viewer.js", content: new TextEncoder().encode(CLEAN) }])).toEqual([]);
  });
});
