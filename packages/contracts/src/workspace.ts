import * as z from "zod";
import { EnvironmentSpecSchema } from "./environment";
import { PluginId, Semver } from "./plugin-manifest";

/**
 * Per-workspace activation (todo2 Phase 3, docs/plugins.md §7.2 and §11): which plugin
 * versions are installed in a workspace and in what state. The web app activates exactly
 * the `active` ones; the kernel's Workspace API serves this document.
 */
export const INSTALL_STATES = ["REQUESTED", "RESOLVED", "STAGED", "VALIDATED", "AWAITING_APPROVAL", "ACTIVATED", "REJECTED", "DISABLED", "ROLLED_BACK"] as const;
export const InstallState = z.enum(INSTALL_STATES);
export type InstallState = z.infer<typeof InstallState>;

export const WorkspaceInstallation = z
  .object({
    pluginId: PluginId,
    version: Semver,
    artifactDigest: z.string().optional(),
    configRevision: z.number().int().nonnegative().default(0),
    state: InstallState,
  })
  .strict()
  .meta({ id: "WorkspaceInstallation" });
export type WorkspaceInstallation = z.infer<typeof WorkspaceInstallation>;

export const WorkspaceState = z
  .object({
    workspaceId: z.string().min(1),
    plugins: z.array(WorkspaceInstallation),
    environment: EnvironmentSpecSchema.optional(),
  })
  .strict()
  .meta({ id: "WorkspaceState" });
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/** Plugin ids a workspace runs (state ACTIVATED). */
export const activePluginIds = (w: Pick<WorkspaceState, "plugins">) => w.plugins.filter((p) => p.state === "ACTIVATED").map((p) => p.pluginId);
