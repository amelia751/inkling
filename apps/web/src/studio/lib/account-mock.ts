/**
 * What's still hard-coded after the settings pages moved onto the API (todo/todo9.md): billing
 * (Phase 12, outside WorkOS) and the account/org fallback the account menu and settings headers
 * use until `GET /api/auth/session` drives them. Members, keys, security, audit and the profile
 * come from `lib/org-api.ts`.
 */

export type { MemberStatus } from "@studio/contracts";

export const ACCOUNT = {
  id: "user_01JD7K2M9X4Q8P1VZTQ9VXTT",
  firstName: "Alex",
  lastName: "Rivera",
  name: "Alex Rivera",
  email: "alex.rivera@example.org",
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
