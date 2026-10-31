/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) and content hashes (todo10 Phase 1).
 *
 * Environments and lockfiles are identified by `sha256:<hex>` of their canonical form, so the
 * same definition always hashes the same, in the browser, in Node and in the kernel
 * (`apps/api/src/studio_api/kernel/canonical.py`, checked against the same vectors in
 * `packages/contracts/test-vectors/canonical.json`).
 *
 * - objects: members sorted by the UTF-16 code units of their names, no whitespace;
 * - strings: ECMAScript `JSON.stringify` escaping;
 * - numbers: ECMAScript `Number.prototype.toString` (shortest round trip; `-0` is `0`);
 *   NaN and ±Infinity aren't JSON and throw.
 * `undefined` members are dropped (as `JSON.stringify` does); `undefined` in an array is an error.
 */

export function canonicalize(value: unknown): string {
  return write(value, "$");
}

function write(v: unknown, at: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError(`${at}: ${v} isn't a JSON number`);
      return Object.is(v, -0) ? "0" : String(v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x, i) => (x === undefined ? fail(`${at}[${i}]`) : write(x, `${at}[${i}]`))).join(",")}]`;
      const o = v as Record<string, unknown>;
      // Default sort compares UTF-16 code units, which is what RFC 8785 §3.2.3 asks for.
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(o[k], `${at}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`${at}: a ${typeof v} isn't JSON`);
  }
}

function fail(at: string): never {
  throw new TypeError(`${at}: undefined isn't JSON`);
}

/** `sha256:<hex>` of the canonical UTF-8 bytes (WebCrypto: browsers and Node ≥ 19). */
export async function contentHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The parent hash of a task's first saved revision when it had no environment to start from. */
export const NULL_CONTENT_HASH = "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
