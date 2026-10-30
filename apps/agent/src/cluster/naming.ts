// Runtime resource names come from the shared naming config (todo/todo2.md D3); the JSON is
// inlined by the bundler, so the built service doesn't need the file at runtime.
import naming from "../../../../schemas/naming.json" with { type: "json" };
import pkg from "../../package.json" with { type: "json" };

/** Prefix for shared runtime resources (Redis keys and channels), e.g. `<prefix>:run:<id>`. */
export const RESOURCE_PREFIX: string = naming.resourcePrefix;

/** Brand-free service name used in logs, /version and traces. */
export const SERVICE_NAME = "agent";
export const SERVICE_VERSION: string = pkg.version;
