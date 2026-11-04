import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// The config is bundled before aliases exist, so it reads the emitted copy of naming.ts.
import NAMING from "../../schemas/naming.json";

const repo = path.resolve(__dirname, "../..");

/** The one place the site reads the environment: `env("SITE_APP_URL")` → `<envPrefix>SITE_APP_URL`. */
const env = (key: string): string | undefined => process.env[`${NAMING.envPrefix}${key}`] || undefined;

const appUrl = env("SITE_APP_URL") ?? "http://localhost:5173";

export default defineConfig({
  // Where "Sign in" and "Start" go: the web app (apps/web). The image's nginx fills it in at
  // request time (%APP_URL% in index.html); this is the fallback when nothing did.
  define: { __APP_URL__: JSON.stringify(appUrl) },
  plugins: [
    react(),
    tailwindcss(),
    {
      // The dev server fills the placeholders; a build keeps them for nginx (nginx/default.conf.template).
      name: "site-placeholders",
      transformIndexHtml: (html, ctx) =>
        ctx.server ? html.replaceAll("%DISPLAY_NAME%", NAMING.displayName).replaceAll("%APP_URL%", appUrl) : html,
    },
  ],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, "src") + "/$1" },
      { find: /^@studio\/([^/]+)$/, replacement: path.join(repo, "packages/$1/src/index.ts") },
      { find: /^@studio\/([^/]+)\/(.*)$/, replacement: path.join(repo, "packages/$1/src/$2") },
    ],
  },
  server: { port: 5180 },
  preview: { port: 5180 },
});
