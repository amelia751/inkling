import type { Config } from "../config.ts";
import { createDaytona } from "./client.ts";
import { DEFAULT_EGRESS, type EgressPolicy } from "./defaults.ts";
import { FakeProvider } from "./fake.ts";
import { GkeSandboxProvider, InClusterK8s, type K8sClient } from "./gke.ts";
import { LocalContainerProvider } from "./local.ts";
import { DaytonaProvider, type SandboxProvider } from "./provider.ts";

/** The configured provider (`AGENT_SANDBOX`), or undefined when sandboxes are off. */
export function createProvider(config: Config, deps: { egress?: () => EgressPolicy; k8s?: K8sClient } = {}): SandboxProvider | undefined {
  const s = config.sandbox;
  switch (s.provider) {
    case "daytona": {
      const daytona = createDaytona(config);
      return daytona ? new DaytonaProvider(daytona, { snapshot: s.snapshot, canBlock: () => (deps.egress?.() ?? DEFAULT_EGRESS).canOverride }) : undefined;
    }
    case "local":
      return s.local.image ? new LocalContainerProvider({ image: s.local.image, runtime: s.local.runtime, cli: s.local.cli }) : undefined;
    case "gke":
      return new GkeSandboxProvider({ namespace: s.gke.namespace, template: s.gke.template, client: deps.k8s ?? new InClusterK8s(s.gke.apiServer) });
    case "fake":
      return new FakeProvider(s.fakeDir);
    default:
      return undefined;
  }
}
