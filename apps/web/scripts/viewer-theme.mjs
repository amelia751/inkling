// Builds packages/plugin-ui-sdk/src/viewer-theme.generated.ts (todo23 W2) from the Studio theme
// (src/studio/styles/globals.css): the token names a sandboxed viewer may use, their light and dark
// values (defaults for hosts that send none), and the styled-element stylesheet the frame gets.
// The stylesheet uses only those variables. Called by emit-schemas.mjs (so `--check` covers it).

const TOKEN = /^--(g-|font-|radius-)/;

/** `--name: value;` declarations of the first top-level block whose selector is `selector`. */
function block(css, selector) {
  const start = css.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "m"));
  if (start < 0) throw new Error(`viewer-theme: no ${selector} block in globals.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const vars = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const pick = (vars) => Object.fromEntries(Object.entries(vars).filter(([k]) => TOKEN.test(k)).sort(([a], [b]) => a.localeCompare(b)));

/** Styled elements for viewers: plain tags plus a few classes, all on the theme variables. */
export const VIEWER_STYLES = `
:root{color-scheme:light}
:root[data-theme="dark"]{color-scheme:dark}
html,body{margin:0;padding:0;background:var(--g-background);color:var(--g-text-primary);font:13px/1.45 var(--font-sans)}
#viewer-root{min-height:120px;padding:12px;box-sizing:border-box}
*,*::before,*::after{box-sizing:border-box}
h1,h2,h3{margin:0 0 8px;font-weight:600;line-height:1.3}
h1{font-size:17px}h2{font-size:15px}h3{font-size:13px}
p{margin:0 0 8px}
small,.hint{font-size:12px;color:var(--g-text-secondary)}
code,pre,kbd{font-family:var(--font-mono);font-size:12px}
pre{margin:0;padding:8px;background:var(--g-ultralight);border:1px solid var(--g-line);border-radius:var(--radius-md);overflow:auto}
a{color:var(--g-text-brand)}
hr{border:0;border-top:1px solid var(--g-line);margin:12px 0}
:focus-visible{outline:2px solid var(--g-line-focus);outline-offset:1px}
button,.button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;font:inherit;font-weight:500;color:var(--g-text-primary);background:var(--g-generic);border:1px solid transparent;border-radius:var(--radius-md);cursor:pointer}
button:hover,.button:hover{background:var(--g-generic-hover)}
button:disabled{opacity:.5;cursor:default}
button.primary,button[data-variant="primary"]{background:var(--g-utility);color:var(--g-background)}
button.primary:hover,button[data-variant="primary"]:hover{background:var(--g-text-brand-heavy)}
button.outline,button[data-variant="outline"]{background:transparent;border-color:var(--g-line)}
button.danger,button[data-variant="danger"]{background:var(--g-danger-tint);color:var(--g-danger)}
input,select,textarea{height:28px;padding:0 8px;font:inherit;color:var(--g-text-primary);background:var(--g-background);border:1px solid var(--g-line);border-radius:var(--radius-md)}
textarea{height:auto;padding:6px 8px}
input:hover,select:hover,textarea:hover{border-color:var(--g-line-hover)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--g-line-focus)}
input[type="checkbox"],input[type="radio"],input[type="range"]{height:auto;accent-color:var(--g-utility)}
label{color:var(--g-text-complementary)}
table{width:100%;border-collapse:collapse}
th,td{padding:6px 8px;text-align:left;border-bottom:1px solid var(--g-line)}
th{font-weight:500;color:var(--g-text-secondary);background:var(--g-ultralight)}
tr:hover td{background:var(--g-generic)}
tr[aria-selected="true"] td{background:var(--g-selection)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
[role="tablist"],.tabs{display:flex;gap:4px;border-bottom:1px solid var(--g-line);margin-bottom:8px}
[role="tab"],.tab{height:32px;padding:0 10px;background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--g-text-secondary)}
[role="tab"]:hover,.tab:hover{background:transparent;color:var(--g-text-primary)}
[role="tab"][aria-selected="true"],.tab.active{color:var(--g-text-primary);border-bottom-color:var(--g-line-focus)}
.badge{display:inline-flex;align-items:center;height:20px;padding:0 6px;font-size:12px;border-radius:var(--radius-sm);background:var(--g-generic);color:var(--g-text-complementary)}
.badge[data-tone="info"]{background:var(--g-info-tint);color:var(--g-info)}
.badge[data-tone="positive"]{background:var(--g-positive-tint);color:var(--g-positive)}
.badge[data-tone="warning"]{background:var(--g-warning-tint);color:var(--g-warning)}
.badge[data-tone="danger"]{background:var(--g-danger-tint);color:var(--g-danger)}
.badge[data-tone="ai"]{background:var(--g-ai-tint);color:var(--g-ai-text)}
.card{padding:12px;background:var(--g-float);border:1px solid var(--g-line);border-radius:var(--radius-lg)}
.empty-state,.error-state,[data-viewer-error]{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:120px;padding:16px;text-align:center;color:var(--g-text-secondary)}
.error-state,[data-viewer-error]{color:var(--g-danger)}
.toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
`.trim();

/** The generated module's text, from globals.css's text. */
export function viewerThemeModule(css) {
  const light = pick(block(css, ":root"));
  const themeBlock = css.slice(css.search(/^@theme inline\s*\{/m));
  for (const [k, v] of Object.entries(block(themeBlock, "@theme inline"))) if (/^--radius-/.test(k)) light[k] = v;
  const sorted = Object.fromEntries(Object.entries(light).sort(([a], [b]) => a.localeCompare(b)));
  const dark = { ...sorted, ...pick(block(css, ".dark")) };
  const tokens = Object.keys(sorted);
  return `// Generated by \`pnpm emit:schemas\` (apps/web/scripts/viewer-theme.mjs) from
// apps/web/src/studio/styles/globals.css. Do not edit.

/** CSS variables a sandboxed viewer may use: the Studio theme's tokens. */
export const VIEWER_THEME_TOKENS = ${JSON.stringify(tokens, null, 2)} as const;
export type ViewerThemeToken = (typeof VIEWER_THEME_TOKENS)[number];

/** Token values per mode, used when the host sends none (e.g. outside the Studio). */
export const VIEWER_THEME_DEFAULTS: { light: Record<string, string>; dark: Record<string, string> } = ${JSON.stringify({ light: sorted, dark }, null, 2)};

/** Styled elements (buttons, inputs, tables, tabs, badges, empty and error states), on the tokens only. */
export const VIEWER_STYLES = ${JSON.stringify(VIEWER_STYLES)};
`;
}
