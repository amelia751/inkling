# Site style guide (`apps/site`)

The public marketing page. It has its own look, separate from the product's (`apps/web`,
`docs/ui.md`): a bright white page, deep navy ink and one electric lime accent, with motion that
shows the product working. Everything below is enforced by review; tokens live in
`src/site.css`, copy in `src/content.ts`.

## Character

- **Calm and confident.** Lots of white, big type, few colours at once. One idea per section.
- **The product is the hero.** Show it working (a scripted Studio, a run card, a drawn scan)
  rather than abstract decoration.
- **True.** Every number on the page is something we measured or can defend; say where it
  comes from in a code comment. No invented customers, quotes or logos.

## Colour

Use tokens only (`bg-ink`, `text-violet`, …). A new colour is a new token in `@theme` in
`src/site.css`, with a one-line role.

| Token | Role |
|---|---|
| `ink` | All text, primary buttons, outlines. The page's "black". |
| `ink-deep`, `ink-raised` | The one dark band per page and its cards. Footer uses `ink`. |
| `lime`, `lime-soft` | The accent: one lime moment per viewport (a CTA, a stat band, a highlight, a live label). Hover is `lime-soft`. |
| `lilac`, `lilac-strong` | Soft emphasis surfaces: announcement bar, banners, the news band, icon tiles. |
| `violet` | Data and the assistant: stat cards, progress, selection rings, AI marks, eyebrows. |
| `sky` | A second data hue, only next to violet (chips, lanes). |
| `mist`, `skeleton` | Quiet panels and loading placeholders. |
| `line`, `wash` | 1 px borders and dividers; secondary button and hover fills. |
| `link` | Inline text links only. |

Rules:

- Text is `ink` at four strengths: full (headings, body), `/70` (supporting), `/50` (meta,
  captions), `/30` (inactive). On dark: `white`, `white/80`, `white/50`.
- Lime is a fill, never text on white. Anything on lime is `ink`.
- Violet fills carry white text. Lilac and mist carry `ink`.
- At most one dark band (`ink-deep`) in the page body, plus the footer.
- Gradients only as large blurred glows (`blur-3xl`, lime or lilac, behind content) or masks
  that fade an edge. No gradient text, no gradient buttons.

## Type

Two families: **Manrope** for display (`h1`, `h2`, `.display`, big numbers), **Inter** for
everything else.

| Use | Size / line | Weight |
|---|---|---|
| Hero (`text-hero` or the split-hero 52 → 64 px) | 0.9–0.95 line height, `-0.02em` | 700 |
| Section title (`text-h2`) | 48/52, 36 px on mobile | 700 |
| Block title (`text-h3`) | 32/40 | 600–700 |
| Lead (`text-lead`) | 24/28 (20/28 in the split hero) | 600 |
| Body (`text-body`) | 17/24 | 400 |
| UI, buttons, card text (`text-ui`) | 15/20 | 400–500 |
| Caption, meta (`text-caption`) | 13/18 | 400–500 |

- Sentence case everywhere. Uppercase only for tiny eyebrows (10–11 px, `tracking-wider`).
- Keep measure readable: lead and body `max-w-[520px]`–`[760px]`.
- Numbers that count or compare use `tabular-nums`.

## Layout

- Content sits in `shell` (max 1280 px, 24 px gutters, 48 px from `md`). Full-bleed only for
  coloured bands, marquees and the hero glow.
- Vertical rhythm: `py-24` for a full section, `py-12` for a compact block, `mt-10`–`mt-14`
  between a section title and its content.
- Radii are a scale, not a choice: 12 px controls (`rounded-control`), 20 px product windows,
  24 px cards (`rounded-card`), 40 px big panels (`rounded-panel`), full for chips and pills.
- Borders are `border-line` (1 px). Shadows only on things that float: product windows, menus.
  Cards on a coloured band have no shadow.
- Grids: two columns at `lg` (text 5–6 parts, visual 7 parts), stacking below. Card rows
  scroll horizontally with snap rather than shrinking cards below 296 px.

## Components

- **Buttons:** `btn-primary` (ink), `btn-secondary` (wash), `btn-lime` (one per page, the
  closing CTA), `btn-on-dark`. Height 44 px, radius 12, `px-6`. One primary per section; the
  secondary is a verb plus an arrow icon ("See how it works →").
- **Chips:** `chip`, 24 px tall, full radius, caption size; white on coloured bands, tinted on
  white.
- **Cards:** white on lilac or mist bands, 24 px radius, art on top, text below with
  date/meta in `ink/50` and a `link` "Read more".
- **Product windows:** the `Window` frame in `sections/scenes.tsx` (traffic-light dots, title
  in a pill, 20 px radius, soft navy shadow). Keep them recognisably our Studio: viewer on dark
  `#1a1d22`, label chips with number keys, assistant panel on the right.
- **Icons:** only from `@studio/ui/icons`, 16 px in UI, 20 px in lists, `text-violet` on light
  tiles. Some Gravity icons reference a fixed clip-path id (`#a`): if an icon repeats on the
  page and disappears, pick one without `clipPath`.
- **Art:** illustrations from `@studio/ui/illustrations`, or drawn in SVG/canvas. Never real
  medical images or anything that looks like a patient's data; drawn scans say "Synthetic".

## Motion

Motion explains the product; it is never decoration for its own sake.

- **Easing:** `--ease-out-soft` (`cubic-bezier(0.2, 0.7, 0.2, 1)`) for everything that enters
  or settles; `linear` only for progress and marquees. No bounce, no elastic.
- **Durations:** 150 ms presses and hovers, 200–300 ms state changes (tabs, menus, highlights),
  450–700 ms entrances, 80 ms stagger between siblings (`stagger(i)`).
- **Entrances:** `[data-reveal]` children inside a `useReveal()` section rise 24 px and fade in
  once, the first time they scroll into view. Never re-animate on scroll back.
- **Loops:** at most one storytelling loop per viewport (hero demo, step scenes, run card, CT
  sweep). Each runs only while visible (`useInView`, `useCanvasLoop`, the demo's clock), restarts
  cleanly, and lasts long enough to read (6–15 s).
- **Cheap to run:** animate `transform` and `opacity`; canvas at device pixel ratio ≤ 2; no
  scroll-jacking, no parallax on text.
- **Reduced motion:** every animation has a still state that still tells the story (the demo
  freezes on the labelled frame, canvases draw one frame, reveals show immediately). Add new
  animation classes to the `prefers-reduced-motion` block in `site.css`.

## Copy

- The product name comes from `NAMING` (`NAME` in `content.ts`), never a literal.
- Verb-first CTAs: "Start your first dataset", "Try the assistant".
- Short sentences, no exclamation marks, no superlatives we can't prove.
- Privacy statements must match the architecture: the model sees file names and facts, never
  bytes.

## Code

- Copy and lists in `src/content.ts`; one file per section in `src/sections/`; shared hooks in
  `src/lib/motion.ts`.
- Config only through `vite.config.ts` (`INKLING_SITE_APP_URL`); no other env reads.
- Canvases get an `aria-label` or `aria-hidden`; interactive tabs use `role="tab"`; keep the
  skip link working.

## Before handing back

`pnpm --filter @studio/site typecheck`, `pnpm --filter @studio/site build`,
`pnpm check:names`, `pnpm check:boundaries`, then screenshot the page at 1440 and 390 px wide
and check each changed section with motion on and with reduced motion.
