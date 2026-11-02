import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@studio/ui/ui/alert-dialog";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { DataTable, fmtDate, SettingsPage, type Column } from "@/studio/components/settings/kit";
import { relativeTime } from "@/studio/components/files";
import { notify } from "@/studio/lib/files/announce";
import { useConnectedAgents, useRevokeConnectedAgent, type ConnectedAgent } from "@/studio/lib/governance-api";
import { problemText } from "@/studio/lib/governance-problem";

export const AGENTS_EMPTY = "No connected agents.";

/**
 * Settings › Connected agents (todo17 M4): outside agents (Claude Code, Cursor…) signed in over
 * MCP to act for you. Revoke ends the connection; its next call gets 401.
 */
export function ConnectedAgentsPage() {
  const agents = useConnectedAgents();
  const revoke = useRevokeConnectedAgent();
  const [confirm, setConfirm] = useState<ConnectedAgent | null>(null);
  const rows = agents.data ?? [];
  const columns: Column<ConnectedAgent>[] = [
    { key: "name", label: "Agent", render: (a) => <span className="font-semibold" data-testid="agent-connection-name">{a.clientName}</span> },
    {
      key: "scopes",
      label: "Can",
      render: (a) => (
        <span className="flex flex-wrap gap-1">
          {a.scopes.map((s) => (
            <Badge key={s} theme="clear" className="font-mono">{s}</Badge>
          ))}
        </span>
      ),
    },
    { key: "created", label: "Connected", render: (a) => <span className="text-muted-foreground">{fmtDate(a.createdAt)}</span> },
    { key: "used", label: "Last used", render: (a) => <span className="text-muted-foreground" title={a.lastUsedAt ?? undefined}>{a.lastUsedAt ? relativeTime(a.lastUsedAt) : "Never"}</span> },
    {
      key: "end",
      label: <span className="sr-only">Actions</span>,
      className: "w-28 text-right",
      render: (a) => (
        <Button variant="ghost-secondary" disabled={revoke.isPending && revoke.variables === a.id} onClick={() => setConfirm(a)} data-testid="agent-connection-revoke">
          Revoke
        </Button>
      ),
    },
  ];
  return (
    <SettingsPage scope="personal" title="Connected agents" description="Agents you signed in over MCP. They act as you, within the scopes you gave them." testId="connected-agents-page">
      {agents.isError ? (
        <Alert theme="danger">Couldn't load your connected agents: {problemText(agents.error)}</Alert>
      ) : !agents.isLoading && rows.length === 0 ? (
        <EmptyState art="key" title={AGENTS_EMPTY} description="When you connect Claude Code, Cursor or another MCP client, it shows up here." data-testid="connected-agents-empty" />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(a) => a.id} loading={agents.isLoading} testId="connected-agents-table" />
      )}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent data-testid="agent-revoke-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {confirm?.clientName}?</AlertDialogTitle>
            <AlertDialogDescription>It can't read or change anything from its next call. Connect it again to undo.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (confirm)
                  revoke.mutate(confirm.id, {
                    onSuccess: () => notify(`Revoked ${confirm.clientName}`, { group: "agents", tone: "success" }),
                    onError: (e) => notify(problemText(e), { group: "agents", tone: "error" }),
                  });
                setConfirm(null);
              }}
              data-testid="agent-revoke-confirm-button"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}
