import { useState } from "react";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { WarningIcon } from "@studio/ui/icons";
import type { InstallRequest, PlanItem } from "@/studio/lib/plugins-api";

/**
 * The install-review dialog (docs/plugins.md §7.2 Approve): the full diff a user approves
 * before anything is activated in this workspace — modules, permissions, secrets, egress
 * hosts, estimated spend, data residency, UI surfaces and licences. Optional permissions
 * are opt-in; required ones come with the plugin. Approving activates in this workspace only.
 */
export function InstallReview({
  request,
  open,
  busy,
  onApprove,
  onReject,
  onOpenChange,
}: {
  request: InstallRequest | null;
  open: boolean;
  busy?: boolean;
  onApprove: (grantOptional: string[]) => void;
  onReject: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [optional, setOptional] = useState<string[]>([]);
  if (!request) return null;
  const { plan } = request;
  const blocked = plan.errors.length > 0 || plan.conflicts.length > 0 || request.state === "REJECTED";
  const target = plan.install.find((i) => i.id === request.pluginId);
  const toggle = (p: string) => setOptional((o) => (o.includes(p) ? o.filter((x) => x !== p) : [...o, p]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="install-review">
        <DialogHeader>
          <DialogTitle>
            Install {request.pluginId}@{request.version}
          </DialogTitle>
          <DialogDescription>
            Review what this changes in this workspace. Nothing runs until you approve, and you can roll it back later.
          </DialogDescription>
        </DialogHeader>

        {blocked && (
          <div className="space-y-1 rounded-md bg-warning-tint p-3 text-sm text-warning" role="alert">
            {[...plan.errors.map((e) => e.message), ...plan.conflicts.map((c) => c.message), ...((request.checks?.rejected as string[] | undefined) ?? [])].map((m, i) => (
              <p key={i} className="flex gap-1.5"><WarningIcon className="mt-0.5 size-4 shrink-0" />{m}</p>
            ))}
          </div>
        )}

        <div className="space-y-4 text-sm">
          {plan.install.map((item) => (
            <PlanSection key={item.id} item={item} primary={item.id === request.pluginId} optional={optional} onToggle={toggle} />
          ))}
          {target && plan.risk === "high" && (
            <p className="text-muted-foreground">This installs {target.newCode ? "new code" : "code"} or permissions the workspace hasn't approved before, so it needs your approval.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onReject} disabled={busy}>Reject</Button>
          <Button onClick={() => onApprove(optional)} disabled={busy || blocked || request.state !== "AWAITING_APPROVAL"} data-testid="approve-install">
            Approve and activate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanSection({ item, primary, optional, onToggle }: { item: PlanItem; primary: boolean; optional: string[]; onToggle: (p: string) => void }) {
  const rows: [string, React.ReactNode][] = [
    ["Modules", item.modules.join(", ")],
    ["Runtime", item.runtime],
    ["Artifact", <code key="d" className="font-mono text-code">{item.artifactDigest.slice(0, 19)}…</code>],
    ["Required permissions", item.permissions.required.length ? <Chips key="r" items={item.permissions.required} granted={item.permissions.alreadyGranted} /> : "none"],
    ["Secrets", item.secrets.length ? item.secrets.join(", ") : "none"],
    ["Network egress", item.egress.length ? item.egress.join(", ") : "none"],
    ["Data residency", item.dataResidency.join(", ")],
    ["UI surfaces", item.uiSurfaces.length ? item.uiSurfaces.join(", ") : "none"],
    ["Estimated spend", spend(item)],
    ["Licences", licences(item)],
  ];
  return (
    <section className="rounded-lg border border-border p-3" aria-label={item.id}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium">{item.id}</span>
        <span className="text-muted-foreground">{item.version}</span>
        <Badge theme={item.trustTier === "generated" ? "warning" : item.trustTier === "first-party" ? "info" : "normal"}>{item.trustTier}</Badge>
        {item.newCode && <Badge theme="warning">new code</Badge>}
        {!primary && <Badge theme="clear">dependency</Badge>}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {item.codeDiff && <CodeDiff diff={item.codeDiff} />}
      {primary && item.permissions.optional.length > 0 && (
        <fieldset className="mt-3 space-y-1.5">
          <legend className="mb-1 text-muted-foreground">Optional permissions (grant only what you need)</legend>
          {item.permissions.optional.map((p) => (
            <label key={p} className="flex items-center gap-2">
              <Checkbox checked={optional.includes(p) || item.permissions.alreadyGranted.includes(p)} disabled={item.permissions.alreadyGranted.includes(p)} onCheckedChange={() => onToggle(p)} />
              <code className="font-mono text-code">{p}</code>
            </label>
          ))}
        </fieldset>
      )}
    </section>
  );
}

/** Agent-authored code (§9): the reviewer sees every changed file before anything runs. */
function CodeDiff({ diff }: { diff: NonNullable<PlanItem["codeDiff"]> }) {
  const files = [...diff.added.map((f) => `+ ${f}`), ...diff.changed.map((f) => `~ ${f}`), ...diff.removed.map((f) => `- ${f}`)];
  return (
    <details className="mt-3" open data-testid="install-code-diff">
      <summary className="cursor-pointer text-muted-foreground">
        Code changes against {diff.base}: {files.length} file{files.length === 1 ? "" : "s"}
      </summary>
      <p className="mt-1 font-mono text-code text-muted-foreground">{files.join("  ")}</p>
      <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-generic p-2.5 font-mono text-code whitespace-pre">
        {diff.diff.split("\n").map((line, i) => (
          <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "text-positive" : line.startsWith("-") && !line.startsWith("---") ? "text-danger" : undefined}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
      {diff.truncated && <p className="mt-1 text-muted-foreground">The diff is truncated; the full package is in the artifact store.</p>}
    </details>
  );
}

function Chips({ items, granted }: { items: string[]; granted: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((p) => (
        <Badge key={p} theme={granted.includes(p) ? "success" : "normal"}>{p}</Badge>
      ))}
    </span>
  );
}

function spend(item: PlanItem): string {
  const priced = item.providers.filter((p) => p.pricing);
  const budget = item.estimatedSpend.defaultBudgetUsdPerJob;
  if (!priced.length) return budget !== undefined ? `no billable providers; budget $${budget}/job` : "no billable providers";
  const per = priced.map((p) => `${p.id}: $${p.pricing!.usdPerUnit}/${p.pricing!.unit} (as of ${p.pricing!.effectiveAt})`).join("; ");
  return `${per}${budget !== undefined ? `; budget $${budget}/job` : ""}`;
}

function licences(item: PlanItem): string {
  const code = (item.licenses.code as string | undefined) ?? "unknown";
  const models = item.providers.filter((p) => p.modelLicense).map((p) => `${p.id} model: ${p.modelLicense}`);
  const terms = item.providers.filter((p) => p.serviceTerms).map((p) => `${p.id} terms: ${p.serviceTerms}`);
  return [`code: ${code}`, ...models, ...terms].join(" · ");
}
