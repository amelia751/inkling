import * as z from "zod";
import { canonicalize, contentHash } from "./canonical";
import { PluginId, Semver } from "./plugin-manifest";

/**
 * `.studio/plugins.lock.json` (todo10 §3.2, Phase 1): the exact plugin versions a Studio runs,
 * pinned by digest. The kernel generates it from `workspace_plugins` (the ACTIVATED pins) at
 * `GET /api/environments/:taskId/lockfile`; it is committed next to the annotations it produced
 * and is what safe mode boots from (`last-known-good`).
 *
 * Entry fields are a contract between workstreams (todo10 §11); keep the names.
 * - `digest`: the artifact digest, `sha256:<hex>`.
 * - `signer`: who vouches for those bytes. `first-party` for bundled first-party plugins;
 *   otherwise the signer's key id as `<alg>:<keyId>` (the `Signer.key_id`), or `unsigned`.
 * - `permissions`: what the workspace GRANTED this version (sorted), not what it requested.
 * - `configRevision`: the pinned `workspace_plugin_configs` revision.
 */

export const LOCKFILE_VERSION = 1;
export const FIRST_PARTY_SIGNER = "first-party";
export const UNSIGNED = "unsigned";

export const ContentDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<64 hex>");

export const PluginLockEntry = z
  .object({
    id: PluginId,
    version: Semver,
    digest: ContentDigest,
    signer: z.string().min(1).max(256),
    permissions: z.array(z.string().min(1)),
    configRevision: z.number().int().nonnegative(),
  })
  .strict()
  .meta({ id: "PluginLockEntry" });
export type PluginLockEntry = z.infer<typeof PluginLockEntry>;

export const PluginsLock = z
  .object({
    lockfileVersion: z.literal(LOCKFILE_VERSION),
    plugins: z.array(PluginLockEntry),
  })
  .strict()
  .superRefine((l, ctx) => {
    const seen = new Set<string>();
    l.plugins.forEach((p, i) => {
      if (seen.has(p.id)) ctx.addIssue({ code: "custom", path: ["plugins", i, "id"], message: `${p.id} is locked twice` });
      seen.add(p.id);
    });
  })
  .meta({ id: "PluginsLock" });
export type PluginsLock = z.infer<typeof PluginsLock>;

/** The canonical lockfile: plugins sorted by id, permissions sorted and unique. */
export function normalizeLockfile(l: PluginsLock): PluginsLock {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    plugins: [...l.plugins].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((p) => ({ ...p, permissions: [...new Set(p.permissions)].sort() })),
  };
}

/** The lockfile's file text (`plugins.lock.json`): canonical JSON, so it hashes and diffs stably. */
export const serializeLockfile = (l: PluginsLock): string => canonicalize(normalizeLockfile(l));

export function parseLockfile(text: string): PluginsLock {
  return normalizeLockfile(PluginsLock.parse(JSON.parse(text)));
}

export const lockfileHash = (l: PluginsLock): Promise<string> => contentHash(normalizeLockfile(l));

/** Ids safe mode keeps: first-party only (todo10 §3.4). */
export const firstPartyIds = (l: PluginsLock): string[] => l.plugins.filter((p) => p.signer === FIRST_PARTY_SIGNER).map((p) => p.id);
