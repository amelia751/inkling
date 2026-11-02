/**
 * Accounts, organizations, members, API keys, security, audit and profile (todo/todo9.md
 * Phases 3, 6 and 8–11). The shapes of apps/api's `/api/auth/*` and `/api/v1/org…`, `/v1/me…`
 * and `/v1/projects/{id}/members` routes. JSON is camelCase; times are ISO-8601 UTC strings.
 */

/** Organization roles (WorkOS environment roles, D5). Code checks permissions, never slugs. */
export type OrgRole = "admin" | "member" | "billing";
/** Project roles (the `project_members` table, D5). `owner` is shown as "Project admin". */
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

/** A role's display name; unknown slugs (custom per-org WorkOS roles) show as themselves. */
export const roleName = (slug: string) => [...ORG_ROLES, ...PROJECT_ROLES].find((r) => r.slug === slug)?.name ?? slug;

/** Organization permissions carried in the session (D5). */
export const ORG_PERMISSIONS = ["org:manage", "members:manage", "billing:manage", "apikeys:manage", "audit:read", "project:create"] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

/** Scopes an organization API key may carry (Phase 8); they map to kernel scopes. */
export const API_KEY_SCOPES = [
  { id: "datasets:read", label: "Read datasets and exports" },
  { id: "annotations:write", label: "Write annotations" },
  { id: "environments:write", label: "Change Studio environments" },
  { id: "studio:tools", label: "Run Studio tools (MCP, agents)" },
  { id: "admin", label: "Manage the organization" },
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]["id"];

// ---- Session (`GET /api/auth/session`) -----------------------------------------------------------

export interface SessionUser {
  /** Principal, `user:<workos user id>` (D3). */
  id: string;
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface SessionOrg {
  /** Our organization id. */
  id: string;
  workosOrgId: string | null;
  name: string;
}

export interface Session {
  mode: "dev" | "workos";
  user: SessionUser;
  organization: SessionOrg;
  /** Role slug in the current organization. */
  role: string;
  permissions: string[];
  organizations: SessionOrg[];
  impersonator: { email: string; reason: string | null } | null;
  expiresAt: string | null;
}

// ---- Organization, members and invitations (Phase 6) ---------------------------------------------

export interface VerifiedDomain {
  domain: string;
  state: "verified" | "pending";
}

export interface OrgMember {
  /** Membership id (WorkOS `om_…` or ours); the id the member routes take. */
  id: string;
  /** Principal. */
  userId: string;
  name: string;
  email: string;
  role: OrgRole | string;
  status: MemberStatus;
  projects: number;
  lastActive: string | null;
  sso: boolean;
}

export interface ProjectGrant {
  projectId: string;
  role: ProjectRole;
}

export interface Invitation {
  id: string;
  email: string;
  role: string;
  state: "pending" | "accepted" | "expired" | "revoked";
  invitedAt: string;
  expiresAt: string | null;
  projects: ProjectGrant[];
}

export interface ProjectMember {
  projectId: string;
  /** Principal. */
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  addedBy: string | null;
  addedAt: string;
}

export interface OrgSettings {
  id: string;
  workosOrgId: string | null;
  name: string;
  createdAt: string;
  zeroRetention: boolean;
  aiAssist: boolean;
  domains: VerifiedDomain[];
}

// ---- API keys (Phase 8) --------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  name: string;
  /** Obfuscated value, safe to show. */
  prefix: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  scopes: string[];
}

// ---- Security (Phase 9) --------------------------------------------------------------------------

export type AdminPortalIntent = "sso" | "dsync" | "domain_verification" | "audit_logs" | "log_streams";

export interface OrgSecurity {
  mfaRequired: boolean;
  /** False when the MFA policy can only be changed in the WorkOS dashboard. */
  mfaEditable: boolean;
  methods: { id: string; name: string; on: boolean }[];
  sso: null | { provider: string; state: "active" | "draft" | "inactive" };
  directory: null | { provider: string; users: number; groups: number };
  domains: VerifiedDomain[];
  /** Environment-wide in WorkOS, so read-only here. */
  sessionHours: number;
}

// ---- Audit (Phase 10) ----------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  at: string;
  /** Display name or principal. */
  actor: string;
  actorId: string;
  action: string;
  target: string;
  ip: string | null;
}

// ---- Profile (Phase 11) --------------------------------------------------------------------------

export interface Me {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  marketing: boolean;
  /** Profile fields come from the organization's identity provider. */
  ssoManaged: boolean;
}

export interface MySession {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string | null;
}
