import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminPortalIntent,
  ApiKey,
  AuditEvent,
  Invitation,
  Me,
  MemberStatus,
  MySession,
  OrgMember,
  OrgPermission,
  OrgSecurity,
  OrgSettings,
  ProjectGrant,
  ProjectMember,
  ProjectRole,
  Session,
} from "@studio/contracts";
import { apiUrl } from "@/extension-host/runtime-config";
import { notify } from "./files/announce";
import { api, ApiError } from "./projects-api";

/**
 * Organization, members, API keys, security, audit and profile (todo/todo9.md Phases 6, 8–11):
 * apps/api's `/v1/org…`, `/v1/me…` and `/v1/projects/{id}/members` routes. Without the API
 * (seed mode) every query fails; pages show empty lists and their actions stay disabled.
 */

// ---- Keys ----------------------------------------------------------------------------------------

export const orgKeys = {
  all: ["org"] as const,
  settings: () => ["org", "settings"] as const,
  members: () => ["org", "members"] as const,
  invitations: () => ["org", "invitations"] as const,
  apiKeys: () => ["org", "api-keys"] as const,
  security: () => ["org", "security"] as const,
  audit: (f: AuditFilters = {}) => ["org", "audit", f.action ?? "", f.actor ?? ""] as const,
  projectMembers: (projectId: string) => ["projects", projectId, "members"] as const,
  me: () => ["me"] as const,
  mySessions: () => ["me", "sessions"] as const,
  authSession: () => ["auth", "session"] as const,
};

export interface AuditFilters {
  action?: string;
  actor?: string;
}

export interface AuditPage {
  events: AuditEvent[];
  next: string | null;
}

const enc = encodeURIComponent;

// ---- Fetchers ------------------------------------------------------------------------------------

export const fetchOrgSettings = () => api<OrgSettings>("/org");
export const patchOrgSettings = (body: Partial<Pick<OrgSettings, "name" | "zeroRetention" | "aiAssist">>) => api<OrgSettings>("/org", { method: "PATCH", json: body });

export const fetchMembers = () => api<{ members: OrgMember[] }>("/org/members").then((r) => r.members);
export const patchMember = (membershipId: string, role: string) => api<OrgMember>(`/org/members/${enc(membershipId)}`, { method: "PATCH", json: { role } });
export const deleteMember = (membershipId: string) => api<void>(`/org/members/${enc(membershipId)}`, { method: "DELETE" });

export const fetchInvitations = () => api<{ invitations: Invitation[] }>("/org/invitations").then((r) => r.invitations);
export const postInvitations = (body: { emails: string[]; role: string; projects: ProjectGrant[] }) =>
  api<{ invitations: Invitation[] }>("/org/invitations", { method: "POST", json: body }).then((r) => r.invitations);
export const resendInvitation = (id: string) => api<Invitation>(`/org/invitations/${enc(id)}/resend`, { method: "POST" });
export const revokeInvitation = (id: string) => api<void>(`/org/invitations/${enc(id)}`, { method: "DELETE" });

export const fetchProjectMembers = (projectId: string) => api<{ members: ProjectMember[] }>(`/projects/${enc(projectId)}/members`).then((r) => r.members);
export const postProjectMember = (projectId: string, userId: string, role: ProjectRole) => api<ProjectMember>(`/projects/${enc(projectId)}/members`, { method: "POST", json: { userId, role } });
export const patchProjectMember = (projectId: string, userId: string, role: ProjectRole) =>
  api<ProjectMember>(`/projects/${enc(projectId)}/members/${enc(userId)}`, { method: "PATCH", json: { role } });
export const deleteProjectMember = (projectId: string, userId: string) => api<void>(`/projects/${enc(projectId)}/members/${enc(userId)}`, { method: "DELETE" });

export const fetchApiKeys = () => api<{ keys: ApiKey[] }>("/org/api-keys").then((r) => r.keys);
export const postApiKey = (body: { name: string; expiresInDays: number | null; scopes: string[] }) => api<{ key: ApiKey; secret: string }>("/org/api-keys", { method: "POST", json: body });
export const deleteApiKey = (id: string) => api<void>(`/org/api-keys/${enc(id)}`, { method: "DELETE" });

export const fetchSecurity = () => api<OrgSecurity>("/org/security");
export const patchSecurity = (body: { mfaRequired: boolean }) => api<OrgSecurity>("/org/security", { method: "PATCH", json: body });
export const postAdminPortal = (intent: AdminPortalIntent) => api<{ url: string }>("/org/admin-portal", { method: "POST", json: { intent } }).then((r) => r.url);

const auditParams = (f: AuditFilters, before?: string | null, limit = 50) =>
  new URLSearchParams({ ...(f.action ? { action: f.action } : {}), ...(f.actor ? { actor: f.actor } : {}), ...(before ? { before } : {}), limit: String(limit) });
export const fetchAudit = (f: AuditFilters = {}, before?: string | null) => api<AuditPage>(`/org/audit?${auditParams(f, before)}`);
/** The "Export CSV" link: the same filters, served as text/csv by the API. */
export const auditCsvUrl = (f: AuditFilters = {}) => {
  const q = new URLSearchParams({ ...(f.action ? { action: f.action } : {}), ...(f.actor ? { actor: f.actor } : {}) }).toString();
  return apiUrl(`/v1/org/audit.csv${q ? `?${q}` : ""}`);
};

export const fetchMe = () => api<Me>("/me");
export const patchMe = (body: Partial<Pick<Me, "firstName" | "lastName" | "marketing">>) => api<Me>("/me", { method: "PATCH", json: body });
export const fetchMySessions = () => api<{ sessions: MySession[] }>("/me/sessions").then((r) => r.sessions);
export const deleteMySession = (id: string) => api<void>(`/me/sessions/${enc(id)}`, { method: "DELETE" });
export const revokeOtherSessions = () => api<void>("/me/sessions/revoke-others", { method: "POST" });
export const fetchMfaUrl = () => api<{ url: string }>("/me/mfa-url").then((r) => r.url);

export async function fetchAuthSession(): Promise<Session> {
  const res = await fetch(apiUrl("/auth/session"), { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  return res.json() as Promise<Session>;
}

// ---- Errors --------------------------------------------------------------------------------------

/** The sentence to show for a failed call: the API's `detail` (WorkOS's error text passes through there). */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A failed settings write as an error toast with the API's text (pass as a mutation's `onError`). */
export const toastError = (e: unknown) => void notify(errorText(e), { tone: "error", group: "org" });
/** A settings write that worked. */
export const toastDone = (text: string) => void notify(text, { tone: "success", group: "org" });

/**
 * Key creation needs a recent sign-in (Phase 8): the API answers 403
 * `{detail: "step_up_required", loginUrl}`. Returns the URL to send the person through, else null.
 */
export function stepUpUrl(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 403) return null;
  const body = e.body as { detail?: unknown; loginUrl?: unknown } | undefined;
  return body?.detail === "step_up_required" && typeof body.loginUrl === "string" ? body.loginUrl : null;
}

// ---- Query and mutation options (exported for tests; components use the hooks below) ----------------

const stale = 10_000;

export const orgQueries = {
  settings: () => ({ queryKey: orgKeys.settings(), queryFn: fetchOrgSettings, staleTime: stale }),
  members: () => ({ queryKey: orgKeys.members(), queryFn: fetchMembers, staleTime: stale }),
  invitations: () => ({ queryKey: orgKeys.invitations(), queryFn: fetchInvitations, staleTime: stale }),
  projectMembers: (projectId: string) => ({ queryKey: orgKeys.projectMembers(projectId), queryFn: () => fetchProjectMembers(projectId), staleTime: stale }),
  apiKeys: () => ({ queryKey: orgKeys.apiKeys(), queryFn: fetchApiKeys, staleTime: stale }),
  security: () => ({ queryKey: orgKeys.security(), queryFn: fetchSecurity, staleTime: stale }),
  me: () => ({ queryKey: orgKeys.me(), queryFn: fetchMe, staleTime: stale }),
  mySessions: () => ({ queryKey: orgKeys.mySessions(), queryFn: fetchMySessions, staleTime: stale }),
  authSession: () => ({ queryKey: orgKeys.authSession(), queryFn: fetchAuthSession, staleTime: 60_000, retry: false }),
};

/** Every write lands in the audit log, so it's refreshed after each one. */
const auditToo = (qc: QueryClient) => qc.invalidateQueries({ queryKey: ["org", "audit"] });
const invalidate = (qc: QueryClient, ...keys: readonly (readonly unknown[])[]) => Promise.all([...keys.map((queryKey) => qc.invalidateQueries({ queryKey })), auditToo(qc)]);

export const orgMutations = {
  patchOrg: (qc: QueryClient) => ({
    mutationFn: patchOrgSettings,
    onSuccess: (org: OrgSettings) => (qc.setQueryData(orgKeys.settings(), org), invalidate(qc, orgKeys.authSession())),
  }),
  setRole: (qc: QueryClient) => ({ mutationFn: ({ id, role }: { id: string; role: string }) => patchMember(id, role), onSuccess: () => invalidate(qc, orgKeys.members()) }),
  removeMember: (qc: QueryClient) => ({ mutationFn: deleteMember, onSuccess: () => invalidate(qc, orgKeys.members(), ["projects"]) }),
  invite: (qc: QueryClient) => ({ mutationFn: postInvitations, onSuccess: () => invalidate(qc, orgKeys.invitations(), orgKeys.members(), ["projects"]) }),
  resendInvite: (qc: QueryClient) => ({ mutationFn: resendInvitation, onSuccess: () => invalidate(qc, orgKeys.invitations()) }),
  revokeInvite: (qc: QueryClient) => ({ mutationFn: revokeInvitation, onSuccess: () => invalidate(qc, orgKeys.invitations(), orgKeys.members()) }),
  addToProject: (qc: QueryClient, projectId: string) => ({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => postProjectMember(projectId, userId, role),
    onSuccess: () => invalidate(qc, orgKeys.projectMembers(projectId), orgKeys.members()),
  }),
  setProjectRole: (qc: QueryClient, projectId: string) => ({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) => patchProjectMember(projectId, userId, role),
    onSuccess: () => invalidate(qc, orgKeys.projectMembers(projectId)),
  }),
  removeFromProject: (qc: QueryClient, projectId: string) => ({
    mutationFn: (userId: string) => deleteProjectMember(projectId, userId),
    onSuccess: () => invalidate(qc, orgKeys.projectMembers(projectId), orgKeys.members()),
  }),
  createKey: (qc: QueryClient) => ({ mutationFn: postApiKey, onSuccess: () => invalidate(qc, orgKeys.apiKeys()) }),
  revokeKey: (qc: QueryClient) => ({ mutationFn: deleteApiKey, onSuccess: () => invalidate(qc, orgKeys.apiKeys()) }),
  setMfa: (qc: QueryClient) => ({ mutationFn: (mfaRequired: boolean) => patchSecurity({ mfaRequired }), onSuccess: (s: OrgSecurity) => (qc.setQueryData(orgKeys.security(), s), auditToo(qc)) }),
  adminPortal: (qc: QueryClient) => ({ mutationFn: postAdminPortal, onSuccess: () => auditToo(qc) }),
  patchMe: (qc: QueryClient) => ({ mutationFn: patchMe, onSuccess: (me: Me) => (qc.setQueryData(orgKeys.me(), me), invalidate(qc, orgKeys.authSession(), orgKeys.members())) }),
  revokeSession: (qc: QueryClient) => ({ mutationFn: deleteMySession, onSuccess: () => invalidate(qc, orgKeys.mySessions()) }),
  revokeOtherSessions: (qc: QueryClient) => ({ mutationFn: revokeOtherSessions, onSuccess: () => invalidate(qc, orgKeys.mySessions()) }),
  mfaUrl: () => ({ mutationFn: fetchMfaUrl }),
};

// ---- Hooks ---------------------------------------------------------------------------------------

export const useOrgSettings = () => useQuery(orgQueries.settings());
export const useOrgMembers = () => useQuery(orgQueries.members());
/** Pending invitations: only people with `members:manage` may list them. */
export const useInvitations = (enabled = true) => useQuery({ ...orgQueries.invitations(), enabled });
export const useProjectMembers = (projectId: string) => useQuery(orgQueries.projectMembers(projectId));
export const useApiKeys = () => useQuery(orgQueries.apiKeys());
export const useOrgSecurity = () => useQuery(orgQueries.security());
export const useMe = () => useQuery(orgQueries.me());
export const useMySessions = () => useQuery(orgQueries.mySessions());
export const useAuthSession = () => useQuery(orgQueries.authSession());

/** Member counts for the Organization › Projects table, by project id (`undefined` until loaded or when the API is missing). */
export function useProjectMemberCounts(projectIds: string[]): Record<string, number | undefined> {
  return useQueries({
    queries: projectIds.map((id) => orgQueries.projectMembers(id)),
    combine: (results) => Object.fromEntries(projectIds.map((id, i) => [id, results[i]?.data?.length])),
  });
}

/** The audit log, 50 events a page, newest first; `fetchNextPage` follows `next` as `before`. */
export function useAuditLog(f: AuditFilters = {}) {
  return useInfiniteQuery({
    queryKey: orgKeys.audit(f),
    queryFn: ({ pageParam }) => fetchAudit(f, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: stale,
  });
}

export function usePatchOrg() {
  const qc = useQueryClient();
  return useMutation(orgMutations.patchOrg(qc));
}
export function useSetMemberRole() {
  const qc = useQueryClient();
  return useMutation(orgMutations.setRole(qc));
}
export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation(orgMutations.removeMember(qc));
}
export function useInvite() {
  const qc = useQueryClient();
  return useMutation(orgMutations.invite(qc));
}
export function useResendInvite() {
  const qc = useQueryClient();
  return useMutation(orgMutations.resendInvite(qc));
}
export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation(orgMutations.revokeInvite(qc));
}
export function useAddToProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation(orgMutations.addToProject(qc, projectId));
}
export function useSetProjectRole(projectId: string) {
  const qc = useQueryClient();
  return useMutation(orgMutations.setProjectRole(qc, projectId));
}
export function useRemoveFromProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation(orgMutations.removeFromProject(qc, projectId));
}
export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation(orgMutations.createKey(qc));
}
export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation(orgMutations.revokeKey(qc));
}
export function useSetMfaRequired() {
  const qc = useQueryClient();
  return useMutation(orgMutations.setMfa(qc));
}
export function useAdminPortal() {
  const qc = useQueryClient();
  return useMutation(orgMutations.adminPortal(qc));
}
export function usePatchMe() {
  const qc = useQueryClient();
  return useMutation(orgMutations.patchMe(qc));
}
export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation(orgMutations.revokeSession(qc));
}
export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation(orgMutations.revokeOtherSessions(qc));
}
export function useMfaUrl() {
  return useMutation(orgMutations.mfaUrl());
}

// ---- Members table ----------------------------------------------------------------------------------

/** One table row: an organization membership, or a pending invitation. */
export interface MemberRow {
  id: string;
  userId: string | null;
  name: string;
  email: string;
  role: string;
  status: MemberStatus;
  projects: number;
  lastActive: string | null;
  invitedAt: string | null;
  invitation: boolean;
}

const memberRow = (m: OrgMember): MemberRow => ({ ...m, invitedAt: null, invitation: false });
const invitationRow = (i: Invitation): MemberRow => ({ id: i.id, userId: null, name: "", email: i.email, role: i.role, status: "invited", projects: i.projects.length, lastActive: null, invitedAt: i.invitedAt, invitation: true });

/** Members plus pending invitations (a pending membership that has an invitation shows once, as the invitation). */
export function memberRows(members: OrgMember[], invitations: Invitation[]): MemberRow[] {
  const pending = invitations.filter((i) => i.state === "pending");
  const invited = new Set(pending.map((i) => i.email.toLowerCase()));
  return [...members.filter((m) => !(m.status === "invited" && invited.has(m.email.toLowerCase()))).map(memberRow), ...pending.map(invitationRow)];
}

/** The signed-in person's principal, to mark "(you)" and keep them from demoting or removing themselves. */
export const useSelfId = () => useAuthSession().data?.user.id;

// ---- Permissions ---------------------------------------------------------------------------------

/** Whether the session's permissions include `p`; `undefined` (session unknown) counts as allowed. */
export const sessionCan = (session: Pick<Session, "permissions"> | undefined, p: OrgPermission) => !session || session.permissions.includes(p);

/**
 * Gates a control on an organization permission (D5). Reads `GET /api/auth/session`; while it
 * loads, or when it fails (seed mode, dev without the API), everything is allowed and the API
 * still enforces. To be pointed at `useSession().can` from lib/session.ts.
 */
export function usePermission(p: OrgPermission): boolean {
  const { data } = useAuthSession();
  return sessionCan(data, p);
}
