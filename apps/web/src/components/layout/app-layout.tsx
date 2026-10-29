import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { AnnotateIcon, DatasetsIcon, ExportIcon, ReviewIcon, SidebarIcon, type IconComponent } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { BrandMark } from "@/components/layout/brand";
import { DatasetSwitcher } from "@/components/layout/dataset-switcher";
import { ThemeSwitch } from "@/components/layout/theme-switch";
import { useViewport } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";

const SIDEBAR_KEY = "inkling-sidebar-open";

/**
 * Shell for every page except the Studio (which stays full-bleed around the
 * canvas), laid out like the Nebius console: a full-width header and a
 * borderless sidebar under it. On desktop the
 * header button shows or hides the sidebar; below that it opens as a drawer.
 */
export function AppLayout({ dataset, children }: { dataset?: { id: string; title: string }; children: ReactNode }) {
  const viewport = useViewport();
  const desktop = viewport === "desktop";
  const [pinned, setPinned] = useState(() => localStorage.getItem(SIDEBAR_KEY) !== "0");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setDrawerOpen(false), [pathname]);

  const toggleSidebar = () => {
    if (!desktop) return setDrawerOpen(true);
    setPinned((p) => {
      localStorage.setItem(SIDEBAR_KEY, p ? "0" : "1");
      return !p;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <TileGradientDef />
      <AppHeader dataset={dataset} sidebarOpen={desktop ? pinned : drawerOpen} onToggleSidebar={toggleSidebar} />
      <div className="flex min-h-0 flex-1">
        {desktop && pinned && (
          <aside className="thin-scrollbar w-[260px] shrink-0 overflow-y-auto pb-6 pl-6 pt-6" aria-label="Main navigation">
            <SideNav dataset={dataset} />
          </aside>
        )}
        <main className="thin-scrollbar min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
      {!desktop && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" title="Navigation" className="flex w-[min(284px,88vw)] flex-col p-6 pr-4">
            <SideNav dataset={dataset} />
            <div className="mt-auto border-t border-border pt-4 sm:hidden">
              <ThemeSwitch className="w-full [&>*]:flex-1" />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function AppHeader({ dataset, sidebarOpen, onToggleSidebar }: { dataset?: { id: string; title: string }; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-header px-4 text-foreground md:px-6">
      <Button
        variant="secondary"
        className="w-11 rounded-lg px-0"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Hide navigation" : "Show navigation"}
        aria-expanded={sidebarOpen}
      >
        <SidebarIcon />
      </Button>
      <BrandMark className={cn(dataset && "max-sm:[&>span:last-child]:hidden")} />
      {dataset && <DatasetSwitcher datasetId={dataset.id} title={dataset.title} />}
      <div className="ml-auto flex shrink-0 items-center gap-3 max-sm:hidden">
        <div className="h-5 w-px bg-generic-accent" aria-hidden />
        <ThemeSwitch />
      </div>
    </header>
  );
}

/** Page title block: Gravity header-2 with optional description and actions. */
export function PageHeading({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-2xl">
        <h1 className="text-header-2 font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

function SideNav({ dataset }: { dataset?: { id: string; title: string } }) {
  return (
    <nav className="flex flex-col gap-5">
      <NavSection heading="Workspace">
        <NavItem to="/" end icon={DatasetsIcon} label="Datasets" />
      </NavSection>
      {dataset && (
        <NavSection heading={dataset.title}>
          <NavItem to={`/datasets/${dataset.id}`} end icon={AnnotateIcon} label="Annotate" />
          <NavItem to={`/datasets/${dataset.id}/review`} icon={ReviewIcon} label="Review" />
          <NavItem to={`/datasets/${dataset.id}/export`} icon={ExportIcon} label="Export" />
        </NavSection>
      )}
    </nav>
  );
}

function NavSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="truncate px-4 py-1.5 text-sm text-hint" title={heading}>{heading}</h2>
      <ul>{children}</ul>
    </section>
  );
}

/** 32px row inside a 40px slot; the current page gets a generic fill and a gradient icon. */
function NavItem({ icon: Icon, label, to, end }: { icon: IconComponent; label: string; to: string; end?: boolean }) {
  return (
    <li className="py-1">
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) =>
          cn(
            "group flex h-8 items-center gap-2.5 rounded-md px-3.5 text-sm text-foreground transition-colors [outline-offset:-2px]",
            isActive ? "bg-generic" : "hover:bg-generic",
          )
        }
      >
        {({ isActive }) => (
          <>
            <Icon className={cn("size-4 shrink-0", isActive ? "icon-gradient" : "text-hint group-hover:text-complementary")} />
            <span className="truncate">{label}</span>
          </>
        )}
      </NavLink>
    </li>
  );
}

/** The gradient `.icon-gradient` paints with; rendered once per page. */
function TileGradientDef() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
      <defs>
        <linearGradient id="g-tile-gradient" x1="0.85" y1="0.15" x2="0.15" y2="0.85">
          <stop offset="0.08" style={{ stopColor: "var(--g-tile-1)" }} />
          <stop offset="0.5" style={{ stopColor: "var(--g-tile-2)" }} />
          <stop offset="0.92" style={{ stopColor: "var(--g-tile-3)" }} />
        </linearGradient>
      </defs>
    </svg>
  );
}
