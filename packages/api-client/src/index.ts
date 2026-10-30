import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema";

export type { paths, components } from "./schema";

/**
 * A typed client for the kernel (apps/api). `paths` is generated from `schemas/api/openapi.json`
 * (`pnpm --filter @studio/api-client generate`), which `apps/api/scripts/dump_openapi.py` writes,
 * so this package depends on the schema, never on the app.
 */
export function createApiClient(options: ClientOptions = {}) {
  return createClient<paths>({ baseUrl: "", ...options });
}
