import { defineConfig } from "vitest/config";
import { aliases } from "./aliases";

// Unit tests for the extension host (registry, resolver, when-clauses), packages and plugins. Kept apart from
// vite.config.ts so tests don't start the seed server or pull in Cornerstone's build tweaks.
export default defineConfig({
  resolve: { alias: aliases },
  // Plugin components (.tsx) are rendered in tests; use the automatic JSX runtime like the app.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "../../packages/*/src/**/*.test.ts", "../../plugins/*/ui/**/*.test.ts"],
    // Binds the plugin host API to the Studio store, as the app does at boot.
    setupFiles: ["./vitest.setup.ts"],
    coverage: { provider: "v8", include: ["src/extension-host/**", "../../packages/*/src/**", "../../plugins/*/ui/**"] },
  },
});
