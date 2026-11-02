import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useMatch, useParams } from "react-router";
import {
  ActivityIcon,
  AnnotateIcon,
  ArrowLeftIcon,
  BillingIcon,
  ChevronDownIcon,
  DatasetsIcon,
  HomeIcon,
  MergeIcon,
  OrganizationIcon,
  OverviewIcon,
  PersonIcon,
  ProjectSettingsIcon,
  ProjectsIcon,
  ReviewIcon,
  SidebarIcon,
  SourcesIcon,
  TrashIcon,
  type IconComponent,
} from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Sheet, SheetContent } from "@studio/ui/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { BrandMark } from "@/studio/components/layout/brand";
import { Breadcrumbs } from "@/studio/components/layout/switchers";
import { ThemeSwitch } from "@/studio/components/layout/theme-switch";
import { UserMenu } from "@/studio/components/layout/user-menu";
import { UploadLayer } from "@/studio/components/uploads/uploads";
import { AssistantToggle, PersistentAgentDrawer } from "@/studio/components/ai/agent-drawer";
import { BootNavigator, BootPill } from "@/studio/components/layout/boot-status";
import { useStudio } from "@/studio/stores/studio";
import { setShellContext, useCommands } from "@/extension-host/commands";
import { useViewport, useWindowWidth } from "@/studio/lib/use-media-query";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { useProjectEvents } from "@/studio/lib/use-project-events";
import { useTrashCount } from "@/studio/lib/files/api";
import { billingUrl, changesUrl, connectedAgentsUrl, homeUrl, orgUrl, profileUrl, projectUrl, projectsUrl, projectTrashUrl, type ProjectSection } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { SkeletonText } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { ns } from "@studio/contracts/naming";
import { useFeature, type Features } from "@/studio/lib/features";
import { TimelineOverlay } from "@/studio/components/layout/timeline-overlay";

/** Below this width the project sidebar starts as its icon rail (Gravity AsideHeader compact). */
const FULL_NAV_MIN = 1280;

export interface ProjectRef {
  id: string;
  /** Empty while the name is still loading (shown as skeleton text, never the raw id). */
  title: string;
}

interface Section {
  section: ProjectSection;
  label: string;
  icon: IconComponent;
}

/**
 * docs/ux.md §2, todo13 D10: the project sidebar, in this order; Settings is pinned at the
 * bottom. Explore is off the sidebar: it opens from the Overview card, attention rows, Review,
 * a dataset's Structure and Datasets' "Needs attention".
 */
export const PROJECT_SECTIONS: Section[] = [
  { section: "overview", label: "Overview", icon: OverviewIcon },
  // todo13 D10: the drive is "Sources" in every label (todo16 D1); the route (and so the section, the
  // `when` context and the testids) stays `sources`. Sources live inside it as provenance.
  { section: "sources", label: "Sources", icon: SourcesIcon },
  // docs/datasets.md §1: Datasets explains, Sources stores, the Studio works.
  { section: "datasets", label: "Datasets", icon: DatasetsIcon },
  { section: "studio", label: "Studio", icon: AnnotateIcon },
  { section: "review", label: "Review", icon: ReviewIcon },
  { section: "activity", label: "Activity", icon: ActivityIcon },
];

/** The sections the sidebar shows: Datasets only with `API_FEATURE_DATASETS_TAB` (todo13 §7.1). */
export function visibleSections(features: Pick<Features, "datasetsTab">): Section[] {
  return PROJECT_SECTIONS.filter((s) => s.section !== "datasets" || features.datasetsTab);
}
const SETTINGS: Section = { section: "settings", label: "Settings", icon: ProjectSettingsIcon };

/** The project a route is in: `/projects/:projectId/…` (title from the API, else the id). */
export function useCurrentProject(fallback?: ProjectRef): ProjectRef | undefined {
  const { projectId } = useParams();
  const summary = useProjectSummary(projectId);
  const visited = useShell((s) => s.visited);
  const recent = useShell((s) => (projectId ? s.recent.find((r) => r.id === projectId)?.title : undefined));
  // The name from the list, the page, or this browser's recents; while none has it, empty
  // (skeleton text), or the id only once the list answered without it (a manifest project).
  const title = summary.data?.title ?? fallback?.title ?? recent ?? (summary.isLoading || summary.isFetching ? "" : projectId);
  const ref = projectId ? { id: projectId, title: title ?? "" } : fallback;
  useEffect(() => {
    if (projectId && summary.data) visited({ id: projectId, title: summary.data.title });
  }, [projectId, summary.data, visited]);
  return ref;
}

function useSection(): string | undefined {
  const { pathname } = useLocation();
  return /^\/projects\/[^/]+\/([^/]+)/.exec(pathname)?.[1];
}

/**
 * Shell for every page, laid out like the Nebius console: a full-width header and a
 * borderless sidebar under it. Outside a project the sidebar shows Home, Projects and Recent;
 * inside one, the project's sections (docs/ux.md §2). From 1280px it's a full sidebar the
 * header button (or the toggle command) collapses to a 48px icon rail; below 1024px it's a
 * drawer. `studio`: no header (the Studio has its own top bar) and the rail only, hidden
 * with the same command, so editing gets its space back.
 */
/**
 * Inside a page that already has the shell (a dataset's Versions and Publish & export tabs,
 * Settings › Plugins), an older full page renders just its content (todo6 Phase 8).
 */
const NestedPageContext = createContext(false);

export function NestedPage({ children }: { children: ReactNode }) {
  return <NestedPageContext.Provider value>{children}</NestedPageContext.Provider>;
}

/** The page's content column: centered and padded on its own page, flush inside a tab (`NestedPage`). */
export function PageContainer({ className, children }: { className?: string; children: ReactNode }) {
  const nested = useContext(NestedPageContext);
  return <div className={nested ? "w-full" : cn("mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6", className)}>{children}</div>;
}

export function AppLayout(props: { dataset?: ProjectRef; studio?: boolean; children: ReactNode }) {
  return useContext(NestedPageContext) ? <>{props.children}</> : <AppLayoutFrame {...props} />;
}

function AppLayoutFrame({ dataset, studio = false, children }: { dataset?: ProjectRef; studio?: boolean; children: ReactNode }) {
  const viewport = useViewport();
  const desktop = viewport === "desktop";
  const width = useWindowWidth();
  const nav = useShell((s) => s.nav);
  const setNav = useShell((s) => s.setNav);
  const studioRail = useShell((s) => s.studioRail);
  const toggleStudioRail = useShell((s) => s.toggleStudioRail);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setDrawerOpen(false), [pathname]);
  const project = useCurrentProject(dataset);
  // `when` clauses outside an environment read the page (`section == sources`); the Studio
  // resolves its own context (section == studio) on top.
  const section = useSection();
  const shellSection = studio ? "studio" : (section ?? (project ? "overview" : "home"));
  useEffect(() => setShellContext({ section: shellSection }), [shellSection]);
  // Live updates for a project this person can see (one stream per page).
  useProjectEvents(useProjectSummary(project?.id).data?.id);

  const collapsed = nav === "rail" || (nav === "auto" && width < FULL_NAV_MIN);
  const toggleNav = () => {
    if (!desktop) return setDrawerOpen((o) => !o);
    if (studio) return toggleStudioRail();
    setNav(collapsed ? "full" : "rail");
  };
  useCommands({ toggleNavigation: toggleNav }, { scope: ns("core"), global: true });
  // The Studio binds the assistant to its own right slot; elsewhere it's the shell's drawer.
  const toggleDrawer = useShell((s) => s.toggleAssistant);
  useCommands({ toggleAssistant: studio ? () => useStudio.getState().toggleAi() : toggleDrawer }, { scope: ns("core"), global: true });

  const sidebar = (rail: boolean) => <SideNav project={project} rail={rail} />;

  if (studio) {
    return (
      <div className="flex h-full min-h-0">
        <TileGradientDef />
        {desktop && studioRail && (
          <aside className="thin-scrollbar flex w-12 shrink-0 flex-col border-r border-border bg-header py-2" aria-label="Project navigation" data-testid="project-rail">
            {sidebar(true)}
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        <BootNavigator />
        <UploadLayer />
        <TimelineOverlay />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TileGradientDef />
      <AppHeader project={project} sidebarOpen={desktop ? !collapsed : drawerOpen} onToggleSidebar={toggleNav} />
      <div className="flex min-h-0 flex-1">
        {desktop && (
          <aside
            className={cn("thin-scrollbar flex shrink-0 flex-col overflow-y-auto", collapsed ? "w-12 border-r border-border py-2" : "w-[240px] pb-6 pl-4 pr-2 pt-6")}
            aria-label="Main navigation"
            data-testid={collapsed ? "project-rail" : "project-sidebar"}
          >
            {sidebar(collapsed)}
          </aside>
        )}
        <main className="thin-scrollbar min-w-0 flex-1 overflow-y-auto">{children}</main>
        {project && <PersistentAgentDrawer project={project} section={section} />}
      </div>
      <BootNavigator />
      <UploadLayer />
      <TimelineOverlay />
      {!desktop && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" title="Navigation" className="flex w-[min(284px,88vw)] flex-col p-6 pr-4">
            {sidebar(false)}
            <div className="mt-auto border-t border-border pt-4 sm:hidden">
              <ThemeSwitch className="w-full [&>*]:flex-1" />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function AppHeader({ project, sidebarOpen, onToggleSidebar }: { project?: ProjectRef; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const section = useSection();
  const label = [...PROJECT_SECTIONS, SETTINGS].find((s) => s.section === section)?.label;
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border bg-header px-4 text-foreground md:px-6">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary" className="w-11 rounded-lg px-0" onClick={onToggleSidebar} aria-label={sidebarOpen ? "Hide navigation" : "Show navigation"} aria-expanded={sidebarOpen} data-testid="nav-toggle">
            <SidebarIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{sidebarOpen ? "Collapse navigation" : "Expand navigation"}</TooltipContent>
      </Tooltip>
      <BrandMark compact={!!project} className={cn(project && "max-sm:hidden")} />
      <Breadcrumbs project={project} section={label} />
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {project && <BootPill className="max-sm:hidden" />}
        {project && <AssistantToggle />}
        <UserMenu />
      </div>
    </header>
  );
}

/** Page title block: Gravity header-2 with optional description and actions. */
export function PageHeading({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  // Inside a tab the tab names the page: keep the description and actions, drop the title.
  const nested = useContext(NestedPageContext);
  if (nested && !description && !actions) return null;
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-6 gap-y-3", nested ? "mb-4" : "mb-6")}>
      <div className="min-w-0 max-w-2xl">
        {!nested && <h1 className="text-header-2 font-semibold">{title}</h1>}
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

function SideNav({ project, rail }: { project?: ProjectRef; rail: boolean }) {
  const recent = useShell((s) => s.recent);
  const sections = visibleSections({ datasetsTab: useFeature("datasetsTab") });
  const trashCount = useTrashCount(project?.id);
  if (!project) {
    return (
      <nav className={cn("flex flex-col", rail ? "items-center gap-1" : "gap-5")} aria-label="Workspace">
        <NavSection heading="Workspace" rail={rail}>
          <NavItem to={homeUrl()} end icon={HomeIcon} label="Home" rail={rail} />
          <NavItem to={projectsUrl()} end icon={ProjectsIcon} label="Projects" rail={rail} />
        </NavSection>
        <NavSection heading="Settings" rail={rail}>
          {SETTINGS_GROUPS.map((g) => (
            <NavGroup key={g.label} group={g} rail={rail} />
          ))}
        </NavSection>
        {!rail && recent.length > 0 && (
          <NavSection heading="Recent" rail={rail}>
            {recent.map((p) => (
              <li key={p.id} className="py-0.5">
                <Link to={projectUrl(p.id)} className="flex h-8 items-center truncate rounded-md px-3.5 text-sm text-muted-foreground hover:bg-generic hover:text-foreground" title={p.title}>
                  <span className="truncate">{p.title}</span>
                </Link>
              </li>
            ))}
          </NavSection>
        )}
      </nav>
    );
  }
  return (
    <nav className={cn("flex min-h-full flex-1 flex-col", rail && "items-center")} aria-label="Project">
      {rail ? (
        <RailLink to={projectsUrl()} end icon={ArrowLeftIcon} label="All projects" />
      ) : (
        <div className="mb-4 px-1">
          <Link to={projectsUrl()} className="mb-3 inline-flex items-center gap-1.5 px-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-3.5" /> All projects
          </Link>
          <div className="flex items-center gap-2.5 px-2">
            <span className="tile-gradient flex size-8 shrink-0 items-center justify-center rounded-lg" aria-hidden>
              <ProjectsIcon className="size-4" />
            </span>
            {project.title ? (
              <span className="min-w-0 truncate text-body-2 font-semibold" title={project.title} data-testid="project-title">{project.title}</span>
            ) : (
              <SkeletonText variant="subheader" className="w-28" aria-label="Loading project name" />
            )}
          </div>
        </div>
      )}
      <ul className={cn(rail && "flex flex-col items-center gap-1")}>
        {sections.map((s) => (
          <NavItem key={s.section} to={projectUrl(project.id, s.section)} icon={s.icon} label={s.label} rail={rail} />
        ))}
      </ul>
      <ul className={cn("mt-auto pt-4", rail && "flex flex-col items-center gap-1")}>
        {/* todo16 Milestone 0: the Trash is a sidebar item so it's findable (the tree footer link stays). */}
        {/* todo17 M2: change requests waiting for review. */}
        <NavItem to={changesUrl(project.id)} icon={MergeIcon} label="Changes" rail={rail} testId="nav-changes" />
        <NavItem to={projectTrashUrl(project.id)} icon={TrashIcon} label="Trash" rail={rail} count={trashCount} testId="nav-trash" />
        <NavItem to={projectUrl(project.id, "settings")} icon={SETTINGS.icon} label={SETTINGS.label} rail={rail} />
      </ul>
    </nav>
  );
}

interface NavGroupDef {
  label: string;
  icon: IconComponent;
  /** Path prefix that marks the group current and opens it. */
  base: string;
  items: { label: string; to: string }[];
}

/** Nebius console "Settings": Organization and Billing open into their pages; the profile is one row. */
const SETTINGS_GROUPS: NavGroupDef[] = [
  {
    label: "Organization",
    icon: OrganizationIcon,
    base: "/organization",
    items: [
      { label: "Team & Access", to: orgUrl("members") },
      { label: "Projects", to: orgUrl("projects") },
      { label: "Security", to: orgUrl("security") },
      { label: "API keys", to: orgUrl("api-keys") },
      { label: "Audit log", to: orgUrl("audit-log") },
      { label: "Settings", to: orgUrl("settings") },
    ],
  },
  {
    label: "Billing",
    icon: BillingIcon,
    base: "/billing",
    items: [
      { label: "Usage", to: billingUrl("usage") },
      { label: "Invoices", to: billingUrl("invoices") },
      { label: "Billing details", to: billingUrl("details") },
    ],
  },
  {
    label: "Your profile",
    icon: PersonIcon,
    base: "/settings",
    items: [
      { label: "Profile", to: profileUrl() },
      { label: "Connected agents", to: connectedAgentsUrl() },
    ],
  },
];

function NavGroup({ group, rail }: { group: NavGroupDef; rail: boolean }) {
  const { pathname } = useLocation();
  const inside = pathname.startsWith(group.base);
  const [open, setOpen] = useState(inside);
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside]);
  const first = group.items[0]?.to ?? profileUrl();
  if (rail || group.items.length === 0) return <NavItem to={first} icon={group.icon} label={group.label} rail={rail} />;
  const Icon = group.icon;
  return (
    <li className="py-1" data-testid={`nav-group-${group.base.slice(1)}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex h-8 w-full items-center gap-2.5 rounded-md px-3.5 text-sm text-foreground transition-colors [outline-offset:-2px] hover:bg-generic"
      >
        <Icon className={cn("size-4 shrink-0", inside ? "icon-gradient" : "text-hint group-hover:text-complementary")} />
        <span className="truncate">{group.label}</span>
        <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 text-hint transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {group.items.map((it) => (
            <li key={it.to}>
              <NavLink
                to={it.to}
                className={({ isActive }) => cn("flex h-8 items-center truncate rounded-md pl-[42px] pr-3 text-sm transition-colors [outline-offset:-2px]", isActive ? "bg-generic text-foreground" : "text-muted-foreground hover:bg-generic hover:text-foreground")}
              >
                {it.label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function NavSection({ heading, rail, children }: { heading: string; rail: boolean; children: ReactNode }) {
  return (
    <section className={cn(rail && "w-full")}>
      {!rail && <h2 className="truncate px-4 py-1.5 text-sm text-hint" title={heading}>{heading}</h2>}
      <ul className={cn(rail && "flex flex-col items-center gap-1")}>{children}</ul>
    </section>
  );
}

/** 32px row inside a 40px slot; the current page gets a generic fill and a gradient icon.
 * In the rail: an icon button with a tooltip, the current one marked with a 2px bar. */
function NavItem({ icon: Icon, label, to, end, rail, count, testId }: { icon: IconComponent; label: string; to: string; end?: boolean; rail: boolean; count?: number; testId?: string }) {
  const badge = count ? (count > 999 ? "999+" : count.toLocaleString()) : null;
  if (rail) return <li data-testid={testId}><RailLink to={to} end={end} icon={Icon} label={badge ? `${label} (${badge})` : label} /></li>;
  return (
    <li className="py-1" data-testid={testId}>
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) => cn("group flex h-8 items-center gap-2.5 rounded-md px-3.5 text-sm text-foreground transition-colors [outline-offset:-2px]", isActive ? "bg-generic" : "hover:bg-generic")}
      >
        {({ isActive }) => (
          <>
            <Icon className={cn("size-4 shrink-0", isActive ? "icon-gradient" : "text-hint group-hover:text-complementary")} />
            <span className="truncate">{label}</span>
            {badge && <span className="ml-auto text-xs tabular-nums text-hint" data-testid={testId ? `${testId}-count` : undefined}>{badge}</span>}
          </>
        )}
      </NavLink>
    </li>
  );
}

function RailLink({ icon: Icon, label, to, end }: { icon: IconComponent; label: string; to: string; end?: boolean }) {
  // Not NavLink: TooltipTrigger's Slot would stringify a className function.
  const isActive = !!useMatch({ path: to, end: !!end });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to={to}
          aria-label={label}
          aria-current={isActive ? "page" : undefined}
          className={cn("group relative flex size-8 items-center justify-center rounded-md [outline-offset:-2px]", isActive ? "bg-generic" : "hover:bg-generic")}
        >
          {isActive && <span className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" aria-hidden data-testid="rail-active" />}
          <Icon className={cn("size-[18px]", isActive ? "icon-gradient" : "text-hint group-hover:text-complementary")} />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
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
