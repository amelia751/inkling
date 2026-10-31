import { useState } from "react";
import { DeleteIcon, InviteIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog } from "@studio/ui/ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@studio/ui/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { CopyId, DataTable, Field, OutlineLabel, PersonCell, RowMenu, SearchField, SettingsDialog, StatusLabel, type Column } from "@/studio/components/settings/kit";
import { ACCOUNT, PROJECT_ROLES, roleName, useAccount, type Member, type ProjectRole } from "@/studio/lib/account-mock";
import { InviteDialog } from "./MembersPage";

type Row = Member & { projectRole: ProjectRole };

/** Project settings › Members (Nebius project "Team & Access"): who's in this project and with which role. */
export function ProjectMembers({ projectId }: { projectId: string }) {
  const { members, projectTeam, setProjectRole, removeFromProject } = useAccount();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const rows: Row[] = projectTeam(projectId)
    .map((p) => {
      const m = members.find((x) => x.id === p.userId);
      return m ? { ...m, projectRole: p.role } : null;
    })
    .filter((r): r is Row => !!r && (!q || `${r.name} ${r.email} ${r.id}`.toLowerCase().includes(q.toLowerCase())));

  const columns: Column<Row>[] = [
    { key: "name", label: "Name", className: "w-[34%]", render: (m) => <PersonCell name={m.name} email={m.email} you={m.id === ACCOUNT.id} /> },
    { key: "id", label: "ID", render: (m) => <CopyId id={m.id} short /> },
    { key: "org", label: "Organization role", render: (m) => <OutlineLabel>{roleName(m.role)}</OutlineLabel> },
    { key: "proj", label: "Project role", render: (m) => <OutlineLabel>{roleName(m.projectRole)}</OutlineLabel> },
    { key: "status", label: "Status", render: (m) => <StatusLabel status={m.status} /> },
    {
      key: "menu",
      label: <span className="sr-only">Actions</span>,
      className: "w-12",
      render: (m) => (
        <RowMenu label={`Actions for ${m.name || m.email}`}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={m.id === ACCOUNT.id}>Change project role</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              {PROJECT_ROLES.map((r) => (
                <DropdownMenuItem key={r.slug} onSelect={() => setProjectRole(projectId, m.id, r.slug)} className="flex-col items-start gap-0.5">
                  <span className={r.slug === m.projectRole ? "font-semibold" : undefined}>{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.description}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={m.id === ACCOUNT.id} className="text-danger focus:text-danger" onSelect={() => removeFromProject(projectId, m.id)}>
            <DeleteIcon /> Remove from project
          </DropdownMenuItem>
        </RowMenu>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="settings-members">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <SearchField value={q} onChange={setQ} placeholder="Search by name, email or ID" />
        <Button size="lg" onClick={() => setAdding(true)} data-testid="project-add-user">
          <InviteIcon /> Add user
        </Button>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(m) => m.id} empty="No one has been added to this project." testId="project-members-table" />
      <AddUserDialog projectId={projectId} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

/** Nebius "Add user": pick someone already in the organization, or invite a new person. */
function AddUserDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { members, projectTeam, addToProject } = useAccount();
  const [mode, setMode] = useState<"existing" | "invite">("existing");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("annotator");
  const inProject = new Set(projectTeam(projectId).map((p) => p.userId));
  const candidates = members.filter((m) => !inProject.has(m.id) && m.status !== "deactivated");
  const close = () => (onOpenChange(false), setUserId(""), setRole("annotator"), setMode("existing"));

  if (mode === "invite") {
    return <InviteDialog projectId={projectId} open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())} />;
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <SettingsDialog
        title="Add user"
        footer={
          <>
            <Button variant="outline" size="lg" onClick={close}>
              Cancel
            </Button>
            <Button size="lg" className="min-w-28" disabled={!userId} onClick={() => (addToProject(projectId, userId, role), close())} data-testid="add-user-submit">
              Add user
            </Button>
          </>
        }
      >
        <SegmentedControl
          size="md"
          aria-label="Who to add"
          className="w-full [&>*]:flex-1"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "existing", label: "Add user from organization" },
            { value: "invite", label: "Invite new user" },
          ]}
        />
        <Field label="User" required>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="rounded-lg" data-testid="add-user-select">
              <SelectValue placeholder={candidates.length ? "Select user" : "Everyone is already in this project"} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name || m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Project role" required description={PROJECT_ROLES.find((r) => r.slug === role)?.description}>
          <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
            <SelectTrigger className="rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_ROLES.map((r) => (
                <SelectItem key={r.slug} value={r.slug}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </SettingsDialog>
    </Dialog>
  );
}
