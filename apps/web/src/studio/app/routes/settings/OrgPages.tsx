import { useMemo, useState } from "react";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Loader } from "@studio/ui/ui/loader";
import { Link } from "react-router";
import { ApiKeyIcon, CheckIcon, CopyIcon, DeleteIcon, DomainIcon, ExternalLinkIcon, TopUpIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Dialog } from "@studio/ui/ui/dialog";
import { DropdownMenuItem } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { CopyId, DataTable, Field, invalidProps, NoResults, OutlineLabel, RowMenu, SearchField, SettingsDialog, SettingsPage, fmtDate, fmtDateTime, useCopy, type Column } from "@/studio/components/settings/kit";
import { API_KEY_SCOPES, AUDIT_ACTIONS, AUTH, ORG, useAccount, type ApiKey, type AuditEvent } from "@/studio/lib/account-mock";
import { useProjectList } from "@/studio/lib/projects-api";
import { newProjectUrl, projectUrl, settingsUrl } from "@/studio/lib/routes";
import type { ProjectSummary } from "@studio/contracts";

/** Organization › Projects: every project in the org, with who's in it. */
export function OrgProjectsPage() {
  const { data: projects = [], isLoading } = useProjectList();
  const team = useAccount((s) => s.projectTeam);
  const [q, setQ] = useState("");
  const rows = projects.filter((p) => !q || `${p.title} ${p.id}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<ProjectSummary>[] = [
    {
      key: "name",
      label: "Name and ID",
      className: "w-[45%]",
      render: (p) => (
        <div className="min-w-0">
          <Link to={projectUrl(p.id)} className="block truncate font-semibold leading-5 hover:text-brand">
            {p.title}
          </Link>
          <CopyId id={p.id} short />
        </div>
      ),
    },
    { key: "users", label: "Members", className: "tnum", render: (p) => <span className="text-muted-foreground">{team(p.id).length} users</span> },
    { key: "state", label: "Status", render: (p) => (p.archived ? <Badge theme="unknown">Archived</Badge> : <Badge theme="success">Active</Badge>) },
    { key: "created", label: "Created", render: (p) => <span className="text-muted-foreground">{fmtDate(p.createdAt)}</span> },
    {
      key: "menu",
      label: <span className="sr-only">Actions</span>,
      className: "w-12",
      render: (p) => (
        <RowMenu label={`Actions for ${p.title}`}>
          <DropdownMenuItem asChild>
            <Link to={settingsUrl(p.id, "members")}>Team & Access</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={settingsUrl(p.id, "general")}>Project settings</Link>
          </DropdownMenuItem>
        </RowMenu>
      ),
    },
  ];
  return (
    <SettingsPage
      title="Projects"
      testId="org-projects"
      filters={<SearchField value={q} onChange={setQ} placeholder="Search by name or ID" />}
      actions={
        <Button size="lg" asChild>
          <Link to={newProjectUrl()}>
            <TopUpIcon /> Create project
          </Link>
        </Button>
      }
    >
      <DataTable columns={columns} rows={rows} rowKey={(p) => p.id} empty={isLoading ? <span className="inline-flex items-center gap-2"><Loader size="s" /> Loading projects</span> : q ? <NoResults what="projects" onClear={() => setQ("")} /> : <EmptyState art="folder" title="No projects yet" description="A project holds your files, the datasets you build from them and the annotation work on them." actions={<Button variant="outline" size="lg" asChild><Link to={newProjectUrl()}>Create project</Link></Button>} />} testId="org-projects-table" />
    </SettingsPage>
  );
}

function Section({ title, description, children, action }: { title: string; description?: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0 max-w-2xl">
          <h3 className="text-body-3 font-semibold">{title}</h3>
          {description && <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children && <div className="border-t border-border px-5 py-4">{children}</div>}
    </section>
  );
}

const MockNote = () => (
  <Alert theme="info">Sign-in, SSO and directory settings are a mock. They will be set up through WorkOS (todo/todo9.md).</Alert>
);

/** Organization › Security: sign-in methods, MFA, SSO, directory sync, domains, sessions (WorkOS AuthKit + Admin Portal). */
export function SecurityPage() {
  const [methods, setMethods] = useState(AUTH.methods);
  const [mfa, setMfa] = useState(AUTH.mfaRequired);
  const [hours, setHours] = useState(String(AUTH.sessionHours));
  const log = useAccount((s) => s.log);
  return (
    <SettingsPage title="Security" description="How people sign in to this organization and how accounts are provisioned." testId="org-security">
      <MockNote />
      <div className="flex flex-col gap-4">
        <Section title="Sign-in methods" description="Which ways members can sign in. Members using SSO always sign in through your identity provider.">
          <ul className="flex flex-col gap-3">
            {methods.map((m) => (
              <li key={m.id} className="flex items-center gap-3 text-sm">
                <Checkbox id={`method-${m.id}`} checked={m.on} onCheckedChange={(v) => setMethods(methods.map((x) => (x.id === m.id ? { ...x, on: v === true } : x)))} />
                <label htmlFor={`method-${m.id}`}>{m.name}</label>
              </li>
            ))}
          </ul>
        </Section>
        <Section
          title="Multi-factor authentication"
          description="Require an authenticator app for everyone who signs in with a password or magic link."
          action={
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={mfa} onCheckedChange={(v) => (setMfa(v === true), log("org.mfa_policy_changed", v ? "required" : "optional"))} data-testid="mfa-required" />
              Require MFA
            </label>
          }
        />
        <Section
          title="Single sign-on (SSO)"
          description="Let members sign in with your organization's identity provider: Okta, Microsoft Entra ID, Google Workspace or any SAML/OIDC provider."
          action={
            <Button variant="outline" size="lg" onClick={() => log("org.admin_portal_opened", "sso")}>
              {AUTH.sso ? "Manage" : "Set up SSO"} <ExternalLinkIcon />
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">{AUTH.sso ? `${AUTH.sso.provider} · ${AUTH.sso.state}` : "Not configured. Opens the setup guide for your IT admin."}</p>
        </Section>
        <Section
          title="Directory sync (SCIM)"
          description="Add and remove members automatically from your directory, and map directory groups to roles."
          action={
            <Button variant="outline" size="lg" onClick={() => log("org.admin_portal_opened", "dsync")}>
              Connect directory <ExternalLinkIcon />
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">{AUTH.directory ? `${AUTH.directory.provider}: ${AUTH.directory.users} users, ${AUTH.directory.groups} groups` : "No directory connected."}</p>
        </Section>
        <Section
          title="Verified domains"
          description="People who sign up with an email at a verified domain join this organization automatically. Required for SSO."
          action={
            <Button variant="outline" size="lg" onClick={() => log("org.admin_portal_opened", "domain_verification")}>
              <DomainIcon /> Add domain
            </Button>
          }
        >
          {ORG.domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domains yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {ORG.domains.map((d) => (
                <li key={d.domain} className="flex items-center gap-2">
                  {d.domain} <Badge theme={d.state === "verified" ? "success" : "warning"}>{d.state}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Sessions" description="How long someone stays signed in without activity.">
          <div className="flex items-center gap-3 text-sm">
            <Select value={hours} onValueChange={setHours}>
              <SelectTrigger className="w-40 rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["1", "8", "12", "24", "168"].map((h) => (
                  <SelectItem key={h} value={h}>
                    {h === "168" ? "7 days" : `${h} hours`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Section>
      </div>
    </SettingsPage>
  );
}

const EXPIRY = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiration" },
];

/** Organization › API keys: org-scoped secrets for scripts, PACS bridges and MCP clients (WorkOS API keys / M2M). */
export function ApiKeysPage() {
  const { apiKeys, revokeKey } = useAccount();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = apiKeys.filter((k) => !q || `${k.name} ${k.prefix} ${k.id}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<ApiKey>[] = [
    {
      key: "name",
      label: "Name & secret key",
      className: "w-[30%]",
      render: (k) => (
        <div className="min-w-0">
          <div className="truncate font-semibold leading-5">{k.name}</div>
          <div className="font-mono text-code text-muted-foreground">{k.prefix}••••</div>
        </div>
      ),
    },
    { key: "scopes", label: "Permissions", render: (k) => <div className="flex flex-wrap gap-1">{k.scopes.map((s) => <OutlineLabel key={s}>{s}</OutlineLabel>)}</div> },
    { key: "by", label: "Created by", render: (k) => <span className="text-muted-foreground">{k.createdBy}</span> },
    { key: "created", label: "Created at", render: (k) => <span className="text-muted-foreground">{fmtDate(k.createdAt)}</span> },
    { key: "used", label: "Last used", render: (k) => <span className="text-muted-foreground">{k.lastUsedAt ? fmtDate(k.lastUsedAt) : "Never"}</span> },
    { key: "exp", label: "Expiration date", render: (k) => <span className="text-muted-foreground">{k.expiresAt ? fmtDate(k.expiresAt) : "Never"}</span> },
    {
      key: "menu",
      label: <span className="sr-only">Actions</span>,
      className: "w-12",
      render: (k) => (
        <RowMenu label={`Actions for ${k.name}`}>
          <DropdownMenuItem className="text-danger focus:text-danger" onSelect={() => revokeKey(k.id)}>
            <DeleteIcon /> Revoke key
          </DropdownMenuItem>
        </RowMenu>
      ),
    },
  ];
  return (
    <SettingsPage
      title="API keys"
      description="Keys let scripts, PACS bridges and MCP clients act on this organization. Treat them like passwords."
      testId="org-api-keys"
      filters={<SearchField value={q} onChange={setQ} placeholder="Search by name or key" />}
      actions={
        <Button size="lg" onClick={() => setCreating(true)} data-testid="api-key-create">
          <ApiKeyIcon /> Create API key
        </Button>
      }
    >
      <DataTable columns={columns} rows={rows} rowKey={(k) => k.id} empty={
          <EmptyState
            art="key"
            title="No API keys yet"
            description="An API key lets scripts and pipelines upload data and read annotations on behalf of this organization."
            actions={<Button variant="outline" size="lg" onClick={() => setCreating(true)}>Create API key</Button>}
          />
        } testId="api-keys-table" />
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
    </SettingsPage>
  );
}

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const createKey = useAccount((s) => s.createKey);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const nameError = nameTouched && !name.trim() ? "Enter a name" : null;
  const [expiry, setExpiry] = useState("90");
  const [scopes, setScopes] = useState<string[]>(["datasets:read"]);
  const [secret, setSecret] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  const close = () => {
    onOpenChange(false);
    setTimeout(() => (setName(""), setNameTouched(false), setExpiry("90"), setScopes(["datasets:read"]), setSecret(null)), 200);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      {secret ? (
        <SettingsDialog title="Save your key" footer={<Button size="lg" onClick={close}>Done</Button>}>
          <p className="text-sm text-complementary">This is the only time the secret is shown. Store it somewhere safe; if you lose it, revoke the key and create a new one.</p>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-generic px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-code" data-testid="api-key-secret">
              {secret}
            </code>
            <Button variant="ghost-secondary" size="icon" aria-label="Copy key" onClick={() => copy("secret", secret)}>
              {copied ? <CheckIcon className="text-positive" /> : <CopyIcon />}
            </Button>
          </div>
        </SettingsDialog>
      ) : (
        <SettingsDialog
          title="Create API key"
          footer={
            <>
              <Button variant="outline" size="lg" onClick={close}>
                Cancel
              </Button>
              <Button size="lg" disabled={!name.trim() || scopes.length === 0} onClick={() => setSecret(createKey(name.trim(), expiry === "never" ? null : Number(expiry), scopes).secret)} data-testid="api-key-submit">
                Create key
              </Button>
            </>
          }
        >
          <Field label="Name" htmlFor="key-name" required error={nameError}>
            <Input id="key-name" inputSize="lg" placeholder="e.g. PACS sync" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setNameTouched(true)} autoFocus {...invalidProps("key-name", nameError)} />
          </Field>
          <Field label="Expiration">
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger className="rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY.map((e) => (
                  <SelectItem key={e.value} value={e.value}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Permissions">
            <ul className="flex flex-col gap-2.5">
              {API_KEY_SCOPES.map((s) => (
                <li key={s.id} className="flex items-center gap-2.5 text-sm">
                  <Checkbox id={`scope-${s.id}`} checked={scopes.includes(s.id)} onCheckedChange={(v) => setScopes(v ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))} />
                  <label htmlFor={`scope-${s.id}`}>{s.label}</label>
                  <span className="font-mono text-code text-hint">{s.id}</span>
                </li>
              ))}
            </ul>
          </Field>
        </SettingsDialog>
      )}
    </Dialog>
  );
}

/** Organization › Audit log: who did what, from where (WorkOS Audit Logs; exportable as CSV there). */
export function AuditLogPage() {
  const audit = useAccount((s) => s.audit);
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const rows = useMemo(
    () => audit.filter((e) => (action === "all" || e.action === action) && (!q || `${e.actor} ${e.target} ${e.action}`.toLowerCase().includes(q.toLowerCase()))),
    [audit, q, action],
  );
  const columns: Column<AuditEvent>[] = [
    { key: "at", label: "Date and time (UTC)", className: "whitespace-nowrap", render: (e) => <span className="tnum text-muted-foreground">{fmtDateTime(e.at)}</span> },
    { key: "actor", label: "Actor", render: (e) => <span className="font-semibold">{e.actor}</span> },
    { key: "action", label: "Action", render: (e) => <span className="font-mono text-code">{e.action}</span> },
    { key: "target", label: "Target", className: "w-[30%]", render: (e) => <span className="line-clamp-1">{e.target}</span> },
    { key: "ip", label: "IP address", render: (e) => <span className="tnum font-mono text-code text-muted-foreground">{e.ip}</span> },
  ];
  return (
    <SettingsPage
      title="Audit log"
      description="Sign-ins, membership changes, keys, exports and reviews across the organization."
      testId="org-audit-log"
      filters={
        <>
          <SearchField value={q} onChange={setQ} placeholder="Search by person or target" />
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="h-9 w-56 rounded-[10px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {AUDIT_ACTIONS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
      actions={
        <Button variant="outline" size="lg" disabled title="Available once audit logs are stored in WorkOS">
          Export CSV
        </Button>
      }
    >
      <DataTable columns={columns} rows={rows} rowKey={(e) => e.id} empty={q || action !== "all" ? <NoResults what="events" onClear={() => (setQ(""), setAction("all"))} /> : "No events yet."} testId="audit-table" />
    </SettingsPage>
  );
}

/** Organization › Settings: name, data retention and AI assistance (Nebius "Enable zero data retention"). */
export function OrgSettingsPage() {
  const log = useAccount((s) => s.log);
  const [name, setName] = useState(ORG.name);
  const [zdr, setZdr] = useState(ORG.zeroRetention);
  const [ai, setAi] = useState(ORG.aiAssist);
  const nameError = name.trim() ? null : "Enter a name";
  const dirty = name !== ORG.name || zdr !== ORG.zeroRetention || ai !== ORG.aiAssist;
  const save = () => {
    Object.assign(ORG, { name, zeroRetention: zdr, aiAssist: ai });
    log("org.settings_updated", name);
    setName(name);
  };
  return (
    <SettingsPage title="Settings" testId="org-settings">
      <div className="flex max-w-[458px] flex-col gap-6">
        <Field label="Organization name" htmlFor="org-name" required error={nameError}>
          <Input id="org-name" inputSize="lg" value={name} onChange={(e) => setName(e.target.value)} {...invalidProps("org-name", nameError)} />
        </Field>
        <Field label="Created">
          <span className="text-sm text-muted-foreground">{fmtDate(ORG.createdAt)}</span>
        </Field>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={zdr} onCheckedChange={(v) => setZdr(v === true)} data-testid="zero-retention" />
          <span>
            Enable zero data retention
            <span className="mt-0.5 block leading-5 text-muted-foreground">AI providers may not store prompts, images or outputs from this organization.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={ai} onCheckedChange={(v) => setAi(v === true)} />
          <span>
            Allow AI suggestions
            <span className="mt-0.5 block leading-5 text-muted-foreground">Members can ask for AI contours and labels. Every suggestion is marked and needs a person to accept it.</span>
          </span>
        </label>
        <Button size="lg" className="w-fit" disabled={!dirty || !name.trim()} onClick={save}>
          Save changes
        </Button>
      </div>
    </SettingsPage>
  );
}
