import { useState } from "react";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { DeleteIcon, InviteIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog } from "@studio/ui/ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@studio/ui/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { PROJECT_ROLES, roleName, type MemberStatus, type ProjectMember, type ProjectRole } from "@studio/contracts";
import { CopyId, DataTable, Field, OutlineLabel, PersonCell, RowMenu, SearchField, SettingsDialog, StatusLabel, type Column } from "@/studio/components/settings/kit";
import { toastError, useAddToProject, useOrgMembers, useProjectMembers, useRemoveFromProject, useSelfId, useSetProjectRole, usePermission } from "@/studio/lib/org-api";
import { InviteDialog } from "./MembersPage";

type Row = ProjectMember & { orgRole: string | null; status: MemberStatus };

/** Project settings › Members (Nebius project "Team & Access"): who's in this project and with which role. */
export function ProjectMembers({ projectId }: { projectId: string }) {
  const team = useProjectMembers(projectId);
  const members = useOrgMembers().data ?? [];
  const setProjectRole = useSetProjectRole(projectId);
  const removeFromProject = useRemoveFromProject(projectId);
  const self = useSelfId();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const rows: Row[] = (team.data ?? [])
    .map((p) => {
      const m = members.find((x) => x.userId === p.userId);
      return { ...p, orgRole: m?.role ?? null, status: m?.status ?? "active" };
    })
    .filter((r) => !q || `${r.name} ${r.email} ${r.userId}`.toLowerCase().includes(q.toLowerCase()));
  const offline = team.isError;
  // Project admins and org Admins (`members:manage`) manage the project's members.
  const orgAdmin = usePermission("members:manage");
  const canManage = orgAdmin || (team.data ?? []).some((p) => p.userId === self && p.role === "owner");

  const columns: Column<Row>[] = [
    { key: "name", label: "Name", className: "w-[34%]", render: (m) => <PersonCell name={m.name} email={m.email} you={!!self && m.userId === self} /> },
    { key: "id", label: "ID", render: (m) => <CopyId id={m.userId} short /> },
    { key: "org", label: "Organization role", render: (m) => (m.orgRole ? <OutlineLabel>{roleName(m.orgRole)}</OutlineLabel> : <span className="text-muted-foreground">—</span>) },
    { key: "proj", label: "Project role", render: (m) => <OutlineLabel>{roleName(m.role)}</OutlineLabel> },
    { key: "status", label: "Status", render: (m) => <StatusLabel status={m.status} /> },
    {
      key: "menu",
      label: <span className="sr-only">Actions</span>,
      className: "w-12",
      render: (m) =>
        canManage && (
        <RowMenu label={`Actions for ${m.name || m.email}`}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!!self && m.userId === self}>Change project role</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              {PROJECT_ROLES.map((r) => (
                <DropdownMenuItem key={r.slug} onSelect={() => r.slug !== m.role && setProjectRole.mutate({ userId: m.userId, role: r.slug }, { onError: toastError })} className="flex-col items-start gap-0.5">
                  <span className={r.slug === m.role ? "font-semibold" : undefined}>{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.description}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!!self && m.userId === self} className="text-danger focus:text-danger" onSelect={() => removeFromProject.mutate(m.userId, { onError: toastError })}>
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
        <Button size="lg" onClick={() => setAdding(true)} disabled={offline || !canManage} title={offline ? "Project members need the API" : !canManage ? "Only project admins can add people" : undefined} data-testid="project-add-user">
          <InviteIcon /> Add user
        </Button>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(m) => m.userId} loading={team.isLoading} empty={
          offline ? (
            "Project members need the API: see docs/running.md"
          ) : (
          <EmptyState
            art="members"
            title="No members yet"
            description="Add people from your organization, or invite someone new, to annotate and review in this project."
            actions={<Button variant="outline" size="lg" onClick={() => setAdding(true)}>Add user</Button>}
          />
          )
        } testId="project-members-table" />
      <AddUserDialog projectId={projectId} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

/** Nebius "Add user": pick someone already in the organization, or invite a new person. */
function AddUserDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const members = useOrgMembers().data ?? [];
  const team = useProjectMembers(projectId).data ?? [];
  const add = useAddToProject(projectId);
  const [mode, setMode] = useState<"existing" | "invite">("existing");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("annotator");
  const inProject = new Set(team.map((p) => p.userId));
  // Pending memberships have no account to add yet: invite them with a project grant instead.
  const candidates = members.filter((m) => !inProject.has(m.userId) && m.status === "active");
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
            <Button size="lg" className="min-w-28" disabled={!userId || add.isPending} onClick={() => add.mutate({ userId, role }, { onSuccess: close, onError: toastError })} data-testid="add-user-submit">
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
                <SelectItem key={m.userId} value={m.userId}>
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
