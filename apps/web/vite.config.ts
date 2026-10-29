import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { seedServer } from "./dev/seed-server";

export default defineConfig({
  plugins: [react(), tailwindcss(), seedServer(path.resolve(__dirname, "../../seed-data"))],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
