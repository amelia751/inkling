import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// The config is bundled before aliases exist, so it reads the emitted copy of naming.ts.
import NAMING from "../../schemas/naming.json";

const repo = path.resolve(__dirname, "../..");

/** The one place the site reads the environment: `env("SITE_APP_URL")` → `<envPrefix>SITE_APP_URL`. */
const env = (key: string): string | undefined => process.env[`${NAMING.envPrefix}${key}`] || undefined;

export default defineConfig({
  // Where "Sign in" and "Start" go: the web app (apps/web). Baked in at build time.
  define: { __APP_URL__: JSON.stringify(env("SITE_APP_URL") ?? "http://localhost:5173") },
  plugins: [
    react(),
    tailwindcss(),
    { name: "site-title", transformIndexHtml: (html) => html.replaceAll("%DISPLAY_NAME%", NAMING.displayName) },
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
