import { readFileSync } from "node:fs";
import type { CreateSandboxFromSnapshotParams, Sandbox } from "@daytona/sdk";
import { type Exec, ExecSandboxHandle } from "./exec-handle.ts";
import type { SandboxProvider } from "./provider.ts";

/**
 * `AGENT_SANDBOX=gke` (todo10 D9 trial): build sandboxes from kubernetes-sigs/agent-sandbox on
 * GKE Sandbox (gVisor), in `AGENT_SANDBOX_GKE_NAMESPACE` from the `AGENT_SANDBOX_GKE_TEMPLATE`
 * SandboxTemplate (infra/k8s/overlays/gke/ai/sandboxes: warm pool, deny-all NetworkPolicy, no
 * service-account token, read-only root with a writable /workspace). The agent drives them only
 * through the Kubernetes API: a SandboxClaim per sandbox, pods/exec for commands and file copy.
 * It never talks to a sandbox over the pod network (there is none).
 *
 * API versions follow agent-sandbox v0.1 (`extensions.agents.x-k8s.io/v1alpha1`); a claim's
 * sandbox (and pod) name is `status.sandbox.Name`, or the claim's own name before adoption.
 */

export interface K8sClient {
  get(path: string): Promise<any | undefined>;
  create(path: string, body: unknown): Promise<any>;
  delete(path: string): Promise<void>;
  exec(namespace: string, pod: string, container: string, argv: string[], opts?: { stdin?: Buffer; timeoutS?: number }): Promise<{ exitCode: number; stdout: Buffer }>;
}

export interface GkeOptions {
  namespace: string;
  template: string;
  container?: string;
  /** The writable root in the template (`/workspace`); tool paths under the Daytona home map there. */
  home?: string;
  client: K8sClient;
  readyTimeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

const CLAIMS = (ns: string) => `/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/${encodeURIComponent(ns)}/sandboxclaims`;
const POD = (ns: string, name: string) => `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(name)}`;

export class GkeSandboxProvider implements SandboxProvider {
  readonly kind = "gke" as const;
  constructor(private readonly o: GkeOptions) {}

  canBlockNetwork(): boolean {
    return true; // the namespace's deny-all NetworkPolicy, whatever the claim asks
  }

  private async podOf(claimName: string): Promise<{ pod: string; phase: string } | undefined> {
    const claim = await this.o.client.get(`${CLAIMS(this.o.namespace)}/${encodeURIComponent(claimName)}`);
    if (!claim) return undefined;
    const pod = String(claim.status?.sandbox?.Name ?? claim.status?.sandbox?.name ?? claimName);
    const p = await this.o.client.get(POD(this.o.namespace, pod));
    return { pod, phase: String(p?.status?.phase ?? "Pending") };
  }

  private handle(claimName: string, pod: string, labels: Record<string, string>): Sandbox {
    const exec: Exec = (argv, opts) => this.o.client.exec(this.o.namespace, pod, this.o.container ?? "sandbox", argv, opts);
    return new ExecSandboxHandle(claimName, claimName, labels, exec, {
      refresh: async () => {
        const s = await this.podOf(claimName);
        return !s ? "destroyed" : s.phase === "Running" ? "started" : s.phase === "Pending" ? "starting" : "destroyed";
      },
      delete: () => this.o.client.delete(`${CLAIMS(this.o.namespace)}/${encodeURIComponent(claimName)}`),
    }, this.o.home ?? "/workspace") as unknown as Sandbox;
  }

  async get(idOrName: string): Promise<Sandbox | undefined> {
    const claim = await this.o.client.get(`${CLAIMS(this.o.namespace)}/${encodeURIComponent(idOrName)}`);
    if (!claim) return undefined;
    const s = await this.podOf(idOrName);
    if (!s || (s.phase !== "Running" && s.phase !== "Pending")) return undefined;
    return this.handle(idOrName, s.pod, claim.metadata?.labels ?? {});
  }

  async create(params: CreateSandboxFromSnapshotParams): Promise<Sandbox> {
    const name = (params.name ?? `sandbox-${Date.now()}`).toLowerCase().slice(0, 63);
    const labels = params.labels ?? {};
    // No env, no secrets, no network fields: the template decides all of that.
    await this.o.client.create(CLAIMS(this.o.namespace), {
      apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
      kind: "SandboxClaim",
      metadata: { name, labels },
      spec: { sandboxTemplateRef: { name: this.o.template } },
    });
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.o.readyTimeoutS ?? 120) * 1000;
    for (;;) {
      const s = await this.podOf(name);
      if (s?.phase === "Running") return this.handle(name, s.pod, labels);
      if (s && (s.phase === "Failed" || s.phase === "Succeeded")) throw new Error(`sandbox ${name} ended (${s.phase}) before it was ready`);
      if (Date.now() > deadline) {
        await this.o.client.delete(`${CLAIMS(this.o.namespace)}/${encodeURIComponent(name)}`).catch(() => {});
        throw new Error(`sandbox ${name} wasn't ready within ${this.o.readyTimeoutS ?? 120}s`);
      }
      await sleep(500);
    }
  }
}

// ---- The in-cluster client (the agent pod's service account) ----------------------------------

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * REST over `fetch` and exec over WebSocket (`v5.channel.k8s.io`), with the pod's service-account
 * token. The API server's CA must be trusted by Node: set `NODE_EXTRA_CA_CERTS` to
 * `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` in the agent's Deployment.
 */
export class InClusterK8s implements K8sClient {
  private readonly base: string;
  constructor(base = "https://kubernetes.default.svc:443") {
    this.base = base;
  }

  private token(): string {
    return readFileSync(`${SA}/token`, "utf8").trim(); // projected tokens rotate: read each time
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token()}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async get(path: string) {
    const r = await this.call("GET", path);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`kubernetes GET ${path.split("/").slice(-2).join("/")} → ${r.status}`);
    return r.json();
  }

  async create(path: string, body: unknown) {
    const r = await this.call("POST", path, body);
    if (!r.ok) throw new Error(`kubernetes create → ${r.status}`);
    return r.json();
  }

  async delete(path: string) {
    const r = await this.call("DELETE", path);
    if (!r.ok && r.status !== 404) throw new Error(`kubernetes delete → ${r.status}`);
  }

  exec(namespace: string, pod: string, container: string, argv: string[], opts: { stdin?: Buffer; timeoutS?: number } = {}) {
    const q = new URLSearchParams({ container, stdout: "true", stderr: "false", stdin: opts.stdin ? "true" : "false" });
    for (const a of argv) q.append("command", a);
    const url = `${this.base.replace(/^http/, "ws")}${POD(namespace, pod)}/exec?${q}`;
    // The bearer token rides in a subprotocol (browsers' WebSocket can't set headers; Node's neither).
    const bearer = `base64url.bearer.authorization.k8s.io.${Buffer.from(this.token()).toString("base64url")}`;
    return new Promise<{ exitCode: number; stdout: Buffer }>((resolve, reject) => {
      const ws = new WebSocket(url, ["v5.channel.k8s.io", bearer]);
      ws.binaryType = "arraybuffer";
      const out: Buffer[] = [];
      let status: any;
      const timer = opts.timeoutS ? setTimeout(() => ws.close(), opts.timeoutS * 1000) : undefined;
      ws.onopen = () => {
        if (opts.stdin) {
          ws.send(Buffer.concat([Buffer.from([0]), opts.stdin]));
          ws.send(Buffer.from([255, 0])); // v5: close stdin
        }
      };
      ws.onmessage = (e) => {
        const b = Buffer.from(e.data as ArrayBuffer);
        if (b[0] === 1) out.push(b.subarray(1));
        else if (b[0] === 3) status = JSON.parse(b.subarray(1).toString() || "{}");
      };
      ws.onerror = () => reject(new Error("kubernetes exec failed"));
      ws.onclose = () => {
        clearTimeout(timer);
        resolve({ exitCode: execExitCode(status), stdout: Buffer.concat(out) });
      };
    });
  }
}

/** The exit code from an exec status object (channel 3). */
export function execExitCode(status: any): number {
  if (!status || status.status === "Success") return status ? 0 : 137;
  const cause = (status.details?.causes ?? []).find((c: any) => c.reason === "ExitCode");
  return cause ? Number(cause.message) || 1 : 1;
}
