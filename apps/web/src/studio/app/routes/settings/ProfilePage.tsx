import { useState } from "react";
import { FingerprintIcon, SignOutIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Input } from "@studio/ui/ui/input";
import { CopyId, DataTable, Field, invalidProps, SettingsPage, type Column } from "@/studio/components/settings/kit";
import { ACCOUNT, useAccount } from "@/studio/lib/account-mock";

interface Session {
  id: string;
  device: string;
  where: string;
  seen: string;
  current?: boolean;
}

const SESSIONS: Session[] = [
  { id: "s1", device: "Chrome on macOS", where: "203.0.113.24", seen: "Now", current: true },
  { id: "s2", device: "Safari on iPad", where: "198.51.100.12", seen: "2 days ago" },
];

/** User settings › Your profile (Nebius /settings/profile), plus sign-in security and sessions. */
export function ProfilePage() {
  const log = useAccount((s) => s.log);
  const [first, setFirst] = useState(ACCOUNT.firstName);
  const firstError = first.trim() ? null : "Enter your first name";
  const [last, setLast] = useState(ACCOUNT.lastName);
  const [marketing, setMarketing] = useState(ACCOUNT.marketing);
  const [sessions, setSessions] = useState(SESSIONS);
  const dirty = first !== ACCOUNT.firstName || last !== ACCOUNT.lastName || marketing !== ACCOUNT.marketing;
  const save = () => {
    Object.assign(ACCOUNT, { firstName: first, lastName: last, name: `${first} ${last}`.trim(), marketing });
    log("user.profile_updated", ACCOUNT.name);
    setFirst(first);
  };
  const columns: Column<Session>[] = [
    {
      key: "device",
      label: "Device",
      render: (s) => (
        <span className="flex items-center gap-2 font-semibold">
          {s.device}
          {s.current && <Badge theme="info">This device</Badge>}
        </span>
      ),
    },
    { key: "where", label: "IP address", render: (s) => <span className="font-mono text-code text-muted-foreground">{s.where}</span> },
    { key: "seen", label: "Last active", render: (s) => <span className="text-muted-foreground">{s.seen}</span> },
    {
      key: "end",
      label: <span className="sr-only">Actions</span>,
      className: "w-28 text-right",
      render: (s) =>
        s.current ? null : (
          <Button variant="ghost-secondary" onClick={() => setSessions(sessions.filter((x) => x.id !== s.id))}>
            Sign out
          </Button>
        ),
    },
  ];
  return (
    <SettingsPage scope="personal" title="Your profile" testId="profile-page">
      <div className="flex max-w-[458px] flex-col gap-6">
        <Field label="User ID">
          <CopyId id={ACCOUNT.id} />
        </Field>
        <Field label="Email">
          <span className="text-sm">{ACCOUNT.email}</span>
        </Field>
        <Field label="First name" htmlFor="first-name" required error={firstError}>
          <Input id="first-name" inputSize="lg" value={first} onChange={(e) => setFirst(e.target.value)} {...invalidProps("first-name", firstError)} />
        </Field>
        <Field label="Last name" htmlFor="last-name">
          <Input id="last-name" inputSize="lg" value={last} onChange={(e) => setLast(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2.5 text-sm">
          <Checkbox checked={marketing} onCheckedChange={(v) => setMarketing(v === true)} />
          Product updates and research programs by email
        </label>
        <Button size="lg" className="w-fit" disabled={!dirty || !first.trim()} onClick={save}>
          Save changes
        </Button>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <h2 className="text-header-1 font-semibold">Sign-in and security</h2>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-5">
          <div className="flex items-start gap-3">
            <FingerprintIcon className="mt-0.5 size-4 text-muted-foreground" />
            <div>
              <div className="text-body-3 font-semibold">Authenticator app</div>
              <p className="mt-1 text-sm text-muted-foreground">Ask for a code from an authenticator app when you sign in with a password.</p>
            </div>
          </div>
          <Button variant="outline" size="lg" onClick={() => log("user.mfa_enrollment_started", ACCOUNT.email)}>
            Set up
          </Button>
        </div>
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-body-3 font-semibold">Active sessions</h3>
          <Button variant="outline" size="lg" disabled={sessions.length < 2} onClick={() => setSessions(sessions.filter((s) => s.current))}>
            <SignOutIcon /> Sign out other sessions
          </Button>
        </div>
        <DataTable columns={columns} rows={sessions} rowKey={(s) => s.id} testId="sessions-table" />
      </div>
    </SettingsPage>
  );
}
