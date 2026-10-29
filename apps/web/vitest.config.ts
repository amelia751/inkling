import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the platform (registry, resolver, when-clauses) and kits. Kept apart from
// vite.config.ts so tests don't start the seed server or pull in Cornerstone's build tweaks.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/platform/**", "src/kits/**", "src/modules/**"] },
  },
});
