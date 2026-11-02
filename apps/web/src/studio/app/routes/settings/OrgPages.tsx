import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import {
  auditCsvUrl,
  errorText,
  stepUpUrl,
  toastDone,
  toastError,
  useAdminPortal,
  useApiKeys,
  useAuditLog,
  useCreateApiKey,
  useOrgSecurity,
  useOrgSettings,
  usePatchOrg,
  usePermission,
  useProjectMemberCounts,
  useRevokeApiKey,
  useSetMfaRequired,
} from "@/studio/lib/org-api";
import { useProjectList } from "@/studio/lib/projects-api";
import { newProjectUrl, projectUrl, settingsUrl } from "@/studio/lib/routes";
import { API_KEY_SCOPES, type AdminPortalIntent, type ApiKey, type AuditEvent, type ProjectSummary } from "@studio/contracts";

/** Organization › Projects: every project in the org, with who's in it. */
export function OrgProjectsPage() {
  const { data: projects = [], isLoading } = useProjectList();
  const counts = useProjectMemberCounts(useMemo(() => projects.map((p) => p.id), [projects]));
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
    { key: "users", label: "Members", className: "tnum", render: (p) => <span className="text-muted-foreground">{counts[p.id] === undefined ? "—" : `${counts[p.id]} ${counts[p.id] === 1 ? "user" : "users"}`}</span> },
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

/**
 * Opens an Admin Portal link in a new tab. The link lasts 5 minutes, so it's generated on click;
 * the tab is opened first (inside the click, so popup blockers allow it) and pointed at the link
 * once the API answers.
 */
function useOpenAdminPortal() {
  const portal = useAdminPortal();
  const open = (intent: AdminPortalIntent) => {
    const tab = window.open("", "_blank");
    portal.mutate(intent, {
      onSuccess: (url) => {
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else window.open(url, "_blank", "noopener");
      },
      onError: (e) => {
        tab?.close();
        toastError(e);
      },
    });
  };
  return { open, pending: portal.isPending ? portal.variables : undefined };
}

/** Organization › Security: sign-in methods, MFA, SSO, directory sync, domains, sessions (WorkOS AuthKit + Admin Portal). */
export function SecurityPage() {
  const { data: security, isLoading, isError, error } = useOrgSecurity();
  const canManage = usePermission("org:manage");
  const setMfa = useSetMfaRequired();
  const portal = useOpenAdminPortal();
  const can = canManage && !!security;
  const portalButton = (intent: AdminPortalIntent, label: React.ReactNode, testId: string) => (
    <Button variant="outline" size="lg" disabled={!can || portal.pending === intent} onClick={() => portal.open(intent)} data-testid={testId}>
      {portal.pending === intent ? <Loader size="s" /> : null}
      {label}
    </Button>
  );
  return (
    <SettingsPage title="Security" description="How people sign in to this organization and how accounts are provisioned." testId="org-security">
      {isError && <Alert theme="danger">Couldn't load security settings: {errorText(error)}</Alert>}
      {isLoading && (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader size="s" /> Loading
        </span>
      )}
      <div className="flex flex-col gap-4">
        <Section title="Sign-in methods" description="Which ways members can sign in. These are set for every organization; members using SSO always sign in through your identity provider.">
          {security?.methods.length ? (
            <ul className="flex flex-col gap-3">
              {security.methods.map((m) => (
                <li key={m.id} className="flex items-center gap-3 text-sm">
                  <Checkbox id={`method-${m.id}`} checked={m.on} disabled aria-readonly />
                  <label htmlFor={`method-${m.id}`}>{m.name}</label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </Section>
        <Section
          title="Multi-factor authentication"
          description="Require an authenticator app for everyone who signs in with a password or magic link. MFA doesn't apply to people who sign in with SSO: their identity provider handles it."
          action={
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={security?.mfaRequired ?? false}
                disabled={!can || !security?.mfaEditable || setMfa.isPending}
                onCheckedChange={(v) => setMfa.mutate(v === true, { onSuccess: (s) => toastDone(s.mfaRequired ? "MFA is now required" : "MFA is now optional"), onError: toastError })}
                data-testid="mfa-required"
              />
              Require MFA
            </label>
          }
        >
          {security && !security.mfaEditable ? <p className="text-sm text-muted-foreground">The MFA policy can't be changed from here yet. Contact support to change it.</p> : null}
        </Section>
        <Section
          title="Single sign-on (SSO)"
          description="Let members sign in with your organization's identity provider: Okta, Microsoft Entra ID, Google Workspace or any SAML/OIDC provider. Once SSO is active, it replaces the other sign-in methods for this organization."
          action={portalButton("sso", <>{security?.sso ? "Manage" : "Set up SSO"} <ExternalLinkIcon /></>, "admin-portal-sso")}
        >
          <p className="text-sm text-muted-foreground">{security?.sso ? `${security.sso.provider} · ${security.sso.state}` : "Not configured. Opens the setup guide for your IT admin in a new tab."}</p>
        </Section>
        <Section
          title="Directory sync (SCIM)"
          description="Add and remove members automatically from your directory, and map directory groups to roles."
          action={portalButton("dsync", <>{security?.directory ? "Manage directory" : "Connect directory"} <ExternalLinkIcon /></>, "admin-portal-dsync")}
        >
          <p className="text-sm text-muted-foreground">{security?.directory ? `${security.directory.provider}: ${security.directory.users} users, ${security.directory.groups} groups` : "No directory connected."}</p>
        </Section>
        <Section
          title="Verified domains"
          description="People who sign up with an email at a verified domain join this organization automatically. Required for SSO."
          action={portalButton("domain_verification", <><DomainIcon /> Add domain</>, "admin-portal-domains")}
        >
          {!security?.domains.length ? (
            <p className="text-sm text-muted-foreground">No domains yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {security.domains.map((d) => (
                <li key={d.domain} className="flex items-center gap-2">
                  {d.domain} <Badge theme={d.state === "verified" ? "success" : "warning"}>{d.state}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Sessions" description="How long someone stays signed in. This is the same for every organization.">
          <p className="text-sm" data-testid="session-length">
            {security ? `People are signed out after ${security.sessionHours === 1 ? "1 hour" : `${security.sessionHours} hours`} at most, and after an hour without activity.` : "—"}
          </p>
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
  const keys = useApiKeys();
  const revoke = useRevokeApiKey();
  const canManage = usePermission("apikeys:manage");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const offline = keys.isError;
  const rows = (keys.data ?? []).filter((k) => !q || `${k.name} ${k.prefix} ${k.id}`.toLowerCase().includes(q.toLowerCase()));
  const columns: Column<ApiKey>[] = [
    {
      key: "name",
      label: "Name & secret key",
      className: "w-[30%]",
      render: (k) => (
        <div className="min-w-0">
          <div className="truncate font-semibold leading-5">{k.name}</div>
          <div className="font-mono text-code text-muted-foreground">{k.prefix}</div>
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
      render: (k) =>
        canManage && (
          <RowMenu label={`Actions for ${k.name}`}>
            <DropdownMenuItem className="text-danger focus:text-danger" onSelect={() => revoke.mutate(k.id, { onSuccess: () => toastDone(`Revoked ${k.name}`), onError: toastError })}>
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
        <Button size="lg" onClick={() => setCreating(true)} disabled={!canManage || offline} title={offline ? "API keys need the API" : !canManage ? "You don't have permission to manage API keys" : undefined} data-testid="api-key-create">
          <ApiKeyIcon /> Create API key
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(k) => k.id}
        empty={
          keys.isLoading ? (
            <span className="inline-flex items-center gap-2">
              <Loader size="s" /> Loading keys
            </span>
          ) : offline ? (
            `Couldn't load API keys: ${errorText(keys.error)}`
          ) : q ? (
            <NoResults what="keys" onClear={() => setQ("")} />
          ) : (
            <EmptyState
              art="key"
              title="No keys yet"
              data-testid="keys-empty"
              description="An API key lets scripts and pipelines upload data and read annotations on behalf of this organization."
              actions={
                canManage ? (
                  <Button variant="outline" size="lg" onClick={() => setCreating(true)} data-testid="keys-empty-create">
                    Create API key
                  </Button>
                ) : undefined
              }
            />
          )
        }
        testId="api-keys-table"
      />
      <CreateKeyDialog open={creating} onOpenChange={setCreating} />
    </SettingsPage>
  );
}

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const createKey = useCreateApiKey();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const nameError = nameTouched && !name.trim() ? "Enter a name" : null;
  const [expiry, setExpiry] = useState("90");
  const [scopes, setScopes] = useState<string[]>(["datasets:read"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  const close = () => {
    onOpenChange(false);
    setTimeout(() => (setName(""), setNameTouched(false), setExpiry("90"), setScopes(["datasets:read"]), setSecret(null), setStepUp(null), createKey.reset()), 200);
  };
  const submit = () =>
    createKey.mutate(
      { name: name.trim(), expiresInDays: expiry === "never" ? null : Number(expiry), scopes },
      {
        onSuccess: (r) => setSecret(r.secret),
        onError: (e) => {
          // Creating a key needs a sign-in from the last 10 minutes (Phase 8).
          const url = stepUpUrl(e);
          if (url) setStepUp(url);
          else toastError(e);
        },
      },
    );
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
      ) : stepUp ? (
        <SettingsDialog
          title="Sign in again"
          footer={
            <>
              <Button variant="outline" size="lg" onClick={close}>
                Cancel
              </Button>
              <Button size="lg" onClick={() => window.location.assign(stepUp)} data-testid="api-key-step-up">
                Sign in
              </Button>
            </>
          }
        >
          <p className="text-sm text-complementary">Creating an API key needs a recent sign-in. Sign in again, then create the key.</p>
        </SettingsDialog>
      ) : (
        <SettingsDialog
          title="Create API key"
          footer={
            <>
              <Button variant="outline" size="lg" onClick={close}>
                Cancel
              </Button>
              <Button size="lg" disabled={!name.trim() || scopes.length === 0 || createKey.isPending} onClick={submit} data-testid="api-key-submit">
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

/** Organization › Audit log: who did what, from where. Filtered and paged by the API; exportable as CSV. */
export function AuditLogPage() {
  const canRead = usePermission("audit:read");
  const [actorInput, setActorInput] = useState("");
  const actor = useDeferredValue(actorInput.trim());
  const [action, setAction] = useState("all");
  const filters = useMemo(() => ({ actor: actor || undefined, action: action === "all" ? undefined : action }), [actor, action]);
  const log = useAuditLog(filters);
  const rows = useMemo(() => log.data?.pages.flatMap((p) => p.events) ?? [], [log.data]);
  // The action filter offers every action seen so far (the API has no list of them).
  const seen = useRef(new Set<string>());
  const [actions, setActions] = useState<string[]>([]);
  useEffect(() => {
    const before = seen.current.size;
    rows.forEach((e) => seen.current.add(e.action));
    if (seen.current.size !== before) setActions([...seen.current].sort());
  }, [rows]);
  const columns: Column<AuditEvent>[] = [
    { key: "at", label: "Date and time (UTC)", className: "whitespace-nowrap", render: (e) => <span className="tnum text-muted-foreground">{fmtDateTime(e.at)}</span> },
    { key: "actor", label: "Actor", render: (e) => <span className="font-semibold" title={e.actorId}>{e.actor}</span> },
    { key: "action", label: "Action", render: (e) => <span className="font-mono text-code">{e.action}</span> },
    { key: "target", label: "Target", className: "w-[30%]", render: (e) => <span className="line-clamp-1">{e.target}</span> },
    { key: "ip", label: "IP address", render: (e) => <span className="tnum font-mono text-code text-muted-foreground">{e.ip ?? "—"}</span> },
  ];
  const filtered = !!actorInput || action !== "all";
  return (
    <SettingsPage
      title="Audit log"
      description="Sign-ins, membership changes, keys, exports and reviews across the organization."
      testId="org-audit-log"
      filters={
        <>
          <SearchField value={actorInput} onChange={setActorInput} placeholder="Filter by person" />
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger className="h-9 w-56 rounded-[10px]" data-testid="audit-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {(action === "all" || actions.includes(action) ? actions : [...actions, action]).map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      }
      actions={
        canRead && !log.isError ? (
          <Button variant="outline" size="lg" asChild>
            <a href={auditCsvUrl(filters)} download data-testid="audit-export">
              Export CSV
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="lg" disabled title={log.isError ? "The audit log needs the API" : "You don't have permission to read the audit log"}>
            Export CSV
          </Button>
        )
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(e) => e.id}
        empty={
          log.isLoading ? (
            <span className="inline-flex items-center gap-2">
              <Loader size="s" /> Loading events
            </span>
          ) : log.isError ? (
            `Couldn't load the audit log: ${errorText(log.error)}`
          ) : filtered ? (
            <NoResults what="events" onClear={() => (setActorInput(""), setAction("all"))} />
          ) : (
            "No events yet."
          )
        }
        testId="audit-table"
      />
      {log.hasNextPage && (
        <Button variant="outline" size="lg" className="w-fit self-center" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} data-testid="audit-more">
          {log.isFetchingNextPage ? <Loader size="s" /> : null} Load older events
        </Button>
      )}
    </SettingsPage>
  );
}

/** Organization › Settings: name, data retention and AI assistance (Nebius "Enable zero data retention"). */
export function OrgSettingsPage() {
  const { data: org, isError, error } = useOrgSettings();
  const canManage = usePermission("org:manage");
  const patch = usePatchOrg();
  const [name, setName] = useState("");
  const [zdr, setZdr] = useState(false);
  const [ai, setAi] = useState(false);
  // The form starts from the saved settings, and again after each save.
  useEffect(() => {
    if (!org) return;
    setName(org.name);
    setZdr(org.zeroRetention);
    setAi(org.aiAssist);
  }, [org]);
  const nameError = org && !name.trim() ? "Enter a name" : null;
  const dirty = !!org && (name !== org.name || zdr !== org.zeroRetention || ai !== org.aiAssist);
  const editable = !!org && canManage;
  const save = () => {
    if (!org) return;
    const body = { ...(name !== org.name ? { name: name.trim() } : {}), ...(zdr !== org.zeroRetention ? { zeroRetention: zdr } : {}), ...(ai !== org.aiAssist ? { aiAssist: ai } : {}) };
    patch.mutate(body, { onSuccess: () => toastDone("Organization settings saved"), onError: toastError });
  };
  return (
    <SettingsPage title="Settings" testId="org-settings">
      <div className="flex max-w-[458px] flex-col gap-6">
        {isError && <Alert theme="danger">Couldn't load the organization: {errorText(error)}</Alert>}
        <Field label="Organization name" htmlFor="org-name" required error={nameError}>
          <Input id="org-name" inputSize="lg" value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} {...invalidProps("org-name", nameError)} />
        </Field>
        <Field label="Created">
          <span className="text-sm text-muted-foreground">{fmtDate(org?.createdAt)}</span>
        </Field>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={zdr} disabled={!editable} onCheckedChange={(v) => setZdr(v === true)} data-testid="zero-retention" />
          <span>
            Enable zero data retention
            <span className="mt-0.5 block leading-5 text-muted-foreground">AI providers may not store prompts, images or outputs from this organization.</span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={ai} disabled={!editable} onCheckedChange={(v) => setAi(v === true)} data-testid="ai-assist" />
          <span>
            Allow AI suggestions
            <span className="mt-0.5 block leading-5 text-muted-foreground">Members can ask for AI contours and labels. Every suggestion is marked and needs a person to accept it.</span>
          </span>
        </label>
        <Button size="lg" className="w-fit" disabled={!editable || !dirty || !name.trim() || patch.isPending} onClick={save} data-testid="org-settings-save">
          Save changes
        </Button>
      </div>
    </SettingsPage>
  );
}
