import { useState } from "react";
import { Link, useParams } from "react-router";
import { CheckIcon, ChevronDownIcon, CopyIcon, InfoIcon, TopUpIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { ThemeSwitch } from "@/studio/components/layout/theme-switch";
import { settingsUrl } from "@/studio/lib/routes";
import { cn } from "@studio/ui/utils";

/** Hard-coded until accounts exist: one person in their personal workspace. */
const ACCOUNT = {
  name: "Anh Lam",
  email: "amelia.anh.lam@gmail.com",
  userId: "user-e7k2d9xq4m8p1vztq9vxtt",
  workspace: "Personal",
  workspaceId: "ws-3hq8n2c7r5w1b4fjhjgv0gy",
  balance: "$0.00",
};

/** `user-e7k…9vxtt`: enough of each end to tell two ids apart. */
const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 11)}…${id.slice(-7)}` : id);

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };
  return { copied, copy };
}

/** The signed-in person's menu (avatar, top right), laid out like the Nebius console's. */
export function UserMenu({ className }: { className?: string }) {
  const { projectId } = useParams();
  const { copied, copy } = useCopy();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn("press flex h-8 shrink-0 items-center gap-1 rounded-full bg-generic py-1 pl-1 pr-1.5 hover:bg-generic-hover data-[state=open]:bg-generic-hover [outline-offset:-2px]", className)}
          aria-label={`Account: ${ACCOUNT.name}`}
          data-testid="user-menu"
        >
          <Avatar name={ACCOUNT.name} />
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[300px] p-0" data-testid="user-menu-content">
        <section className="space-y-2 px-3.5 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{ACCOUNT.name}</p>
            <p className="truncate text-sm text-muted-foreground">{ACCOUNT.email}</p>
          </div>
          <dl className="space-y-0.5 text-sm">
            <IdRow label="User ID" id={ACCOUNT.userId} copied={copied === "user"} onCopy={() => copy("user", ACCOUNT.userId)} />
            <IdRow label="Workspace ID" id={ACCOUNT.workspaceId} copied={copied === "workspace"} onCopy={() => copy("workspace", ACCOUNT.workspaceId)} />
          </dl>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => copy("both", `User ID: ${ACCOUNT.userId}\nWorkspace ID: ${ACCOUNT.workspaceId}`)}
            data-testid="copy-ids"
          >
            {copied === "both" ? <CheckIcon /> : <CopyIcon />}
            {copied === "both" ? "Copied" : "Copy user and workspace IDs"}
          </Button>
        </section>

        <DropdownMenuSeparator className="mx-0 my-0" />
        <section className="space-y-2 px-3.5 py-3">
          <p className="truncate text-sm font-semibold">Workspace {ACCOUNT.workspace}</p>
          <div className="flex items-center gap-1.5 text-sm">
            <span>Account balance</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="About the account balance">
                  <InfoIcon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Credits for AI suggestions and inspection jobs in this workspace</TooltipContent>
            </Tooltip>
            <span className="tnum ml-auto font-semibold">{ACCOUNT.balance}</span>
          </div>
          <Button variant="outline" size="sm" className="w-full">
            <TopUpIcon /> Top up account balance
          </Button>
        </section>

        <DropdownMenuSeparator className="mx-0 my-0" />
        <div className="p-1">
          <DropdownMenuItem>Workspace settings</DropdownMenuItem>
          <DropdownMenuItem>Billing settings</DropdownMenuItem>
          {projectId ? (
            <DropdownMenuItem asChild>
              <Link to={settingsUrl(projectId)}>Project settings</Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>Project settings</DropdownMenuItem>
          )}
          <DropdownMenuItem>User settings</DropdownMenuItem>
          <DropdownMenuItem>Log out</DropdownMenuItem>
        </div>

        <DropdownMenuSeparator className="mx-0 my-0" />
        <div className="p-2">
          <ThemeSwitch className="w-full [&>*]:flex-1" />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function IdRow({ label, id, copied, onCopy }: { label: string; id: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}:</dt>
      <dd className="min-w-0 truncate font-mono text-xs" title={id}>{shortId(id)}</dd>
      <button type="button" onClick={onCopy} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-generic hover:text-foreground" aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <CheckIcon className="size-3.5 text-positive" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  );
}
