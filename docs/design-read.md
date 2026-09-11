# Design Read: the public site (E3, 2026-09-06)

The brief every E3 pull request is judged against. Written before any pixel
moved, from `design-taste-frontend` as adapted by the chassis
(`docs/design-engineering.md` in the factory): tokens only, motion through
the theme vocabulary, no dependency for looks, no hex, no `cubic-bezier(`,
no bare `ms`, no literal copy in `.astro`.

**Reading this as:** a redesign-preserve of a boutique estate agency's
catalogue for buyers on a phone, with a calm, trust-first, first-person
language, leaning toward native CSS on the theme vocabulary (no design
system, no new dependency). The identity is the agency's, not Brotea's:
"la costa a última hora" (`docs/visual-identity.md`) stays as the starting
material, and every token change goes through `src/styles/identity.css`.

## 1. Audience

Buyers in Madrid and in Dubai (the live catalogue holds Lavapiés and
Chamberí next to Jumeirah Lakes Towers), on a phone, arriving from one of
two places: a portal listing they were already reading, or a poster QR in
front of the building. Neither visitor is browsing. Both have one property in
mind, want to know whether it is still real, and want a person. Half of them
read English; property data (title, description, town) is Spanish and is not
translated, which is why the chrome around it must carry the whole message in
both languages.

Quiet constraints that override taste: this is trust-first commerce (money,
consent, GDPR), read one-handed in daylight, often over a slow connection
next to the building.

## 2. The one job

Get a visit booked. Two doors, and only two:

- the lead form (`#interes`, "Quiero que me llamen"), which writes a `leads`
  row with the property attached and posts to the chassis
  (`api.brotea.dev/requirements`, the F3 form gate);
- the `wa.me` link with the property's title in the message
  (`wa.mensajePropiedad`).

Everything else on a screen is either on the way to a door or in the way.
One primary action per screen: on the catalogue it is opening a property; on
a property it is the form, with WhatsApp as the secondary door beside it.

## 3. The three dials

Redesign-preserve reads the existing site first and matches it. The current
site reads as roughly 5 / 3 / 5.

| Dial | Value | Why |
|---|---|---|
| `DESIGN_VARIANCE` | **5** | Left-aligned hero, an `auto-fill` card grid, a side panel instead of a centred modal: offset, not symmetric, not artsy. A buyer comparing prices needs the cards to line up; the `.data` ledger and the brass hairline already carry the character. Asymmetry would cost the comparison. |
| `MOTION_INTENSITY` | **3** | The preset says match+1, declined on purpose. The audience is on a phone next to the building; motion is feedback only (press, panel enter and exit, drawer) and every one of those comes from the theme vocabulary (`--duration-press`, `--ease-out`). Nothing scroll-driven, nothing on load, nothing that has to be gated behind reduced motion because `base.css` already collapses it. A PR that adds a scroll reveal is out of brief. |
| `VISUAL_DENSITY` | **5** | A card carries six facts (town, title, note, rooms, area, price) and E3 adds a filter row. The art-gallery end would hide the facts a buyer compares; the cockpit end would turn the notebook into a portal table, which is the thing the identity exists to not be. |

## 4. The tells the site shows today

Concrete, so the polish PR can be checked line by line. The fleet measured
this app on 2026-09-03 (`docs/design-engineering.md`, `docs/quality-metrics.md`
in the factory): `transition_all = 0`, **`motion_hardcoded = 14`**,
`motion_unreduced = 0`, `copy_dashes` counted. The 14 reproduce with a grep:

1. **Fourteen hardcoded curves and durations**, every one `ease` with a
   literal `0.15s`/`0.18s`: `src/components/Nav.astro:90,110,135,146,186`
   and `src/pages/[...lang]/index.astro:441,458,480,498,508,522,536,571,582`.
   `ease` is the built-in curve the theme contract calls too weak to read as
   intentional; the theme has had `--ease-out`, `--duration-press`,
   `--duration-enter` and `--duration-exit` since `base.css` 1.1.0.
2. **Hex outside the theme.** `.wa-barra` and `.wa-ficha` paint `#075E54`
   and `#fff` (`index.astro:430,434`): a second accent, another company's
   brand, on a page whose colour lock is Golfo teal. `.fotos-badge`,
   `.galeria-flecha` and the dialog backdrop hardcode `rgba(20, 52, 51, …)`
   and `#FBF9F4` (`index.astro:478,561,570`); `visual-identity.md` defends
   them as overlay chrome, but the vocabulary now has `--bg-invert` /
   `--text-invert` for exactly that, and they are not set in `identity.css`.
3. **The footer wears Brotea's brand.** `Footer.astro:64` uses
   `var(--bg-invert)`, which `identity.css` never overrides, so the footer is
   Brotea eggplant `#09092D` under a sand-and-teal site, and in dark mode it
   flips to pure white on a dark-teal page (`theme.css:104-105`).
4. **Em and en dashes in copy**, five keys in each locale: `catalog.empty`,
   `form.error`, `gallery.photoAlt`, `page.title` (em) and `footer.horario`
   (en). The skill's single most-violated tell, and the `copy_dashes`
   metric.
5. **Glyphs as icons.** `×` (`index.astro:23`), `‹` `›` (`:188`), `✓`
   (`:56`) and `← ` inside `form.hecho.volver`. The site's own rule says
   iconography is inline SVG in `currentColor` (`casaSvg`, `waSvg` do it
   right).
6. **Three WhatsApp CTAs and a fixed bar.** `wa.barra` is pinned to the
   bottom of every viewport (`index.astro:428`), `wa.preguntar` sits in the
   panel, `wa.adelantar` after sending; `body:has(.wa-barra) main` pads the
   page to get out from under it (`:437`). Same intent, three labels, and on
   the catalogue the bar competes with every card's "Cómo es por dentro".
7. **The product is invisible at first paint.** The catalogue is fetched
   client-side (`index.astro:288`); the HTML a crawler, a WhatsApp preview
   or a phone on 3G receives is the hero plus "Abriendo el cuaderno de
   visitas…". The cards then arrive with unsized `<img>` (`:115`), so the
   layout shifts, and the first door on a phone is below the fold.
8. **One page, no address per property.** The panel lives at `?p=<id>`
   (`index.astro:231`); a shared link previews as the home page, the
   crawler indexes one URL, `og:` tags and structured data do not exist.
9. **No way to narrow twelve properties in two countries**, sorted by
   `-created`: a Dubai buyer scrolls past Getafe to reach JLT.
10. **Numbers that lie.** Four live units carry `precio: 0` and
    `habitaciones: 0`; `precio()` (`index.astro:86`) prints "0 AED" and the
    meta line prints "0 hab · 0 baños". A zero is not a price.
11. **One currency for two markets.** `negocio.moneda` is a single setting
    (`index.astro:85,320`), so a Lavapiés flat reads "289.000 AED". The
    fix is a field per property or per town and belongs to the schema work
    (E1/E4), not to E3; named here so nobody polishes around it.
12. **`(pendiente)` on the live page.** `settings` is not readable
    anonymously (a list returns 200 and no rows), so `pintarNegocio`
    (`src/lib/negocio.ts:39`) falls back and the footer shows
    "(pendiente) · (pendiente)", and no WhatsApp bar mounts at all. The site
    promises a channel it cannot show. Access rules are schema (`pb/`),
    outside E3; the design consequence is that the property page must not
    depend on `settings` to render its doors.
13. **A nav with no job.** The drawer opens on "Inicio", a link to the page
    you are on, plus the language switcher (`Nav.astro:29-33`). Property
    routes give it a job (back to the catalogue); the switcher needs no
    drawer.
14. **Uppercase eyebrows on every card.** `.eyebrow` (`identity.css:65`)
    styles the town as a tracked uppercase label twelve times on one
    screen: the templated rhythm the skill counts. The town is data and a
    filter key, not a section label.
15. **`titulo` interpolated into `innerHTML`** (`index.astro:115,119`)
    while the gallery, three functions later, builds DOM by hand because
    "titulo is agent input". A title with `<` breaks the card. Server
    rendering escapes it for free.

Not tells, but read them before touching anything: the palette sits close
to the skill's banned beige-plus-brass family. It is kept on the identity's
own argument (Gulf coast, brass confined to numerals and 2px rules, ink is
deep teal not espresso, interactive is teal), and that confinement is the
invariant every PR keeps. The brand wordmark `nav.brand: "Inmobiliaria"` is
a placeholder the client fills in; one key, not E3's.

## 5. What stays

- The gallery: DOM-built, `?thumb=600x400` strip, `aria-current`,
  `aria-live` on the frame, 44px arrows, wrap-around.
- The photo-count badge (`card.photos`), the one overlay on an image, kept
  because it states a fact, not a mood.
- `wa.me` deep links with the property title in the message, and the
  after-send screen that says who calls and when.
- Bilingual routing on the chassis contract: `[...lang]`, `localePath`,
  `hreflang` + `x-default`, `LanguageSwitcher` to the same page.
- The signature: *el apunte de visita* (italic hanging off a 2px brass rule)
  once per card and once per property, the hero hairline as its only echo,
  the `.data` ledger, Bricolage + Archivo, the six named colours.
- The form: consent text captured with its date, `franja` chips, hidden
  `propiedad`, both endpoints untouched.
- The side panel's `?p=<id>` links already shared: they keep resolving.
- `base.css` 1.2.0: focus ring, press scale, reduced-motion collapse,
  tabular digits, `text-wrap`. Nothing re-implements them.

## 6. The next three pull requests

Each is small, each carries the pre-flight, each is judged against this file.

**PR 2, property route** (`/propiedad/<id>` and `/en/propiedad/<id>`).
Title, description, gallery, price, town, rooms, the form with `propiedad`
preset, the WhatsApp secondary door; `og:title`, `og:description`,
`og:image`, `og:url`, `og:locale`, and JSON-LD `RealEstateListing` in the
HTML itself, because previews and crawlers do not run JavaScript. The
catalogue card becomes an `<a>` to it; `?p=<id>` redirects to it. Mind the
trap: `getStaticPaths` is ignored on `output: 'server'` and `[...lang]`
answers any path with a 200 (`localeOf`, `unknownLocale`, factory memory
`astro-ssr-routing-traps`). Whether the route is built or served is the
PR's call; a draft never renders either way.
*Acceptance:* a fetch without JavaScript of `/propiedad/<published id>`
contains `og:title` equal to the property's `titulo` and a
`RealEstateListing` block; the same for a draft id answers 404; `/en/…`
renders English chrome; `locales.test`, `astro check`, `astro build` and the
F3 form gate stay green.

**PR 3, filters** (town, price range, rooms). No reload, no refetch: the
list is already in memory. State lives in the URL (`?municipio=&min=&max=&hab=`)
through `replaceState`, so a filtered view is a link an agent can send.
Chips and inputs in tokens, 44px, a count and an empty state in both
languages, no select soup.
*Acceptance:* opening `/?municipio=Madrid&hab=3` shows only matching cards
on first render; changing a filter rewrites the URL and fires no request;
`/en/` behaves the same; zero matches shows the filtered-empty copy, not the
"no listings" copy.

**PR 4, polish.** Tells 1 to 6, 10, 13 and 14 above: curves and durations to
tokens; `--bg-invert`/`--text-invert`/`--shadow`/`--ok` defined in all three
blocks of `identity.css` and the overlay chrome and footer moved onto them;
the WhatsApp control on `--primary` with the glyph carrying recognition; the
fixed bar removed from the catalogue (WhatsApp is the secondary door on the
property page and in the footer contact); dashes out of the ten keys;
glyphs to SVG; a zero price rendered as "price on request" and zero rooms
omitted; the town in sentence case; the English lede cut to 20 words; images
sized. Then Lighthouse.
*Acceptance:* `grep -rnE '#[0-9a-f]{3,6}\b|cubic-bezier\(|[0-9.]+m?s\b' src/**/*.astro`
prints nothing; `node scripts/measure-fleet.mjs --slug inmobiliaria` reports
`transition_all = 0`, `motion_hardcoded = 0`, `motion_unreduced = 0`,
`copy_dashes = 0`; Lighthouse mobile on `/` and one property page scores
performance ≥ 90 and accessibility ≥ 90 with the vendored puppeteer, or the
PR says "not runnable" by name.

## 7. Pre-flight (Section 14 of the skill, every box)

Closed here means verified against the tree at `4fa3574` and the live site.

| Box | Status | Evidence |
|---|---|---|
| Brief inference declared | closed | the one-liner at the top |
| Dial values reasoned | closed | section 3 |
| Design system or aesthetic named honestly | closed | none; native CSS on the theme vocabulary, "visit notebook" identity |
| Redesign mode detected, audit done | closed | preserve; section 4 is the audit |
| Zero em-dashes on the page | closed in PR 4 | tell 4, ten keys |
| Page theme lock | closed in PR 4 | tell 3; the footer stays the one `.invert`-style band the adapter allows, in the agency's ink |
| Colour consistency lock | closed in PR 4 | tell 2, WhatsApp green |
| Shape consistency lock | closed in PR 4 | cards `--radius-lg`, controls `--radius`; the `franja` chips at `999px` (`index.astro:521`) join `--radius`; the `.hecho-marca` circle is the one exception, documented |
| Button contrast | closed | Cal on Golfo 5.8:1 light, Golfo-night on Marea-night 6.5:1 dark, computed from `identity.css` |
| CTA wrap | closed | every CTA ≤ 4 words; PR 2 screenshots at 1280px confirm |
| Form contrast | closed in PR 4 | labels Marea on Arena ≈ 9.8:1; `::placeholder` is unstyled today, set to `--muted` (Sombra on Arena 5.0:1) |
| Serif discipline | closed | no serif |
| Premium-consumer palette | closed | kept on the identity's argument, brass invariant named in section 4 |
| Italic descender clearance | closed | `.apunte` italic at body size, line-height 1.5 |
| Hero fits the viewport | closed in PR 2 and 4 | h1 four words; es lede 20 words, en lede 30 (PR 4); the first door on screen is the first server-rendered card (PR 2) |
| Hero top padding | closed | `main` pads `--space-5` |
| Hero stack ≤ 4 | closed | headline, lede, decorative rule |
| Eyebrow count | closed in PR 4 | tell 14 |
| Split-header, zigzag, marquee, logo wall, bento cells, bento diversity, "trusted by" | closed | none of these patterns exists on the page |
| No duplicate CTA intent | closed in PR 4 | tell 6 |
| Copy self-audit | closed | both dictionaries reread; only the en lede length flagged |
| Motion motivated | closed in PR 4 | press = feedback, panel enter/exit and drawer = state change, card lift = hierarchy; each mapped to a token |
| Navigation one line, ≤ 80px | closed | 12px + 44px + 12px = 68px |
| Section-layout repetition | closed | three sections, three families |
| Long lists use the right component | closed in PR 3 | photo cards plus filters, not a longer grid |
| Real images | closed | property photographs; the hero has none by the chassis rule (a layout that works without one) |
| No pills overlaid on images | closed | the count badge is the one overlay and states a fact; nothing else |
| Photo credits, version footer, micro-meta, decoration strip, floating sub-text, progress bars, scroll cues, version labels, section numbering, `border-t`+`border-b` rows | closed | none present; `/version.json` is a file, not on the page |
| Locale / time strips | closed | opening hours in the footer are contact information, allowed |
| Decorative dots | closed | the 6px end of `.hero-filete` is the identity's one flourish, `aria-hidden`, named as the deliberate exception |
| Content density | closed | six facts per card, note capped at 140 characters |
| Quotes ≤ 3 lines | closed | the note at 0.95rem fits three lines at 390px; PR 4 checks the longest live one |
| Motion claimed = shown | closed | dial 3 claims nothing |
| GSAP patterns, `window` scroll listener, `useEffect` cleanup, client-leaf isolation | closed | none; there is no React on the page |
| Reduced motion | closed | `base.css` collapse; `ficha-entra` also gated (`index.astro:479`) |
| Dark mode tokens in both modes | closed in PR 4 | tell 3: `--bg-invert`, `--text-invert`, `--shadow`, `--ok` missing from the dark blocks |
| Mobile collapse explicit | closed | grid `auto-fill min(100%, 300px)`, panel full-screen ≤ 640px, footer one column ≤ 720px; PR 3 declares its own |
| Shell and measure are two widths | closed | `--container: 1180px` (nav, catalogue, footer, property page) and `--measure: 680px` (hero, prose, legal) in `identity.css`; the theme ships both at 680px, which made every page a phone column on a laptop. docs/frontend-ui.md carries the table |
| Desktop split of the property page | closed | two columns above `68rem` (`minmax(0, 1.8fr) minmax(19rem, 1fr)`); below it the split would shrink the photo it exists to show. The form is sticky only above `52rem` of viewport height, because a sticky taller than the screen hides its own submit button |
| Viewport stability | closed | `100dvh`, no `100vh` heights |
| Empty, loading, error states | closed in PR 2 and 3 | catalogue has all three; PR 2 adds the 404, PR 3 the filtered-empty |
| Cards omitted for spacing | closed | cards carry photographs, elevation is real |
| Icons from a library | closed in PR 4 | chassis override: inline SVG in `currentColor`, no dependency; tell 5 |
| No AI tells (Inter, purple, three equal cards, Jane Doe, Acme) | closed | Bricolage + Archivo, teal, data cards; the placeholder wordmark is client input |
| Core Web Vitals | closed in PR 4 | Lighthouse ≥ 90/90, sized images, server-rendered first screen |
| One design system | closed | none |
