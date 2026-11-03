/**
 * Which stores the dev server may use (todo22 W5, D1). In `workos` mode (every signed-in stage,
 * and `pnpm dev:signin`) every save goes to the kernel: the API must be set, and the seed
 * server's file stores (`<envPrefix>WEB_ANNOTATIONS_DIR`, `seed-data/.annotations`,
 * `seed-data/.resume`) can't be selected. Throws with the reason; vite.config.ts calls it at load.
 */
export function checkDevStores({ envPrefix, authMode, apiUrl, annotationsDir }: { envPrefix: string; authMode: "dev" | "workos"; apiUrl?: string; annotationsDir?: string }): void {
  if (authMode !== "workos") return;
  if (!apiUrl) throw new Error(`${envPrefix}WEB_AUTH_MODE=workos needs ${envPrefix}API_URL (the API answers /api/auth/verify and keeps every save)`);
  if (annotationsDir) throw new Error(`${envPrefix}WEB_ANNOTATIONS_DIR is a dev-mode store; with ${envPrefix}WEB_AUTH_MODE=workos annotations are saved to the API`);
}
