import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CheckIcon, ChevronDownIcon, ContactIcon, CopyIcon, DocsIcon, ExternalLinkIcon, InfoIcon, TopUpIcon } from "@studio/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { ThemeSwitch } from "@/studio/components/layout/theme-switch";
import { ACCOUNT, ORG } from "@/studio/lib/account-mock";
import { billingUrl, orgUrl, profileUrl, settingsUrl } from "@/studio/lib/routes";
import { cn } from "@studio/ui/utils";

const LINKS = { contact: "mailto:support@example.com", docs: "https://docs.example.com" };

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

const HEADER_LINK = "press flex h-7 items-center gap-2 rounded-lg px-3 text-sm text-complementary hover:bg-generic-hover hover:text-foreground [&_svg]:size-4";

/** "Contact us" and "Documentation ↗", then a divider, left of the account menu. */
export function HeaderLinks({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <a href={LINKS.contact} className={HEADER_LINK}>
        <ContactIcon /> Contact us
      </a>
      <a href={LINKS.docs} target="_blank" rel="noreferrer" className={HEADER_LINK}>
        <DocsIcon /> Documentation <ExternalLinkIcon />
      </a>
      <div className="h-5 w-px bg-generic-accent" aria-hidden />
    </div>
  );
}

/** The signed-in person's menu (avatar, top right), measured from the Nebius console's. */
export function UserMenu({ className }: { className?: string }) {
  const { projectId } = useParams();
  const { copied, copy } = useCopy();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex h-9 w-[60px] shrink-0 items-center gap-1 rounded-full bg-generic p-0.5 transition-colors duration-200 hover:bg-generic-accent focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-generic-accent",
            className,
          )}
          aria-label={`Account: ${ACCOUNT.name}`}
          data-testid="user-menu"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-misc text-sm text-white" aria-hidden>
            {ACCOUNT.name.charAt(0).toUpperCase()}
          </span>
          <ChevronDownIcon className="size-4 text-hint transition-transform group-hover:text-foreground group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={14} className="w-[280px] overflow-hidden p-0 leading-5" data-testid="user-menu-content">
        <section className="flex flex-col gap-1 p-5">
          <p className="truncate text-[14px] font-semibold leading-[22px]">{ACCOUNT.name}</p>
          <p className="truncate text-sm leading-5 text-complementary">{ACCOUNT.email}</p>
          <table className="mt-1 text-sm">
            <tbody>
              <IdRow label="User ID" id={ACCOUNT.id} copied={copied === "user"} onCopy={() => copy("user", ACCOUNT.id)} />
              <IdRow label="Org ID" id={ORG.id} copied={copied === "org"} onCopy={() => copy("org", ORG.id)} spaced />
            </tbody>
          </table>
          <button
            type="button"
            onClick={() => copy("both", `User ID: ${ACCOUNT.id}\nOrganization ID: ${ORG.id}`)}
            className="press mt-3 inline-flex h-7 w-fit items-center gap-2 rounded-lg bg-generic px-3 text-sm hover:bg-generic-hover"
            data-testid="copy-ids"
          >
            {copied === "both" ? "Copied" : "Copy user and organization IDs"}
            {copied === "both" ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
          </button>
        </section>

        <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
          <p className="truncate text-[14px] font-semibold leading-[22px]">Organization {ORG.name}</p>
          <div className="flex items-center justify-between">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex cursor-help items-center gap-1 text-sm leading-5 text-complementary">
                  Account balance <InfoIcon className="size-3 text-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent>Credits for AI suggestions and inspection jobs in this organization</TooltipContent>
            </Tooltip>
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
          <Item>Log out</Item>
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
