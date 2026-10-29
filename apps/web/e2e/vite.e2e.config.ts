// Dev server for e2e runs: same as vite.config.ts but without HMR, so edits other people
// make to the working tree mid-run can't hot-swap or reload the page under a test.
import { mergeConfig } from "vite";
import base from "../vite.config";

export default mergeConfig(base, { server: { hmr: false } });
