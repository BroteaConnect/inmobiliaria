# Landing frontend UI

How the public landing (Astro, this repo) renders its navigation and applies
the premium polish conventions. Scope: this repo only — the CRM's responsive
work is tracked separately in `BroteaConnect/inmobiliaria-crm` and is not
documented here (different repo).

Since feature 52 the landing is bilingual (es at `/`, en at `/en/`); all
UI copy comes from `src/locales/{es,en}.json` via `t(locale, key)` and
every internal href goes through `localePath()`. The full contract is in
[docs/i18n.md](i18n.md); below only the UI-structure consequences. Since E3
every property also has its own page, `/propiedad/<id>` — how it is served
is in [docs/architecture.md](architecture.md#rendering-and-routes-e3-2026-09-23).

The palette, type scale and signature element ("el apunte de visita") come
from feature 47 and live in `src/styles/identity.css`; they are documented
in [docs/visual-identity.md](visual-identity.md). This page covers UI
structure only — which token to use for which job is over there.

## The shell: two widths, not one

The theme contract gives a page two widths — `container`, the shell the page
is built in, and `measure`, the width prose is read at. The `brotea` theme
sets **both to 680px**, so until 2026-09-11 every page of this site was a
680px column at any screen size: a 1280px laptop showed the phone layout with
632px of bare Arena down the sides, and the property page's lead form sat
887px below the fold because the gallery had nowhere to sit beside it.

`src/styles/identity.css` restores the two meanings for this app, where every
other client-specific token already lives:

```css
--container: 1180px;   /* the shell: nav, catalogue, footer, the property page */
--measure: 680px;      /* the reading width: hero, prose, legal pages */
```

Whether the theme itself should carry a real shell width is a fleet decision
(ten apps inherit that 680px, and the CRM had already worked around it with a
hardcoded 1200px); it does not belong in this repo.

What each width is for:

| Element | Width | Why |
|---|---|---|
| `main`, `.pie-cols` (footer) | `--container` | the shell; both already read the token, so they widened for free |
| `nav` | `--container`, through padding | the bar spans the viewport, its contents line up with the shell (`padding-inline: max(var(--space-4), calc((100% - var(--container)) / 2 + var(--space-4)))`). No wrapper element: the `brotea:nav` marker has to stay inside `.links` |
| `.hero`, `.legal`, `.descripcion` | `--measure` (or a `ch` measure) | prose. A headline set across 1180px is a headline nobody finishes |
| `.catalogo` | fills the shell | `repeat(auto-fill, minmax(min(100%, 300px), 1fr))`: 3 across on a laptop, 2 on a tablet, 1 on a phone. 300px keeps a card wide enough for its 3:2 photo to be worth looking at |
| `.ficha` (property) | two columns above `68rem` | `minmax(0, 1.8fr) minmax(19rem, 1fr)`: gallery and facts on one side, the way to answer them on the other. Not `60rem`: between 960px and ~1080px the split would make the photo smaller than the single column it replaces. `.puertas` is sticky only when the viewport is also at least `52rem` tall, because a sticky element taller than the screen hides its own submit button |

Measured at four widths, before and after (`docs/review/shell/`):

| width | before | after |
|---|---|---|
| 390 | 1 column, card 358px, form 714px down | unchanged: the phone was always the layout that worked |
| 768 | 2 columns 312px, 120px dead, photo 648px | 2 columns 356px, 32px dead, photo 736px |
| 1280 | 2 columns, 632px dead, photo 648px, form 887px down | 3 columns 367px, 132px dead, photo 712px, form 178px down and beside the gallery |
| 1600 | 2 columns, 952px dead | 3 columns, 452px dead |

The shell stops at 1180px on purpose: a catalogue that keeps widening turns
into four thin slices of photo, and a line of prose that keeps widening stops
being read.

## Nav component (`src/components/Nav.astro`)

The component takes a required `locale` prop (i18n contract: components
get the locale as a prop, never from context) and an optional `back`
boolean: on a page that hangs off the catalogue (a property) the first link
reads `nav.catalog` ("All properties") instead of `nav.home`, so the nav has
a job there. One component, two layouts around a single 720px breakpoint:

- **Desktop (≥720px)**: brand wordmark (`t(locale, 'nav.brand')`,
  `var(--font-display)`) on the left, linking to `localePath(locale, '/')`;
  horizontal row of links plus the `LanguageSwitcher` on the right. Hover
  shows a pill background (`color-mix` of `--primary`).
- **Mobile (<720px)**: the links collapse into a dropdown drawer behind a
  hamburger `<button class="menu-btn">`. The button carries
  `aria-expanded`, `aria-controls="nav-links"` and an `aria-label` that
  toggles between the open/close labels. Those labels are rendered
  server-side into `data-label-open` / `data-label-close` (from
  `t(locale, 'nav.menuOpen'/'nav.menuClose')`) because the toggle script
  is **one bundle shared by every locale** — it reads `btn.dataset`, never
  hardcoded strings. The bars animate into an X when open (`nav-drop`
  animation, `var(--duration-enter) var(--ease-out)`). The drawer closes
  when any link is clicked (event delegation on the container, so it also
  covers links injected later) and on `Escape`, which refocuses the button.

Every transition in the nav reads its duration and curve from the theme
(`--duration-press`, `--duration-fast`, `--ease-out`, `--ease-in-out`); no
literal `ms` or `ease` (E3, PR 4).

The header is sticky (`position: sticky; top: 0; z-index: 50`) with a
translucent `color-mix` background and `backdrop-filter: blur`.

### The `brotea:nav` injection contract

Feature installs add nav entries by injecting **bare `<a>` tags** at the
`<!-- brotea:nav -->` marker inside `<div class="links" id="nav-links">`:

```html
<div class="links" id="nav-links">
  <a href={localePath(locale, '/')}>{t(locale, 'nav.home')}</a>
  <!-- brotea:nav -->   <!-- installs insert plain <a href="...">…</a> here -->
  <LanguageSwitcher locale={locale} />
</div>
```

Rules that make this work — keep all three:

- The marker must stay **inside** `.links`; injected anchors land in the
  same container as the built-in ones. The `LanguageSwitcher` sits
  **after** the marker so injected feature links land between `Home` and
  the switcher; on mobile it inherits the drawer layout via the existing
  `nav .links :global(a)` rules.
- Anchors are styled at **element level** via `nav .links :global(a)`
  (Astro scoped styles alone would not match HTML injected as raw text), so
  injected links inherit hover, focus and touch-target styles for free.
  Installs must inject *bare* anchors — no classes, no inline styles.
- Drawer close-on-click uses delegation on `.links`, so injected links get
  the mobile behavior without any extra script.

### Why the drawer uses a class, not `[hidden]`

The drawer is toggled with an `open` class plus explicit `display` rules
(`display: none` → `.open { display: flex }`). The `[hidden]` attribute is
never used for this: its UA rule loses to any author `display` rule, so a
"hidden" drawer that also has `display: flex` would stay visible.

### Why the script never creates DOM

The inline `<script>` only toggles classes/attributes on server-rendered
nodes. Astro scoped styles only match elements rendered by the component,
so runtime-created nodes would render unstyled. Keep it that way: change
state with classes/ARIA attributes, never `createElement`.

## Catalogue page (`src/pages/[...lang]/index.astro`)

The page moved from `src/pages/index.astro` into `[...lang]/` for the
bilingual routes (see [docs/i18n.md](i18n.md)); relative imports are one
level deeper (`../../lib/pb`). The property catalogue is rendered
client-side from PocketBase data, so its styles live in the page's
`<style is:global>` block — Astro scoped styles cannot match JS-rendered
nodes. Any style for catalogue cards or the filter chips must go in that
global block. All strings the client script renders come from
`_ = (key, vars) => t(locale, key, vars)` with
`locale = localeFromPath(location.pathname)`.

Since E3 (PR 2) a card is the link: `<a class="card" data-card
href={localePath(locale, '/propiedad/<id>')}>` with `.ver` as its visible
handle (a `<span>`, not a second target). There is no `<dialog>` and no
`?p=<id>` panel any more: the script redirects a `?p=` address to the
property's own page and skips the catalogue fetch. The lead form and the
gallery live on the property page (below). Everything printed on a card
comes from the isomorphic helpers in `src/lib/property.ts`, the same ones
the property page renders server-side: `noteOf` (the apunte), `metaOf`
(rooms, bathrooms, area, each only when above zero), `priceOf` (Intl money
in the currency from `settings` `negocio.moneda`, AED by default; a zero
price prints `prop.priceOnRequest`), `photoUrl`, `photos`. Everything from
the database is escaped (`esc()`) before it meets `innerHTML`. The first
card's photo is `loading="eager" fetchpriority="high"`, the rest lazy; every
`<img>` carries `width`/`height`.

Polish that stays from feature 44 and E3 PR 4:

- Hero title on `--text-display-xl`; the hero keeps `--measure`.
- Property cards get hover elevation (`translateY(-3px)` + deeper shadow);
  every transition reads `--duration-fast` / `--duration-press` with
  `--ease-out`, never a literal duration or curve.
- `.ver` and every chip: `min-height: 44px`, `:focus-visible` outline; a
  chip presses on `scale: var(--press-scale)`, `.ver` on a 1px `translateY`.
- The `.wa-barra` fixed WhatsApp bar is gone from the catalogue (E3, PR 4):
  the WhatsApp door lives on the property page.

## Catalogue filters (E3, PR 3)

`form[data-filters]` sits between the hero and `#catalogo`: town (radio
chips, one per distinct `municipio`, created by the script once the list
arrives), a price range (`min` / `max` number inputs) and rooms (radio
chips `hab` = 1..4, "n or more"; the first `[name="hab"]` in DOM order is
value 1). The URL is the state: `?municipio=&min=&max=&hab=` is read on load
and rewritten with `history.replaceState` on every `input` / `change`, so
a filtered view is a link an agent can send, nothing reloads and nothing is
fetched again. Filtering is a `hidden` toggle on `[data-card]`
(`data-town` raw as PocketBase wrote it, `data-price`, `data-rooms`); a
zero price hides under any bound because a zero is not a price, and a zero bound is no bound at all (ArrowDown in an empty box must not empty the page). A town or a rooms value in the URL that matches no chip is dropped from the address on first paint, so URL, controls and cards always agree. The count
(`filters.count`, plural) and the filtered-empty line (`filters.empty`,
distinct from `catalog.empty`) are both locale keys. `submit` is prevented
(Enter in a number input would GET-navigate) and the clear control is a
`type="button"` not named `hab`.

```
/?municipio=Madrid&hab=3          only Madrid cards with 3 or more bedrooms, on first paint
/en/?min=200000&max=400000        the same in English; empty params are never written
```

Details the code relies on:

- Town matching is exact first, then case-insensitive (`toLocaleLowerCase`),
  so a hand-typed `?municipio=madrid` still selects the chip; the address is
  rewritten with the chip's own spelling.
- The form is `hidden` until the list arrives, and stays hidden when the
  fetch fails or the catalogue is empty (`catalog.error` / `catalog.empty`).
- The count is a `role="status"` live region; on first paint it is written
  in the same task as the cards, on a change it settles for 300 ms so a
  typed price is announced once.
- `form.reset()` (the clear control) returns to "any town, any rooms, no
  bounds" because the script sets `.checked`, never `defaultChecked`.
- Only `location.search` is rewritten: the locale prefix and any hash stay.

Umami runs with `data-exclude-search="true"` **and** `data-exclude-hash="true"`
(`Layout.astro`): the tracker patches `replaceState` and would otherwise
send a pageview for every search-only change, and the hash is excluded for
the same reason since the rewrite keeps it.

## Property page (E3, PR 2, `src/pages/[...lang]/propiedad/[id].astro`)

Rendered per request (`prerender = false`); when and how it answers 200 /
404 / 503, and what goes in `<head>`, is in
[docs/architecture.md](architecture.md#rendering-and-routes-e3-2026-09-23).
Its structure:

- `<article class="ficha" data-propiedad={id}>` with a `.volver` link back
  to the catalogue (inline SVG arrow, `nav.catalog`) and the Nav mounted
  with `back`.
- `.ficha-cuerpo`: the `Gallery` component, then `.ficha-cabecera`
  (`.eyebrow` town, `h1` title, `.apunte`, `.meta data`, `.precio data`)
  and `.descripcion` paragraphs — omitted when the description *is* the
  apunte (`descriptionIsNote`), so one sentence is never printed twice.
- `.puertas` aside, the two doors: `LeadForm` (`#interes`, hidden
  `propiedad` preset to the id, `franja` chips, the consent checkbox that is
  `required`, the after-send screen `#interes-hecho` with the caller's
  number from `settings` when there is one) and `WhatsAppDoor`
  (`.wa-ficha`, `wa.preguntar`). Both doors carry `wa.mensajePropiedad`
  with the property's title.
- `WhatsAppDoor` is server-rendered `hidden` and shown by its script once
  `contacto.whatsapp` resolves from `settings`; rendering never waits for
  that fetch. It sits on `--primary` with the glyph carrying recognition,
  no brand green.
- The price is written on the server in the default currency and rewritten
  in place, once, if `negocio.moneda` says otherwise.

Two columns above `68rem` (see the shell table); one column below, the
phone layout.

## Property photo gallery (`src/components/Gallery.astro`)

Feature 46 made every photo visible (only `fotos[0]` was rendered before);
E3 moved the gallery from the catalogue panel to the property page and
server-renders its first frame. Photos appended in the CRM (`fotos+`) show
on the next request — no rebuild.

### Catalogue cards: photo-count badge

Cards with more than one photo get a `.fotos-badge` overlay (top-right,
`pointer-events: none`) so visitors know a gallery exists. The label is
the localized plural `card.photos` (`{count} foto` / `{count} fotos`,
`.one`/`.other` picked by `Intl.PluralRules`):

```js
${photos(p).length > 1
  ? `<span class="fotos-badge data">${_('card.photos', { count: photos(p).length })}</span>`
  : ''}
```

The badge is absolutely positioned, so `.card` is `position: relative`. Its
colours are the site's ink over the photo and the surface for the figure
(`color-mix(in srgb, var(--text) 72%, transparent)` / `var(--surface)`), so
it reads in both colour modes without a colour of its own.

### Property page: the gallery

`Gallery.astro` renders `.galeria > .galeria-marco[aria-live="polite"] >
img.galeria-principal` on the server (**original** file URL, `width="1200"
height="800"`, `fetchpriority="high"`, `aspect-ratio: 3/2`, `object-fit:
cover`), with the photo URLs in `data-urls` and the title in `data-titulo`.
With zero photos nothing is rendered. With more than one, the script adds:

- `.galeria-tira` — horizontally scrollable thumbnail strip
  (`overflow-x: auto`, `scroll-snap-type: x proximity`). Each thumb is a
  `<button class="galeria-mini">` wrapping an `<img>` loaded via
  `?thumb=600x400` with `loading="lazy"`, `width="72" height="54"` — never
  put originals (up to 5 MB each) in the strip. Each button carries an
  `aria-label` from `gallery.thumb` ("Ver foto N de M" / "View photo N of
  M"; the inner `<img>` has an empty `alt`). The active thumb gets
  `.activa` + `aria-current` and is kept in view with `scrollIntoView`
  (`smooth` unless `prefers-reduced-motion`).
- `.galeria-flecha.anterior` / `.siguiente` — prev/next buttons (44px
  targets, inline SVG chevrons in `currentColor`, wrap-around navigation via
  `(i + total) % total`, labels `gallery.prev` / `gallery.next`). Overlay
  chrome on `color-mix` of `--text` with `--surface` glyphs, like the badge.
- The main image's `alt` (`gallery.photoAlt`, "… — foto N de M") is updated
  on change and announced through the `aria-live` frame.

Maintainer notes — keep these invariants:

- **Built with plain DOM (`createElement`), no `innerHTML`.** `titulo` is
  agent input; the DOM API keeps it as text and the XSS surface unchanged.
  Do not rewrite the gallery as a template string.
- **Styles live in the component's `<style is:global>` block** (scoped
  styles never match runtime-created nodes).
- Thumb URLs are stable per filename and PocketBase renames files on
  upload, so replaced photos get new URLs — do not add cache-busting
  params.

## Polish conventions (apply to any new landing UI)

- **44px minimum touch targets** for anything tappable (links in the
  drawer, buttons, chips, form controls, gallery arrows).
- **`:focus-visible` outlines** on every interactive element
  (`outline: 2px solid var(--primary); outline-offset: 2px`).
- **Token-only styling**: colors, spacing, radii, shadows, font sizes and
  motion come from the variables (`--primary`, `--surface`, `--space-*`,
  `--radius`, `--shadow`, `--font-display`, `--text-*`, `--duration-*`,
  `--ease-*`, `--press-scale`); no hardcoded values, no hex, no
  `cubic-bezier(`, no bare `ms`. Which token means what — and the
  `--accent`/apunte invariants — is in
  [docs/visual-identity.md](visual-identity.md).
- **Iconography is inline SVG in `currentColor`** (`casaSvg`, the chevrons,
  the back arrow, the check mark, the WhatsApp glyph); no glyph characters,
  no emoji, no icon library.
- **No hardcoded copy**: every user-facing string (including aria-labels,
  placeholders and alt text) is a key in `src/locales/{es,en}.json`
  rendered via `t(locale, key)`; internal links go through
  `localePath(locale, path)`. See [docs/i18n.md](i18n.md) — the
  `locales.test.mjs` gate blocks merges on key parity, not on call sites,
  so smoke-test `/en/` too.
- **`src/styles/theme.css` is generated** by the factory theme
  (`brotea@2.0.0`) — never hand-edit it. Client-specific tokens go in
  `src/styles/identity.css`, imported after it so it wins by cascade order
  ([docs/visual-identity.md](visual-identity.md)).
