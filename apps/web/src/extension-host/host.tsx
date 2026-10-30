import type { ReactNode } from "react";
import { bindHost, HostProvider, type StudioHost } from "@studio/plugin-ui-sdk";
import { configureShortcuts } from "@studio/studio-ui/shortcuts";
import { ns } from "@studio/plugin-contracts/naming";
import { seedUrl } from "@/studio/lib/api";
import { useStudio } from "@/studio/stores/studio";
import { commandDef, commandId, execute, registerCommand, useCommands, useHotkeys } from "./commands";
import { describeGeometry, inspectRows } from "./describe";
import { connectKernel, kernelAssetUrl } from "./kernel";
import { registry } from "./registry";
import { resolveEnvironment } from "./resolve";

/**
 * The Studio's implementation of the plugin host API (packages/plugin-ui-sdk/src/host.ts),
 * backed by the shell's Zustand store and the extension host's registry and command bus.
 * Like bundled.ts, this file is a composition root: it may import the shell.
 */
export const studioHost: StudioHost = {
  store: useStudio,
  // Signed kernel Asset API URLs when the kernel is on, else the dev seed files.
  assetUrl: (path) => kernelAssetUrl(path) ?? seedUrl(path),
  useCommands,
  useHotkeys,
  execute,
  registerCommand,
  commandDef,
  commandId,
  describeGeometry,
  inspectRows,
  resolveSpec: (spec) => resolveEnvironment(spec, registry),
};

bindHost(studioHost);
// Plugin commands no local handler takes go to the kernel's command gateway.
connectKernel(useStudio);
// Shared UI primitives (tooltips, kbd chips) show the active binding of a command id.
configureShortcuts((id) => commandDef(id) ?? commandDef(ns(`core.commands.${id}`)));

/** Wraps the Studio route so plugin UI reads the host from context. */
export function StudioHostProvider({ children }: { children?: ReactNode }) {
  return <HostProvider host={studioHost}>{children}</HostProvider>;
}
