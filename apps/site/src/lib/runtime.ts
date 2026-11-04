import { configureNaming, NAMING } from "@studio/contracts/naming";

// index.html's <meta name="studio-site">, filled in by nginx per deployment. A value still in
// %PLACEHOLDER% form means nothing filled it (vite preview), so the built-in default stands.
const meta = document.querySelector<HTMLMetaElement>('meta[name="studio-site"]')?.dataset;
const filled = (v: string | undefined) => (v && !/^%[A-Z_]+%$/.test(v) ? v : undefined);

const displayName = filled(meta?.displayName);
if (displayName && displayName !== NAMING.displayName) configureNaming({ displayName });

export const APP_URL = filled(meta?.appUrl) ?? __APP_URL__;
