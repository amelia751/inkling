import { useMemo, useState } from "react";
import { DeleteIcon, InviteIcon, MailIcon, TopUpIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog } from "@studio/ui/ui/dialog";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { ORG_ROLES, PROJECT_ROLES, roleName, type OrgRole, type ProjectRole } from "@studio/contracts";
import { DataTable, Field, invalidProps, NoResults, OutlineLabel, PersonCell, RowMenu, SearchField, SettingsDialog, SettingsPage, StatusLabel, CopyId, fmtDate, type Column } from "@/studio/components/settings/kit";
import { memberRows, toastDone, toastError, useInvitations, useInvite, useOrgMembers, usePermission, useRemoveMember, useResendInvite, useRevokeInvite, useSelfId, useSetMemberRole, type MemberRow } from "@/studio/lib/org-api";
import { useProjectList } from "@/studio/lib/projects-api";

/** Organization › Team & Access: members and pending invitations (WorkOS organization memberships + invitations). */
export function MembersPage() {
  const canManage = usePermission("members:manage");
  const membersQ = useOrgMembers();
  const invitationsQ = useInvitations(canManage);
  const members = useMemo(() => memberRows(membersQ.data ?? [], invitationsQ.data ?? []), [membersQ.data, invitationsQ.data]);
  const self = useSelfId();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "invited">("all");
  const [inviting, setInviting] = useState(false);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return members.filter((m) => (status === "all" || m.status === status) && (!needle || `${m.name} ${m.email} ${m.id}`.toLowerCase().includes(needle)));
  }, [members, q, status]);
  const invited = members.filter((m) => m.status === "invited").length;
  // todo14 §4.2: nobody but you (no other member, no invitation): say what inviting is for.
  const alone = !membersQ.isLoading && !membersQ.isError && members.length <= 1 && members.every((m) => !self || m.userId === self) && !q && status === "all";
  const offline = membersQ.isError;

  const columns: Column<MemberRow>[] = [
    { key: "name", label: "Name", className: "w-[34%]", render: (m) => <PersonCell name={m.name} email={m.email} you={!!self && m.userId === self} /> },
    { key: "id", label: "ID", render: (m) => <CopyId id={m.userId ?? m.id} short /> },
    { key: "role", label: "Role", render: (m) => <OutlineLabel>{roleName(m.role)}</OutlineLabel> },
    { key: "projects", label: "Projects", className: "tnum", render: (m) => <span className="text-muted-foreground">{m.projects}</span> },
    { key: "status", label: "Status", render: (m) => <StatusLabel status={m.status} /> },
    { key: "seen", label: "Last active", render: (m) => <span className="text-muted-foreground">{m.invitation ? `Invited ${fmtDate(m.invitedAt)}` : fmtDate(m.lastActive)}</span> },
    { key: "menu", label: <span className="sr-only">Actions</span>, className: "w-12", render: (m) => (canManage ? <MemberMenu member={m} self={!!self && m.userId === self} /> : null) },
  ];

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
        <Button size="lg" onClick={() => setInviting(true)} disabled={!canManage || offline} title={offline ? "Managing members needs the API" : !canManage ? "You don't have permission to invite people" : undefined} data-testid="invite-open">
          <InviteIcon /> Invite
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(m) => m.id}
        loading={membersQ.isLoading} empty={
          offline ? (
            "Members need the API: see docs/running.md"
          ) : q || status !== "all" ? (
            <NoResults what="users" onClear={() => (setQ(""), setStatus("all"))} />
          ) : (
            "No members yet."
          )
        }
        testId="members-table"
      />
      {alone && (
        <EmptyState
          art="members"
          size="m"
          className="mt-6"
          title="Invite people to work on your projects"
          description="Members can open your organization's projects, label and review. Conversations with the assistant stay yours."
          actions={
            <Button variant="outline" size="lg" onClick={() => setInviting(true)} disabled={!canManage} data-testid="members-empty-invite">
              <InviteIcon /> Invite
            </Button>
          }
          data-testid="members-empty"
        />
      )}
      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </SettingsPage>
  );
}

function MemberMenu({ member, self }: { member: MemberRow; self: boolean }) {
  const setRole = useSetMemberRole();
  const remove = useRemoveMember();
  const resend = useResendInvite();
  const revoke = useRevokeInvite();
  if (member.invitation) {
    return (
      <RowMenu label={`Actions for ${member.email}`}>
        <DropdownMenuItem onSelect={() => resend.mutate(member.id, { onSuccess: () => toastDone(`Invitation sent again to ${member.email}`), onError: toastError })}>
          <MailIcon /> Resend invitation
        </DropdownMenuItem>
        <DropdownMenuItem className="text-danger focus:text-danger" onSelect={() => revoke.mutate(member.id, { onError: toastError })}>
          <DeleteIcon /> Revoke invitation
        </DropdownMenuItem>
      </RowMenu>
    );
  }
  return (
    <RowMenu label={`Actions for ${member.name || member.email}`}>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={self || member.status !== "active"}>Change role</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-64">
          {ORG_ROLES.map((r) => (
            <DropdownMenuItem key={r.slug} onSelect={() => r.slug !== member.role && setRole.mutate({ id: member.id, role: r.slug }, { onError: toastError })} className="flex-col items-start gap-0.5">
              <span className={r.slug === member.role ? "font-semibold" : undefined}>{r.name}</span>
              <span className="text-xs text-muted-foreground">{r.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={self || member.status === "deactivated"} className="text-danger focus:text-danger" onSelect={() => remove.mutate(member.id, { onSuccess: () => toastDone(`Removed ${member.name || member.email}`), onError: toastError })}>
        <DeleteIcon /> Remove from organization
      </DropdownMenuItem>
    </RowMenu>
  );
}

/** Nebius "Invite team member": email, organization-level role, optional project access rows. */
export function InviteDialog({ open, onOpenChange, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: string }) {
  const invite = useInvite();
  const projects = useProjectList().data ?? [];
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [access, setAccess] = useState<{ projectId: string; role: ProjectRole }[]>(projectId ? [{ projectId, role: "annotator" }] : []);
  const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const valid = list.length > 0 && bad.length === 0;
  const [touched, setTouched] = useState(false);
  const emailError = !touched ? null : list.length === 0 ? "Enter an email address" : bad.length ? (list.length > 1 ? `Invalid email address: ${bad[0]}` : "Invalid email address") : null;
  const reset = () => {
    setTouched(false);
    setEmails("");
    setRole("member");
    setAccess(projectId ? [{ projectId, role: "annotator" }] : []);
  };
  const submit = () => {
    setTouched(true);
    if (!valid) return;
    invite.mutate(
      { emails: list, role, projects: access.filter((a) => a.projectId) },
      {
        onSuccess: (sent) => {
          toastDone(sent.length > 1 ? `Invited ${sent.length} people` : `Invited ${sent[0]?.email ?? list[0]}`);
          reset();
          onOpenChange(false);
        },
        // WorkOS's text, e.g. a consumer-domain address that doesn't match exactly (Phase 6).
        onError: toastError,
      },
    );
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
            <Button size="lg" className="min-w-32" disabled={(touched && !valid) || invite.isPending} onClick={submit} data-testid="invite-submit">
              {list.length > 1 ? `Invite ${list.length} people` : "Invite user"}
            </Button>
          </>
        }
      >
        <Field label="Email" htmlFor="invite-email" required error={emailError} description="Separate several addresses with commas. They get an email with a link that expires in 7 days.">
          <Input id="invite-email" inputSize="lg" placeholder="Enter email" value={emails} onChange={(e) => setEmails(e.target.value)} onBlur={() => emails.trim() && setTouched(true)} autoFocus data-testid="invite-email" {...invalidProps("invite-email", emailError)} />
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
