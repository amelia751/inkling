import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AiIcon, CleanupIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { notify } from "@/studio/lib/files/announce";
import { changesUrl, settingsUrl } from "@/studio/lib/routes";
import { isMissingRoute, problemText } from "@/studio/lib/governance-problem";
import {
  fixFinding,
  governanceKeys,
  groupFindings,
  promoteRule,
  rulesSourceLine,
  startGardener,
  useFindings,
  useRules,
  wouldHaveRejectedRows,
  writesLine,
  type Finding,
} from "@/studio/lib/governance-api";
import { FindingLine } from "./ChangesPage";

const countLine = (n: number, word: string) => `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;

export const HEALTH_CLEAN = "This project follows its rules.";

/**
 * Health on the project Overview (todo17 M3, D10): what's stored that breaks the rules. Counts by
 * severity, findings grouped by rule, one-click fixes, "would have rejected" for rules still in
 * evaluate mode (with Promote), and the gardener. Hidden while the API has no findings route.
 */
export function HealthPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const findings = useFindings(projectId);
  const rules = useRules(projectId);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: governanceKeys.findings(projectId) });
    void qc.invalidateQueries({ queryKey: governanceKeys.rules(projectId) });
    void qc.invalidateQueries({ queryKey: ["changes", projectId] });
  };
  const fix = useMutation({
    mutationFn: (f: Finding) => fixFinding(projectId, f.id ?? ""),
    onMutate: (f) => setBusy(f.id ?? null),
    onSuccess: (r) =>
      "changeRequest" in r
        ? notify(`Opened change request: ${r.changeRequest.title}`, { group: "health", tone: "success" })
        : notify("Fixed", { group: "health", tone: "success" }),
    onError: (e) => notify(problemText(e), { group: "health", tone: "error" }),
    onSettled: () => {
      setBusy(null);
      refresh();
    },
  });
  const promote = useMutation({
    mutationFn: (rule: string) => promoteRule(projectId, rule, "error"),
    onSuccess: () => notify("Promoted to error: writes that break it are rejected now", { group: "health", tone: "success" }),
    onError: (e) => notify(problemText(e), { group: "health", tone: "error" }),
    onSettled: refresh,
  });
  const gardener = useMutation({
    mutationFn: () => startGardener(projectId),
    onSuccess: (r) => {
      const n = r.changeRequests?.length ?? r.opened;
      notify(n === undefined ? "The gardener is tidying up. Its changes wait in Changes." : n === 0 ? "Nothing for the gardener to tidy" : `The gardener opened ${n} change ${n === 1 ? "request" : "requests"}`, { group: "health", tone: "success" });
    },
    onError: (e) => notify(problemText(e), { group: "health", tone: "error" }),
    onSettled: refresh,
  });

  if (findings.error && isMissingRoute(findings.error)) return null;
  const data = findings.data;
  const groups = data ? groupFindings(data.findings) : [];
  const rejected = data ? wouldHaveRejectedRows(data.wouldHaveRejected) : [];
  const source = rulesSourceLine(rules.data);

  return (
    <section aria-labelledby="health-heading" data-testid="health">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 id="health-heading" className="text-body-2 font-semibold">Health</h2>
          {data && (
            <span className="flex gap-1.5" data-testid="health-counts">
              <Badge theme="danger" data-testid="health-count-error">{countLine(data.counts.error, "error")}</Badge>
              <Badge theme="warning" data-testid="health-count-warn">{countLine(data.counts.warn, "warning")}</Badge>
              <Badge theme="info" data-testid="health-count-info">{data.counts.info.toLocaleString()} info</Badge>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link to={changesUrl(projectId)} className="text-sm text-brand hover:underline">Changes</Link>
          <Button variant="outline" size="sm" disabled={gardener.isPending || !groups.length} onClick={() => gardener.mutate()} data-testid="health-gardener">
            <AiIcon /> Tidy with the gardener
          </Button>
        </div>
      </div>
      {source && (
        <p className="mb-2 text-sm text-muted-foreground" data-testid="health-rules-source">
          {source}. <Link to={settingsUrl(projectId, "rules")} className="text-brand hover:underline">Customise</Link>
        </p>
      )}
      {findings.error ? (
        <p className="text-sm text-muted-foreground">Couldn't check this project's health: {problemText(findings.error)}</p>
      ) : !data ? (
        <Skeleton className="h-20 w-full rounded-lg" />
      ) : (
        <div className="flex flex-col gap-3">
          {rejected.length > 0 && (
            <Card className="divide-y divide-border overflow-hidden" data-testid="health-evaluate">
              {rejected.map((r) => (
                <div key={r.rule} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm" data-testid="health-would-reject" data-rule={r.rule}>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{r.title}</span>
                    <span className="block text-muted-foreground">{writesLine(r.count)} · in evaluate mode</span>
                  </span>
                  <Button variant="outline" size="sm" disabled={promote.isPending} onClick={() => promote.mutate(r.rule)} data-testid="health-promote">
                    Promote to error
                  </Button>
                </div>
              ))}
            </Card>
          )}
          {groups.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="health-clean">
              <CleanupIcon className="size-4 text-positive" /> {HEALTH_CLEAN}
            </p>
          ) : (
            groups.map((g) => (
              <Card key={g.rule} className="overflow-hidden" data-testid="health-group" data-rule={g.rule}>
                <div className="flex items-center gap-2 border-b border-border bg-generic/50 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{g.title}</span>
                  <span className="font-mono text-code text-muted-foreground">{g.rule}</span>
                  <Badge theme="unknown">{g.findings.length.toLocaleString()}</Badge>
                </div>
                <div className="divide-y divide-border">
                  {g.findings.slice(0, 20).map((f, i) => (
                    <FindingLine
                      key={f.id ?? i}
                      finding={f}
                      hideRule
                      action={
                        f.fixable && f.id ? (
                          <Button variant="ghost" size="sm" disabled={fix.isPending && busy === f.id} onClick={() => fix.mutate(f)} data-testid="health-fix">
                            Fix
                          </Button>
                        ) : null
                      }
                    />
                  ))}
                  {g.findings.length > 20 && <p className="px-4 py-2 text-sm text-muted-foreground">And {(g.findings.length - 20).toLocaleString()} more.</p>}
                </div>
              </Card>
            ))
          )}
        </div>
      )}
    </section>
  );
}
