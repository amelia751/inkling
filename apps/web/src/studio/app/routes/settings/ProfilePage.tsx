import { useEffect, useState } from "react";
import { FingerprintIcon, SignOutIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Input } from "@studio/ui/ui/input";
import { Loader } from "@studio/ui/ui/loader";
import type { MySession } from "@studio/contracts";
import { CopyId, DataTable, Field, fmtDateTime, invalidProps, SettingsPage, type Column } from "@/studio/components/settings/kit";
import { errorText, toastDone, toastError, useMe, useMfaUrl, useMySessions, usePatchMe, useRevokeOtherSessions, useRevokeSession } from "@/studio/lib/org-api";

/** "Chrome on macOS" from a user agent; the raw string when it isn't recognised. */
function deviceName(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? ua;
}

/** User settings › Your profile (Nebius /settings/profile), plus sign-in security and sessions. */
export function ProfilePage() {
  const { data: me, isError, error } = useMe();
  const patch = usePatchMe();
  const sessions = useMySessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const mfa = useMfaUrl();
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [marketing, setMarketing] = useState(false);
  // The form starts from the saved profile, and again after each save.
  useEffect(() => {
    if (!me) return;
    setFirst(me.firstName ?? "");
    setLast(me.lastName ?? "");
    setMarketing(me.marketing);
  }, [me]);
  const managed = !!me?.ssoManaged;
  const firstError = me && !managed && !first.trim() ? "Enter your first name" : null;
  const dirty = !!me && (first !== (me.firstName ?? "") || last !== (me.lastName ?? "") || marketing !== me.marketing);
  const save = () => {
    if (!me) return;
    const body = managed ? { marketing } : { firstName: first.trim(), lastName: last.trim(), marketing };
    patch.mutate(body, { onSuccess: () => toastDone("Profile saved"), onError: toastError });
  };
  // Hosted MFA enrollment (AuthKit): the link is fetched on click and opened in this tab.
  const setUpMfa = () => mfa.mutate(undefined, { onSuccess: (url) => window.location.assign(url), onError: toastError });
  const rows = sessions.data ?? [];
  const others = rows.filter((s) => !s.current).length;
  const columns: Column<MySession>[] = [
    {
      key: "device",
      label: "Device",
      render: (s) => (
        <span className="flex items-center gap-2 font-semibold" title={s.userAgent ?? undefined}>
          {deviceName(s.userAgent)}
          {s.current && <Badge theme="info">This device</Badge>}
        </span>
      ),
    },
    { key: "where", label: "IP address", render: (s) => <span className="font-mono text-code text-muted-foreground">{s.ipAddress ?? "—"}</span> },
    { key: "since", label: "Signed in", render: (s) => <span className="text-muted-foreground">{fmtDateTime(s.createdAt)}</span> },
    {
      key: "end",
      label: <span className="sr-only">Actions</span>,
      className: "w-28 text-right",
      render: (s) =>
        s.current ? null : (
          <Button variant="ghost-secondary" disabled={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id, { onError: toastError })}>
            Sign out
          </Button>
        ),
    },
  ];
  return (
    <SettingsPage scope="personal" title="Your profile" testId="profile-page">
      <div className="flex max-w-[458px] flex-col gap-6">
        {isError && <Alert theme="danger">Couldn't load your profile: {errorText(error)}</Alert>}
        <Field label="User ID">{me ? <CopyId id={me.id} /> : <span className="text-sm text-muted-foreground">—</span>}</Field>
        <Field label="Email" description={managed ? "Managed by your organization." : undefined}>
          <span className="text-sm">{me?.email ?? "—"}</span>
        </Field>
        <Field label="First name" htmlFor="first-name" required={!managed} error={firstError} description={managed ? "Your name comes from your organization's identity provider." : undefined}>
          <Input id="first-name" inputSize="lg" value={first} disabled={!me || managed} onChange={(e) => setFirst(e.target.value)} {...invalidProps("first-name", firstError)} />
        </Field>
        <Field label="Last name" htmlFor="last-name">
          <Input id="last-name" inputSize="lg" value={last} disabled={!me || managed} onChange={(e) => setLast(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2.5 text-sm">
          <Checkbox checked={marketing} disabled={!me} onCheckedChange={(v) => setMarketing(v === true)} data-testid="profile-marketing" />
          Product updates and research programs by email
        </label>
        <Button size="lg" className="w-fit" disabled={!dirty || !!firstError || patch.isPending} onClick={save} data-testid="profile-save">
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
              <p className="mt-1 text-sm text-muted-foreground">
                {managed ? "You sign in with your organization's SSO, which handles multi-factor authentication." : "Ask for a code from an authenticator app when you sign in with a password."}
              </p>
            </div>
          </div>
          {!managed && (
            <Button variant="outline" size="lg" disabled={!me || mfa.isPending} onClick={setUpMfa} data-testid="mfa-setup">
              {mfa.isPending ? <Loader size="s" /> : null} Set up
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-body-3 font-semibold">Active sessions</h3>
          <Button
            variant="outline"
            size="lg"
            disabled={others === 0 || revokeOthers.isPending}
            onClick={() => revokeOthers.mutate(undefined, { onSuccess: () => toastDone("Signed out of your other sessions"), onError: toastError })}
            data-testid="sessions-revoke-others"
          >
            <SignOutIcon /> Sign out other sessions
          </Button>
        </div>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          empty={
            sessions.isLoading ? (
              <span className="inline-flex items-center gap-2">
                <Loader size="s" /> Loading sessions
              </span>
            ) : sessions.isError ? (
              `Couldn't load your sessions: ${errorText(sessions.error)}`
            ) : (
              "No active sessions."
            )
          }
          testId="sessions-table"
        />
      </div>
    </SettingsPage>
  );
}
