import type { ReactNode } from "react";
import { NAMING } from "@studio/contracts/naming";

/**
 * `/privacy` and `/terms`: short, plain pages, readable without signing in (boot.tsx renders
 * them outside the session gate), linked from the notice under every composer.
 */
export const LEGAL_PATHS = { privacy: "/privacy", terms: "/terms" } as const;
export type LegalKind = keyof typeof LEGAL_PATHS;

export function legalKind(pathname: string): LegalKind | null {
  const p = pathname.replace(/\/+$/, "");
  return p === LEGAL_PATHS.privacy ? "privacy" : p === LEGAL_PATHS.terms ? "terms" : null;
}

const name = NAMING.displayName;

const PAGES: Record<LegalKind, { title: string; sections: { heading: string; body: ReactNode }[] }> = {
  privacy: {
    title: "Privacy",
    sections: [
      { heading: "Your files", body: <>File contents are encrypted in storage and in transit, and stay in your project. Originals are kept exactly as you uploaded them.</> },
      {
        heading: "What the assistant sees",
        body: (
          <>
            Your messages, the project's title and tasks, file and folder names, kinds, counts and detected technical facts, and the Studio's setup and labels. Never images, signals, video or any other file
            contents. You approve everything it suggests.
          </>
        ),
      },
      { heading: "Who can see your work", body: <>People in your workspace with access to the project. Your conversations with the assistant are yours.</> },
      { heading: "Turning the assistant off", body: <>An organization admin can turn the assistant off in Organization settings. Uploads keep working.</> },
    ],
  },
  terms: {
    title: "Terms",
    sections: [
      { heading: "Your data", body: <>You keep all rights to what you upload. You confirm you're allowed to use it before uploading, and {name} uses it only to run your projects.</> },
      { heading: "Preview", body: <>{name} is in preview. Don't upload real patient data yet, and expect things to change.</> },
      { heading: "The assistant", body: <>Its suggestions can be wrong. Nothing it proposes changes your work until you approve it.</> },
    ],
  },
};

export function LegalPage({ kind }: { kind: LegalKind }) {
  const page = PAGES[kind];
  const other: LegalKind = kind === "privacy" ? "terms" : "privacy";
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12 md:py-16" data-testid={`legal-${kind}`}>
        <a href="/" className="text-sm text-muted-foreground hover:text-foreground">{name}</a>
        <h1 className="text-header-2 font-semibold">{page.title}</h1>
        {page.sections.map((s) => (
          <section key={s.heading} className="flex flex-col gap-1.5">
            <h2 className="text-body-2 font-semibold">{s.heading}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
        <a href={LEGAL_PATHS[other]} className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">{PAGES[other].title}</a>
      </main>
    </div>
  );
}
