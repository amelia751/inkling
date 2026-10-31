import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, MoreIcon, SearchIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { DialogContent, DialogDescription, DialogTitle } from "@studio/ui/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { cn } from "@studio/ui/utils";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { ORG, type MemberStatus } from "@/studio/lib/account-mock";

/**
 * Settings pages, measured from the Nebius console (.cursor/ui-inspect/nebius-console.md):
 * scope title (h1 24/28) with its id, section title (h2 20/24), a filters row with the primary
 * action on the right, then a table whose body is one rounded card.
 */
export function SettingsPage({
  scope = "org",
  title,
  description,
  actions,
  filters,
  aside,
  children,
  testId,
}: {
  scope?: "org" | "personal" | { title: string; id?: string };
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const head = scope === "org" ? { title: `Organization ${ORG.name}`, id: ORG.id } : scope === "personal" ? null : scope;
  return (
    <AppLayout>
      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-6 px-4 py-5 md:px-6 md:py-6" data-testid={testId}>
        {head ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="truncate text-header-2 font-semibold">{head.title}</h1>
              {head.id && <CopyId id={head.id} className="mt-1" />}
            </div>
            {aside}
          </div>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 max-w-3xl">
            {head ? <h2 className="text-header-1 font-semibold">{title}</h2> : <h1 className="text-header-2 font-semibold">{title}</h1>}
            {description && <p className="mt-1 text-sm leading-5 text-complementary">{description}</p>}
          </div>
          {!filters && actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {filters && (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{filters}</div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </div>
    </AppLayout>
  );
}

/** Nebius search field: 36px, radius 10, clearable. */
export function SearchField({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <label className={cn("flex h-9 w-full max-w-[350px] items-center gap-2 rounded-[10px] border border-border px-3 text-sm hover:border-border-hover focus-within:border-ring", className)}>
      <SearchIcon className="size-4 shrink-0 text-hint" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-hint" />
    </label>
  );
}

export interface Column<T> {
  key: string;
  label: ReactNode;
  className?: string;
  render: (row: T) => ReactNode;
}

/**
 * Nebius table: 36px head in secondary text, body rows as one rounded card (12px corners,
 * 1px lines, 12px/8px cell padding, 20px at the edges).
 */
export function DataTable<T>({ columns, rows, rowKey, empty, testId }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; empty?: ReactNode; testId?: string }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-sm" data-testid={testId}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn("h-9 px-2 py-2 font-normal leading-5 text-muted-foreground first:pl-5 last:pr-5", c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody
          className={cn(
            "[&>tr>td]:border-b [&>tr>td]:border-border [&>tr>td:first-child]:border-l [&>tr>td:last-child]:border-r",
            "[&>tr:first-child>td]:border-t [&>tr:first-child>td:first-child]:rounded-tl-xl [&>tr:first-child>td:last-child]:rounded-tr-xl",
            "[&>tr:last-child>td:first-child]:rounded-bl-xl [&>tr:last-child>td:last-child]:rounded-br-xl",
          )}
        >
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-5 py-10 text-center text-muted-foreground">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={rowKey(r)} className="transition-colors hover:bg-generic [&>td]:align-middle">
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-2 py-3 leading-[18px] first:pl-5 last:pr-5", c.className)}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const STATUS: Record<MemberStatus, { label: string; theme: "success" | "warning" | "unknown" }> = {
  active: { label: "Active", theme: "success" },
  invited: { label: "Invited", theme: "warning" },
  deactivated: { label: "Deactivated", theme: "unknown" },
};

export function StatusLabel({ status }: { status: MemberStatus }) {
  return <Badge theme={STATUS[status].theme}>{STATUS[status].label}</Badge>;
}

/** Nebius group label: outlined, 24px, radius 6. */
export function OutlineLabel({ children }: { children: ReactNode }) {
  return (
    <Badge theme="clear" size="sm" className="rounded-md">
      {children}
    </Badge>
  );
}

export function Avatar({ name, email, size = 40 }: { name: string; email: string; size?: 32 | 40 }) {
  const letter = (name || email).charAt(0).toUpperCase();
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-misc text-white", size === 40 ? "size-10 text-body-2" : "size-8 text-sm")} aria-hidden>
      {letter}
    </span>
  );
}

/** Avatar + two rows (name 600, email secondary); invitations show the email alone. */
export function PersonCell({ name, email, you }: { name: string; email: string; you?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={name} email={email} />
      <div className="min-w-0">
        <div className="flex items-center gap-1 truncate font-semibold leading-5">
          {name || email}
          {you && <span className="font-normal text-muted-foreground">(you)</span>}
        </div>
        {name && <div className="truncate leading-5 text-muted-foreground">{email}</div>}
      </div>
    </div>
  );
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };
  return { copied, copy };
}

/** An id in code type with a 20px copy button, as under Nebius page titles and in table cells. */
export function CopyId({ id, className, short }: { id: string; className?: string; short?: boolean }) {
  const { copied, copy } = useCopy();
  const shown = short && id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
  return (
    <span className={cn("inline-flex max-w-full items-center gap-0.5", className)}>
      <span className="truncate font-mono text-code text-muted-foreground" title={id}>
        {shown}
      </span>
      <button type="button" onClick={() => copy("id", id)} className="flex size-5 shrink-0 items-center justify-center rounded-xs text-muted-foreground hover:bg-generic-hover hover:text-foreground" aria-label="Copy ID">
        {copied ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
      </button>
    </span>
  );
}

/** The ⋯ at the end of a row: a 28px flat icon button opening a menu. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost-secondary" size="icon" aria-label={label}>
          <MoreIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Nebius g-modal: ~480px, title 20/24 600, 32px side padding, footer buttons on the right. */
export function SettingsDialog({ title, description, children, footer, wide }: { title: string; description?: ReactNode; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  return (
    <DialogContent className={cn("gap-0 rounded-xl border-0 bg-float p-0 shadow-popup", wide ? "max-w-[600px]" : "max-w-[480px]")}>
      <div className="px-8 pb-2.5 pr-12 pt-6">
        <DialogTitle className="text-header-1 font-semibold">{title}</DialogTitle>
        {description ? <DialogDescription className="mt-1 text-sm text-muted-foreground">{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
      </div>
      <div className="flex flex-col gap-5 px-8 py-3">{children}</div>
      <div className="flex justify-end gap-2 px-8 pb-6 pt-5">{footer}</div>
    </DialogContent>
  );
}

/** Label above a control, with an optional description under it (Nebius n-form-group). */
export function Field({ label, htmlFor, required, description, children }: { label: string; htmlFor?: string; required?: boolean; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm leading-5">
        {label}
        {required && <span className="text-danger">*</span>}
      </label>
      {children}
      {description && <p className="text-sm leading-5 text-muted-foreground">{description}</p>}
    </div>
  );
}

/** Balance card (230×83) in the top right of billing pages. */
export function BalanceCard() {
  return (
    <div className="w-[230px] rounded-xl border border-border px-4 py-3" data-testid="balance-card">
      <div className="text-sm text-complementary">Account balance</div>
      <div className="tnum mt-1 text-header-1 font-semibold">${ORG.balance.toFixed(2)}</div>
    </div>
  );
}

/** Nebius information card: a titled block of label/value rows. */
export function InfoCard({ title, rows, action }: { title: string; rows: Record<string, ReactNode>; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-body-3 font-semibold">{title}</h3>
        {action}
      </div>
      <dl className="grid grid-cols-[minmax(120px,40%)_1fr] gap-x-4 gap-y-2.5 text-sm leading-5">
        {Object.entries(rows).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 truncate">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const DATETIME = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const fmtDate = (iso: string | null | undefined) => (iso ? DATE.format(new Date(iso)) : "—");
export const fmtDateTime = (iso: string) => `${DATETIME.format(new Date(iso))} UTC`;
