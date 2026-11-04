// Live check of the static gate against the real public metadata APIs (no sandbox, no model):
//   pnpm --filter @studio/agent exec tsx scripts/vet-live.ts pypi:backtrader npm:lightweight-charts
import { vetOss } from "../src/scout/vet.ts";
import { defaultFetcher } from "../src/scout/http.ts";

for (const arg of process.argv.slice(2)) {
  const [ecosystem, name, version] = arg.split(":") as ["npm" | "pypi", string, string | undefined];
  const e = await vetOss({ package: name, ecosystem, version }, { fetch: defaultFetcher });
  console.log(JSON.stringify({ package: e.package, version: e.version, licence: e.licence, decision: e.decision, scorecard: e.scorecard, advisories: e.advisories.length, deps: e.transitiveLicences.length, lastRelease: e.lastRelease, maintainers: e.maintainers, conditions: e.conditions, reasons: e.reasons }, null, 2));
}
