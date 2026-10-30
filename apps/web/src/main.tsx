import { loadRuntimeConfig } from "@/extension-host/runtime-config";
import "@/studio/styles/globals.css";

// Runtime settings first (todo/todo3.md D.1: nothing is baked into the bundle), then the app:
// plugin manifests and feature flags are read when boot.tsx's imports evaluate.
void loadRuntimeConfig().then(() => import("./boot"));
