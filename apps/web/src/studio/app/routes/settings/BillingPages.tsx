import { useState } from "react";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { BalanceCard, DataTable, InfoCard, SettingsPage, fmtDate, type Column } from "@/studio/components/settings/kit";
import { BILLING_DETAILS, INVOICES, USAGE } from "@/studio/lib/account-mock";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const NUM = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

type UsageRow = (typeof USAGE)[number];
type InvoiceRow = (typeof INVOICES)[number];

const usageColumns: Column<UsageRow>[] = [
  {
    key: "product",
    label: "Product",
    className: "w-[34%]",
    render: (u) => (
      <div>
        <div className="font-semibold leading-5">{u.product}</div>
        <div className="leading-5 text-muted-foreground">{u.detail}</div>
      </div>
    ),
  },
  { key: "region", label: "Region", render: (u) => <span className="text-muted-foreground">{u.region}</span> },
  { key: "usage", label: "Usage", className: "tnum", render: (u) => NUM.format(u.usage) },
  { key: "unit", label: "Unit", render: (u) => <span className="text-muted-foreground">{u.unit}</span> },
  { key: "cost", label: "Cost", className: "tnum text-right", render: (u) => USD.format(u.cost) },
];

/** Billing › Usage this month by product. */
export function UsagePage() {
  const [view, setView] = useState<"table" | "chart">("table");
  const [month, setMonth] = useState<"this" | "last">("this");
  return (
    <SettingsPage
      title="Usage"
      testId="billing-usage"
      aside={<BalanceCard />}
      filters={
        <>
          <SegmentedControl size="md" aria-label="Period" value={month} onValueChange={setMonth} options={[{ value: "this", label: "This month" }, { value: "last", label: "Last month" }]} />
          <SegmentedControl size="md" aria-label="View" value={view} onValueChange={setView} options={[{ value: "table", label: "Table" }, { value: "chart", label: "Chart" }]} />
        </>
      }
    >
      {view === "table" ? (
        <DataTable columns={usageColumns} rows={USAGE} rowKey={(u) => u.product} testId="usage-table" />
      ) : (
        <div className="flex h-64 items-center justify-center rounded-xl border border-border text-sm text-muted-foreground">No charges this period.</div>
      )}
    </SettingsPage>
  );
}

const invoiceColumns: Column<InvoiceRow>[] = [
  { key: "kind", label: "Document type", render: (i) => i.kind },
  { key: "number", label: "Number", render: (i) => <span className="font-mono text-code">{i.number}</span> },
  { key: "date", label: "Date of issue (UTC)", render: (i) => <span className="text-muted-foreground">{fmtDate(i.issuedAt)}</span> },
  { key: "status", label: "Status", render: (i) => <Badge theme={i.status === "paid" ? "success" : "warning"}>{i.status === "paid" ? "Paid" : "Due"}</Badge> },
  { key: "total", label: "Total", className: "tnum text-right", render: (i) => USD.format(i.total) },
];

/** Billing › Invoices (Nebius "Payments"). */
export function InvoicesPage() {
  return (
    <SettingsPage title="Invoices" testId="billing-invoices" aside={<BalanceCard />}>
      <DataTable columns={invoiceColumns} rows={INVOICES} rowKey={(i) => i.number} empty="No invoices yet." testId="invoices-table" />
    </SettingsPage>
  );
}

/** Billing › Billing details: payer, address and payment method cards. */
export function BillingDetailsPage() {
  const edit = (
    <Button variant="outline" size="default" disabled title="Billing isn't connected yet">
      Edit
    </Button>
  );
  return (
    <SettingsPage title="Billing details" testId="billing-details" aside={<BalanceCard />}>
      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard title="Payer" rows={BILLING_DETAILS.payer} action={edit} />
        <InfoCard title="Payment details" rows={BILLING_DETAILS.payment} action={edit} />
        <InfoCard title="Billing address" rows={BILLING_DETAILS.address} action={edit} />
      </div>
    </SettingsPage>
  );
}
