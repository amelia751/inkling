/**
 * The Privacy and Terms copy, shared by the public site (`apps/site`, `/privacy` and `/terms`)
 * and the web app (`apps/web`, the same paths, linked from the notice under every composer)
 * until the site is deployed and the app can link to it. Plain data: each app styles it.
 */
export type LegalKind = "privacy" | "terms";
export type LegalSection = { id?: string; heading: string; body: string };
export type LegalPageCopy = { title: string; sections: LegalSection[] };

export const LEGAL_PATHS: Record<LegalKind, string> = { privacy: "/privacy", terms: "/terms" };

/** `/privacy` → "privacy", `/terms/` → "terms", anything else → null. */
export function legalKind(pathname: string): LegalKind | null {
  const p = pathname.replace(/\/+$/, "");
  return p === LEGAL_PATHS.privacy ? "privacy" : p === LEGAL_PATHS.terms ? "terms" : null;
}

/** The copy with the product's display name filled in (white-label builds pass their own). */
export function legalPages(name: string): Record<LegalKind, LegalPageCopy> {
  return {
    privacy: {
      title: "Privacy",
      sections: [
        { heading: "Your files", body: "File contents are encrypted in storage and in transit, and stay in your project. Originals are kept exactly as you uploaded them." },
        {
          heading: "What the assistant sees",
          body: "Your messages, the project's title and tasks, file and folder names, kinds, counts and detected technical facts, and the Studio's setup and labels. Never images, signals, video or any other file contents. You approve everything it suggests.",
        },
        {
          id: "uploads",
          heading: "What you can upload",
          body: `De-identified, synthetic or public research data you're allowed to use. De-identified means names, record numbers, birth dates and other identifiers are removed from file contents, headers and folder names. ${name} also checks headers and names and holds what it finds for your review, but that check is a safety net, not de-identification. Unsure? Ask your data protection office first.`,
        },
        { heading: "Who can see your work", body: "People in your workspace with access to the project. Your conversations with the assistant are yours." },
        { heading: "Turning the assistant off", body: "An organization admin can turn the assistant off in Organization settings. Uploads keep working." },
      ],
    },
    terms: {
      title: "Terms",
      sections: [
        { heading: "Your data", body: `You keep all rights to what you upload. You confirm you're allowed to use it before uploading, and ${name} uses it only to run your projects.` },
        { heading: "Preview", body: `${name} is in preview. Don't upload real patient data yet, and expect things to change.` },
        { heading: "The assistant", body: "Its suggestions can be wrong. Nothing it proposes changes your work until you approve it." },
      ],
    },
  };
}
