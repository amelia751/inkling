import { useMemo, useState } from "react";
import { DeleteIcon, InviteIcon, MailIcon, TopUpIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog } from "@studio/ui/ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { DataTable, Field, OutlineLabel, PersonCell, RowMenu, SearchField, SettingsDialog, SettingsPage, StatusLabel, CopyId, fmtDate, type Column } from "@/studio/components/settings/kit";
import { ACCOUNT, ORG_ROLES, PROJECT_ROLES, roleName, useAccount, type Member, type OrgRole, type ProjectRole } from "@/studio/lib/account-mock";
import { useProjectList } from "@/studio/lib/projects-api";

/** Organization › Team & Access: members and pending invitations (WorkOS organization memberships + invitations). */
export function MembersPage() {
  const members = useAccount((s) => s.members);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "invited">("all");
  const [inviting, setInviting] = useState(false);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return members.filter((m) => (status === "all" || m.status === status) && (!needle || `${m.name} ${m.email} ${m.id}`.toLowerCase().includes(needle)));
  }, [members, q, status]);
  const invited = members.filter((m) => m.status === "invited").length;

  return (
    <SettingsPage
      title="Team & Access"
      description="Who can sign in to this organization and what they can do. Project access is set in each project's settings."
      testId="org-members"
      filters={
        <>
          <SearchField value={q} onChange={setQ} placeholder="Search by name, email or ID" />
          <SegmentedControl
            size="md"
            aria-label="Status"
            value={status}
            onValueChange={setStatus}
            options={[
              { value: "all", label: `All ${members.length}` },
              { value: "active", label: "Active" },
              { value: "invited", label: `Invited ${invited}` },
            ]}
          />
        </>
      }
      actions={
        <Button size="lg" onClick={() => setInviting(true)} data-testid="invite-open">
          <InviteIcon /> Invite
        </Button>
      }
    >
      <DataTable columns={columns} rows={rows} rowKey={(m) => m.id} empty={q ? "No one matches that search." : "No members yet."} testId="members-table" />
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </SettingsPage>
  );
}

const columns: Column<Member>[] = [
  { key: "name", label: "Name", className: "w-[34%]", render: (m) => <PersonCell name={m.name} email={m.email} you={m.id === ACCOUNT.id} /> },
  { key: "id", label: "ID", render: (m) => <CopyId id={m.id} short /> },
  { key: "role", label: "Role", render: (m) => <OutlineLabel>{roleName(m.role)}</OutlineLabel> },
  { key: "projects", label: "Projects", className: "tnum", render: (m) => <span className="text-muted-foreground">{m.projects}</span> },
  { key: "status", label: "Status", render: (m) => <StatusLabel status={m.status} /> },
  { key: "seen", label: "Last active", render: (m) => <span className="text-muted-foreground">{m.status === "invited" ? `Invited ${fmtDate(m.invitedAt)}` : fmtDate(m.lastActive)}</span> },
  { key: "menu", label: <span className="sr-only">Actions</span>, className: "w-12", render: (m) => <MemberMenu member={m} /> },
];

function MemberMenu({ member }: { member: Member }) {
  const { setRole, removeMember, resendInvite, revokeInvite } = useAccount();
  const self = member.id === ACCOUNT.id;
  if (member.status === "invited") {
    return (
      <RowMenu label={`Actions for ${member.email}`}>
        <DropdownMenuItem onSelect={() => resendInvite(member.id)}>
          <MailIcon /> Resend invitation
        </DropdownMenuItem>
        <DropdownMenuItem className="text-danger focus:text-danger" onSelect={() => revokeInvite(member.id)}>
          <DeleteIcon /> Revoke invitation
        </DropdownMenuItem>
      </RowMenu>
    );
  }
  return (
    <RowMenu label={`Actions for ${member.name}`}>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={self}>Change role</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64">
          {ORG_ROLES.map((r) => (
            <DropdownMenuItem key={r.slug} onSelect={() => setRole(member.id, r.slug)} className="flex-col items-start gap-0.5">
              <span className={r.slug === member.role ? "font-semibold" : undefined}>{r.name}</span>
              <span className="text-xs text-muted-foreground">{r.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={self} className="text-danger focus:text-danger" onSelect={() => removeMember(member.id)}>
        <DeleteIcon /> Remove from organization
      </DropdownMenuItem>
    </RowMenu>
  );
}

/** Nebius "Invite team member": email, organization-level role, optional project access rows. */
export function InviteDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: string }) {
  const invite = useAccount((s) => s.invite);
  const projects = useProjectList().data ?? [];
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [access, setAccess] = useState<{ projectId: string; role: ProjectRole }[]>(projectId ? [{ projectId, role: "annotator" }] : []);
  const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const valid = list.length > 0 && list.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const reset = () => {
    setEmails("");
    setRole("member");
    setAccess(projectId ? [{ projectId, role: "annotator" }] : []);
  };
  const submit = () => {
    list.forEach((e) => invite(e, role, access.filter((a) => a.projectId)));
    reset();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : (reset(), onOpenChange(false)))}>
      <SettingsDialog
        title="Invite team member"
        footer={
          <>
            <Button variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="lg" className="min-w-32" disabled={!valid} onClick={submit} data-testid="invite-submit">
              {list.length > 1 ? `Invite ${list.length} people` : "Invite user"}
            </Button>
          </>
        }
      >
        <Field label="Email" htmlFor="invite-email" required description="Separate several addresses with commas. They get an email with a link that expires in 7 days.">
          <Input id="invite-email" inputSize="lg" placeholder="Enter email" value={emails} onChange={(e) => setEmails(e.target.value)} autoFocus data-testid="invite-email" />
        </Field>
        <Field label="Organization role" description={ORG_ROLES.find((r) => r.slug === role)?.description}>
          <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
            <SelectTrigger className="rounded-lg" data-testid="invite-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ORG_ROLES.map((r) => (
                <SelectItem key={r.slug} value={r.slug}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {access.map((a, i) => (
          <div key={i} className="grid grid-cols-[1fr_160px_auto] items-end gap-2">
            <Field label="Project">
              <Select value={a.projectId} onValueChange={(v) => setAccess(access.map((x, j) => (j === i ? { ...x, projectId: v } : x)))}>
                <SelectTrigger className="rounded-lg">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Project role">
              <Select value={a.role} onValueChange={(v) => setAccess(access.map((x, j) => (j === i ? { ...x, role: v as ProjectRole } : x)))}>
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
            <Button variant="ghost-secondary" size="icon-lg" aria-label="Remove project" onClick={() => setAccess(access.filter((_, j) => j !== i))}>
              <DeleteIcon />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="lg" className="w-fit" onClick={() => setAccess([...access, { projectId: "", role: "annotator" }])} data-testid="invite-add-project">
          <TopUpIcon /> Add to a project
        </Button>
      </SettingsDialog>
    </Dialog>
  );
}
