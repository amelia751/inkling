import { create } from "zustand";

/**
 * Accounts, organizations, members and billing, hard-coded until WorkOS lands (todo/todo9.md).
 * The shapes follow WorkOS's objects (User, Organization, OrganizationMembership, Invitation,
 * role slugs) so the API swap only changes where the data comes from. In-memory: a reload resets it.
 */

export type OrgRole = "admin" | "member" | "billing";
export type ProjectRole = "owner" | "reviewer" | "annotator" | "viewer";
export type MemberStatus = "active" | "invited" | "deactivated";

export interface RoleInfo<R extends string> {
  slug: R;
  name: string;
  description: string;
}

export const ORG_ROLES: RoleInfo<OrgRole>[] = [
  { slug: "admin", name: "Admin", description: "Full access to organization settings, billing, security and every project. Can invite people and change their access." },
  { slug: "member", name: "Member", description: "Can create projects and work in the projects they're added to. Can't change organization settings or billing." },
  { slug: "billing", name: "Billing manager", description: "Can manage billing details and see usage across the organization. Can't open projects or invite people." },
];

export const PROJECT_ROLES: RoleInfo<ProjectRole>[] = [
  { slug: "owner", name: "Project admin", description: "Everything in the project: settings, plugins, members, publishing datasets." },
  { slug: "reviewer", name: "Reviewer", description: "Annotates, and approves or rejects others' work in Review." },
  { slug: "annotator", name: "Annotator", description: "Labels items in the Studio. Their work goes to review." },
  { slug: "viewer", name: "Viewer", description: "Opens the project and its datasets read-only." },
];

export const roleName = (slug: string) => [...ORG_ROLES, ...PROJECT_ROLES].find((r) => r.slug === slug)?.name ?? slug;

export const ACCOUNT = {
  id: "user_01JD7K2M9X4Q8P1VZTQ9VXTT",
  firstName: "Anh",
  lastName: "Lam",
  name: "Anh Lam",
  email: "amelia.anh.lam@gmail.com",
  marketing: false,
};

export const ORG = {
  id: "org_01JD3HQ8N2C7R5W1B4FJHJGV0G",
  name: "Personal",
  createdAt: "2026-09-02T10:14:00Z",
  balance: 0,
  zeroRetention: true,
  aiAssist: true,
  domains: [] as { domain: string; state: "verified" | "pending" }[],
};

export interface Member {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  status: MemberStatus;
  projects: number;
  lastActive?: string;
  invitedAt?: string;
  sso?: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  scopes: string[];
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  ip: string;
}

const MEMBERS: Member[] = [
  { id: ACCOUNT.id, name: ACCOUNT.name, email: ACCOUNT.email, role: "admin", status: "active", projects: 6, lastActive: "2026-10-30T22:10:00Z" },
  { id: "user_01JD9A4C6E8G0J2L4N6Q8S0U2W", name: "Dr. Maya Okafor", email: "maya.okafor@example.org", role: "member", status: "active", projects: 3, lastActive: "2026-10-30T15:42:00Z" },
  { id: "user_01JDB2D4F6H8K0M2P4R6T8V0X2", name: "Lucas Moreau", email: "lucas.moreau@example.org", role: "member", status: "active", projects: 2, lastActive: "2026-10-28T09:05:00Z" },
  { id: "user_01JDC8E0G2J4L6N8Q0S2U4W6Y8", name: "Priya Raman", email: "priya.raman@example.org", role: "billing", status: "active", projects: 0, lastActive: "2026-10-21T17:30:00Z" },
  { id: "inv_01JDF1H3K5M7P9R1T3V5X7Z9B1", name: "", email: "jonas.berg@example.org", role: "member", status: "invited", projects: 1, invitedAt: "2026-10-29T11:00:00Z" },
];

/** Who has which role in each project (keyed by project id; unknown projects fall back to `DEFAULT_PROJECT_MEMBERS`). */
export interface ProjectMember {
  userId: string;
  role: ProjectRole;
}
const DEFAULT_PROJECT_MEMBERS: ProjectMember[] = [
  { userId: ACCOUNT.id, role: "owner" },
  { userId: "user_01JD9A4C6E8G0J2L4N6Q8S0U2W", role: "reviewer" },
  { userId: "user_01JDB2D4F6H8K0M2P4R6T8V0X2", role: "annotator" },
];

const API_KEYS: ApiKey[] = [
  { id: "key_01JDG5", name: "Hospital PACS sync", prefix: "ink_sk_live_7Hq2", createdBy: ACCOUNT.name, createdAt: "2026-10-03T08:20:00Z", expiresAt: "2027-04-03T00:00:00Z", lastUsedAt: "2026-10-30T21:58:00Z", scopes: ["datasets:read", "annotations:write"] },
  { id: "key_01JDH9", name: "Claude Desktop (MCP)", prefix: "ink_sk_live_c9Lm", createdBy: "Dr. Maya Okafor", createdAt: "2026-10-18T14:02:00Z", expiresAt: null, lastUsedAt: "2026-10-29T10:11:00Z", scopes: ["studio:tools"] },
];

const AUDIT: AuditEvent[] = [
  { id: "ae1", at: "2026-10-30T22:04:00Z", actor: ACCOUNT.name, action: "dataset.published", target: "Chest X-ray · Pneumonia / v3", ip: "203.0.113.24" },
  { id: "ae2", at: "2026-10-30T15:40:00Z", actor: "Dr. Maya Okafor", action: "review.approved", target: "Brain MRI · BraTS 2021 / 48 items", ip: "198.51.100.7" },
  { id: "ae3", at: "2026-10-29T11:00:00Z", actor: ACCOUNT.name, action: "invitation.sent", target: "jonas.berg@example.org", ip: "203.0.113.24" },
  { id: "ae4", at: "2026-10-28T09:12:00Z", actor: "Lucas Moreau", action: "user.signed_in", target: "Password + authenticator app", ip: "192.0.2.61" },
  { id: "ae5", at: "2026-10-21T17:31:00Z", actor: "Priya Raman", action: "billing.details_updated", target: "Billing address", ip: "198.51.100.40" },
  { id: "ae6", at: "2026-10-18T14:02:00Z", actor: "Dr. Maya Okafor", action: "api_key.created", target: "Claude Desktop (MCP)", ip: "198.51.100.7" },
  { id: "ae7", at: "2026-10-03T08:20:00Z", actor: ACCOUNT.name, action: "api_key.created", target: "Hospital PACS sync", ip: "203.0.113.24" },
];

export const AUDIT_ACTIONS = [...new Set(AUDIT.map((e) => e.action))].sort();

export const USAGE = [
  { product: "AI suggestions", detail: "Contours, labels, triage", region: "eu-north1", usage: 1_284, unit: "requests", cost: 0 },
  { product: "Inspection jobs", detail: "Quality checks on upload", region: "eu-north1", usage: 37.5, unit: "CPU hours", cost: 0 },
  { product: "Storage", detail: "Sources and annotations", region: "eu-north1", usage: 182.4, unit: "GB-month", cost: 0 },
  { product: "Agent sandboxes", detail: "Code the assistant runs", region: "eu-north1", usage: 6.2, unit: "sandbox hours", cost: 0 },
];

export const INVOICES = [
  { number: "INK-2026-10-0001", kind: "Invoice", issuedAt: "2026-10-01T00:00:00Z", status: "paid" as const, total: 0 },
  { number: "INK-2026-09-0001", kind: "Invoice", issuedAt: "2026-09-01T00:00:00Z", status: "paid" as const, total: 0 },
];

export const BILLING_DETAILS = {
  payer: { Type: "Individual", Name: ACCOUNT.name },
  address: { Country: "—", State: "—", City: "—", "Postal code": "—", Address: "—" },
  payment: { Method: "Not set", Currency: "USD", "Payment system": "—", "Bank card": "—" },
};

/** Sign-in and provisioning: what the WorkOS Admin Portal will configure. */
export const AUTH = {
  methods: [
    { id: "password", name: "Email and password", on: true },
    { id: "google", name: "Google", on: true },
    { id: "microsoft", name: "Microsoft", on: false },
    { id: "magic", name: "Magic link", on: false },
  ],
  mfaRequired: false,
  sso: null as null | { provider: string; state: "active" | "draft" },
  directory: null as null | { provider: string; users: number; groups: number },
  sessionHours: 12,
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}_mock${Date.now().toString(36)}${(seq++).toString(36)}`;

interface AccountState {
  members: Member[];
  projectMembers: Record<string, ProjectMember[]>;
  apiKeys: ApiKey[];
  audit: AuditEvent[];
  log: (action: string, target: string) => void;
  invite: (email: string, role: OrgRole, projects: { projectId: string; role: ProjectRole }[]) => void;
  resendInvite: (id: string) => void;
  revokeInvite: (id: string) => void;
  setRole: (id: string, role: OrgRole) => void;
  removeMember: (id: string) => void;
  projectTeam: (projectId: string) => ProjectMember[];
  addToProject: (projectId: string, userId: string, role: ProjectRole) => void;
  setProjectRole: (projectId: string, userId: string, role: ProjectRole) => void;
  removeFromProject: (projectId: string, userId: string) => void;
  createKey: (name: string, expiresInDays: number | null, scopes: string[]) => { key: ApiKey; secret: string };
  revokeKey: (id: string) => void;
}

export const useAccount = create<AccountState>((set, get) => ({
  members: MEMBERS,
  projectMembers: {},
  apiKeys: API_KEYS,
  audit: AUDIT,
  log: (action, target) =>
    set((s) => ({ audit: [{ id: nextId("ae"), at: new Date().toISOString(), actor: ACCOUNT.name, action, target, ip: "203.0.113.24" }, ...s.audit] })),
  invite: (email, role, projects) => {
    const id = nextId("inv");
    set((s) => ({
      members: [...s.members, { id, name: "", email, role, status: "invited", projects: projects.length, invitedAt: new Date().toISOString() }],
      projectMembers: projects.reduce((acc, p) => ({ ...acc, [p.projectId]: [...get().projectTeam(p.projectId), { userId: id, role: p.role }] }), s.projectMembers),
    }));
    get().log("invitation.sent", email);
  },
  resendInvite: (id) => {
    set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, invitedAt: new Date().toISOString() } : m)) }));
    get().log("invitation.resent", get().members.find((m) => m.id === id)?.email ?? id);
  },
  revokeInvite: (id) => {
    const m = get().members.find((x) => x.id === id);
    set((s) => ({ members: s.members.filter((x) => x.id !== id) }));
    get().log("invitation.revoked", m?.email ?? id);
  },
  setRole: (id, role) => {
    set((s) => ({ members: s.members.map((m) => (m.id === id ? { ...m, role } : m)) }));
    get().log("member.role_changed", `${get().members.find((m) => m.id === id)?.email} → ${roleName(role)}`);
  },
  removeMember: (id) => {
    const m = get().members.find((x) => x.id === id);
    set((s) => ({ members: s.members.filter((x) => x.id !== id) }));
    get().log("member.removed", m?.email ?? id);
  },
  projectTeam: (projectId) => get().projectMembers[projectId] ?? DEFAULT_PROJECT_MEMBERS,
  addToProject: (projectId, userId, role) => {
    set((s) => ({ projectMembers: { ...s.projectMembers, [projectId]: [...get().projectTeam(projectId).filter((p) => p.userId !== userId), { userId, role }] } }));
    get().log("project.member_added", `${get().members.find((m) => m.id === userId)?.email} as ${roleName(role)}`);
  },
  setProjectRole: (projectId, userId, role) =>
    set((s) => ({ projectMembers: { ...s.projectMembers, [projectId]: get().projectTeam(projectId).map((p) => (p.userId === userId ? { ...p, role } : p)) } })),
  removeFromProject: (projectId, userId) =>
    set((s) => ({ projectMembers: { ...s.projectMembers, [projectId]: get().projectTeam(projectId).filter((p) => p.userId !== userId) } })),
  createKey: (name, expiresInDays, scopes) => {
    const secret = `ink_sk_live_${Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32)}`;
    const key: ApiKey = {
      id: nextId("key"),
      name,
      prefix: secret.slice(0, 16),
      createdBy: ACCOUNT.name,
      createdAt: new Date().toISOString(),
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null,
      lastUsedAt: null,
      scopes,
    };
    set((s) => ({ apiKeys: [key, ...s.apiKeys] }));
    get().log("api_key.created", name);
    return { key, secret };
  },
  revokeKey: (id) => {
    const k = get().apiKeys.find((x) => x.id === id);
    set((s) => ({ apiKeys: s.apiKeys.filter((x) => x.id !== id) }));
    get().log("api_key.revoked", k?.name ?? id);
  },
}));

export const API_KEY_SCOPES = [
  { id: "datasets:read", label: "Read datasets and exports" },
  { id: "annotations:write", label: "Write annotations" },
  { id: "studio:tools", label: "Run Studio tools (MCP, agents)" },
  { id: "admin", label: "Manage the organization" },
];
