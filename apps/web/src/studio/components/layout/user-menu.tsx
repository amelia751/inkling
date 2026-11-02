import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { CheckIcon, ChevronDownIcon, CopyIcon, InfoIcon, TopUpIcon } from "@studio/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { ThemeSwitch } from "@/studio/components/layout/theme-switch";
import { ORG } from "@/studio/lib/account-mock";
import { logout, useSession } from "@/studio/lib/session";
import { billingUrl, orgUrl, profileUrl, settingsUrl } from "@/studio/lib/routes";
import { cn } from "@studio/ui/utils";

/** `user_01J...q9vxtt`: both ends, so the id stays on one line beside its label. */
const shortId = (id: string) => (id.length > 17 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id);

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };
  return { copied, copy };
}

/** The signed-in person's menu (avatar, top right), measured from the Nebius console's. */
export function UserMenu({ className }: { className?: string }) {
  const { projectId } = useParams();
  const { copied, copy } = useCopy();
  const { user, organization, mode } = useSession();
  // What support and the WorkOS dashboard know them by; our ids when there's no WorkOS one (dev).
  const userId = user.workosUserId || user.id;
  const orgId = organization.workosOrgId ?? organization.id;
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    if (mode === "dev") {
      toast.info("Dev mode has no sign-in", { description: "Everyone is the dev user. Set the auth mode to workos to sign in and out." });
      return;
    }
    setLeaving(true);
    try {
      window.location.assign(await logout());
    } catch (e) {
      setLeaving(false);
      toast.error("Couldn't log out", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex h-9 w-[60px] shrink-0 items-center gap-1 rounded-full bg-generic p-0.5 transition-colors duration-200 hover:bg-generic-accent focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-generic-accent",
            className,
          )}
          aria-label={`Account: ${user.name}`}
          data-testid="user-menu"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-misc text-sm text-white" aria-hidden>
            {(user.name || user.email).charAt(0).toUpperCase()}
          </span>
          <ChevronDownIcon className="size-4 text-hint transition-transform group-hover:text-foreground group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={14} className="w-[280px] overflow-hidden p-0 leading-5" data-testid="user-menu-content">
        <section className="flex flex-col gap-1 p-5">
          <p className="truncate text-[14px] font-semibold leading-[22px]" data-testid="user-menu-name">{user.name}</p>
          <p className="truncate text-sm leading-5 text-complementary" data-testid="user-menu-email">{user.email}</p>
          <table className="mt-1 text-sm">
            <tbody>
              <IdRow label="User ID" id={userId} copied={copied === "user"} onCopy={() => copy("user", userId)} />
              <IdRow label="Org ID" id={orgId} copied={copied === "org"} onCopy={() => copy("org", orgId)} spaced />
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => copy("both", `User ID: ${userId}\nOrganization ID: ${orgId}`)}
            className="press mt-3 inline-flex h-7 w-fit items-center gap-2 rounded-lg bg-generic px-3 text-sm hover:bg-generic-hover"
            data-testid="copy-ids"
          >
            {copied === "both" ? "Copied" : "Copy user and organization IDs"}
            {copied === "both" ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
          </button>
        </section>

        <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
          <p className="truncate text-[14px] font-semibold leading-[22px]" data-testid="user-menu-org">Organization {organization.name}</p>
          <div className="flex items-center justify-between">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex cursor-help items-center gap-1 text-sm leading-5 text-complementary">
                  Account balance <InfoIcon className="size-3 text-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Credits for AI suggestions and inspection jobs in this organization</TooltipContent>
            </Tooltip>
            {/* Billing stays mocked until a billing provider is chosen (todo9 Phase 12). */}
            <span className="tnum text-[14px] font-semibold leading-[22px]">${ORG.balance.toFixed(2)}</span>
          </div>
          <Link to={billingUrl("details")} className="press flex h-7 w-full items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-generic">
            <TopUpIcon className="size-4" /> Top up account balance
          </Link>
        </section>

        <ul className="flex flex-col gap-1 border-t border-border py-3">
          <Item to={orgUrl()}>Organization settings</Item>
          <Item to={billingUrl()}>Billing settings</Item>
          {projectId ? (
            <li>
              <DropdownMenuItem asChild className={ITEM}>
                <Link to={settingsUrl(projectId)}>Project settings</Link>
              </DropdownMenuItem>
            </li>
          ) : (
            <Item disabled>Project settings</Item>
          )}
          <Item to={profileUrl()}>User settings</Item>
          <li>
            <DropdownMenuItem className={ITEM} disabled={leaving} onSelect={() => void signOut()} data-testid="log-out">
              {leaving ? "Logging out…" : "Log out"}
            </DropdownMenuItem>
          </li>
        </ul>

        <div className="border-t border-border p-4">
          <ThemeSwitch className="w-full [&>*]:flex-1" />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ITEM = "min-h-9 cursor-pointer rounded-none px-5 py-0 text-[14px] leading-[22px] focus:bg-generic-hover focus:text-foreground";

function Item({ children, disabled, to }: { children: ReactNode; disabled?: boolean; to?: string }) {
  return (
    <li>
      <DropdownMenuItem disabled={disabled} className={ITEM} asChild={!!to}>
        {to ? <Link to={to}>{children}</Link> : children}
      </DropdownMenuItem>
    </li>
  );
}

/** One id: the whole shortened value is the copy button, its hover pill bleeding 6px left of the column. */
function IdRow({ label, id, copied, onCopy, spaced }: { label: string; id: string; copied: boolean; onCopy: () => void; spaced?: boolean }) {
  return (
    <tr>
      <td className={cn("whitespace-nowrap pr-1 align-middle text-muted-foreground", spaced && "pt-2")}>{label}:</td>
      <td className={cn("align-middle", spaced && "pt-2")}>
        <button
          type="button"
          onClick={onCopy}
          title={id}
          className="-ml-1.5 inline-flex h-5 items-center whitespace-nowrap gap-1 rounded-full px-1.5 hover:bg-generic-hover"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          <span className="font-mono text-code leading-[14px] text-muted-foreground">{shortId(id)}</span>
          {copied ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
        </button>
      </td>
    </tr>
  );
}
