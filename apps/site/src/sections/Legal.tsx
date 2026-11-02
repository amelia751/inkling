import { LEGAL_PATHS, legalPages, type LegalKind } from "@studio/contracts/legal";
import { NAME } from "@/content";
import { Footer } from "./Footer";
import { Logo } from "./Header";

/** `/privacy` and `/terms`: the shared copy (`@studio/contracts/legal`) in the site's type. */
export function Legal({ kind }: { kind: LegalKind }) {
  const pages = legalPages(NAME);
  const page = pages[kind];
  const other: LegalKind = kind === "privacy" ? "terms" : "privacy";
  return (
    <>
      <header className="shell flex h-16 items-center">
        <Logo />
      </header>
      <main id="top" className="shell py-16 md:py-24">
        <div className="max-w-[760px]">
          <h1 className="text-[36px] leading-[1.1] md:text-h2">{page.title}</h1>
          <div className="mt-12 space-y-10">
            {page.sections.map((s) => (
              <section key={s.heading} id={s.id} className="scroll-mt-20">
                <h2 className="text-[24px] leading-8 font-semibold">{s.heading}</h2>
                <p className="mt-3 text-ink/70">{s.body}</p>
              </section>
            ))}
          </div>
          <a href={LEGAL_PATHS[other]} className="mt-14 inline-block text-ui text-link hover:underline">
            {pages[other].title}
          </a>
        </div>
      </main>
      <Footer />
    </>
  );
}
