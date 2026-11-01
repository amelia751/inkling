import { loadRuntimeConfig } from "@/extension-host/runtime-config";
import { loadFeatures } from "@/studio/lib/features";
import "@/studio/styles/globals.css";

// Runtime settings first (todo/done/todo3.md D.1: nothing is baked into the bundle), then the
// product's feature flags (todo13 §7.1, bounded wait), then the app: plugin manifests and
// extension flags are read when boot.tsx's imports evaluate.
void loadRuntimeConfig()
  .then(() => loadFeatures())
  .then(() => import("./boot"));
