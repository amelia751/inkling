import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import * as I from "./packages/ui/src/illustrations/index.tsx";
import { readFileSync, writeFileSync } from "node:fs";
const css = readFileSync("apps/web/src/studio/styles/globals.css", "utf8");
const vars = (sel: string) => { const i = css.indexOf(sel); return css.slice(i, css.indexOf("\n}", i) + 2); };
const ours = Object.entries(I).map(([n, C]) => `<figure>${renderToStaticMarkup(h(C as any, { width: 160, height: 160 }))}<figcaption>${n.replace("Illustration", "")}</figcaption></figure>`).join("");
const nb = ["svg-404-0.svg", "svg-empty-2.svg"].map((f) => `<figure>${readFileSync("/tmp/gravity/nb-errors/" + f, "utf8")}<figcaption>Nebius ${f}</figcaption></figure>`).join("");
for (const theme of ["dark", "light"]) {
  writeFileSync(`/tmp/gravity/ill-${theme}.html`, `<style>${vars(":root {")}${vars(".dark {")} body{margin:0;padding:16px;font:12px sans-serif;background:${theme === "dark" ? "#1c1d21" : "#fff"};color:${theme === "dark" ? "#ccc" : "#333"}} figure{display:inline-block;margin:8px;text-align:center}</style><body class="${theme}"><div>${ours}</div><div>${nb}</div></body>`);
}
