/**
 * The agent's `/v1/internal/*` routes (todo14 D9: deleting an org's or a member's conversations) are
 * service-to-service only; the browser proxy must never forward them. Same rule as the
 * `location ^~ /api/agent/internal` block in nginx/default.conf.template. The agent refuses them
 * anyway when they come through a proxy (it sees X-Agent-Service-Token); this keeps them unreachable.
 */
export function isAgentInternal(url: string | undefined): boolean {
  if (!url) return false;
  let path: string;
  try {
    // Decode and resolve `.`/`..` and `//` the way the agent's router will.
    path = new URL(decodeURIComponent(url.split(/[?#]/)[0]!), "http://proxy").pathname.replace(/\/{2,}/g, "/");
  } catch {
    return true; // Undecodable: refuse rather than guess.
  }
  return /^\/api\/agent\/internal(\/|$)/i.test(path);
}
