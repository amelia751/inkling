import { NAMING } from "@studio/contracts/naming";
import { LEGAL_PATHS, legalKind, legalPages, type LegalKind } from "@studio/contracts/legal";

/**
 * `/privacy` and `/terms`: short, plain pages, readable without signing in (boot.tsx renders
 * them outside the session gate), linked from the notice under every composer. The copy is
 * shared with the public site (`@studio/contracts/legal`).
 */
export { LEGAL_PATHS, legalKind, type LegalKind };

export function LegalPage({ kind }: { kind: LegalKind }) {
  const pages = legalPages(NAMING.displayName);
  const page = pages[kind];
  const other: LegalKind = kind === "privacy" ? "terms" : "privacy";
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12 md:py-16" data-testid={`legal-${kind}`}>
        <a href="/" className="text-sm text-muted-foreground hover:text-foreground">{NAMING.displayName}</a>
        <h1 className="text-header-2 font-semibold">{page.title}</h1>
        {page.sections.map((s) => (
          <section key={s.heading} id={s.id} className="flex scroll-mt-8 flex-col gap-1.5">
            <h2 className="text-body-2 font-semibold">{s.heading}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
        <a href={LEGAL_PATHS[other]} className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">{pages[other].title}</a>
      </main>
    </div>
  );
}
