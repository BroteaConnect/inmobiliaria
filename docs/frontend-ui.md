# Landing frontend UI

How the public landing (Astro, this repo) renders its navigation and applies
the premium polish conventions. Scope: this repo only — the CRM's responsive
work is tracked separately in `BroteaConnect/inmobiliaria-crm` and is not
documented here (different repo).

Since feature 52 the landing is bilingual (es at `/`, en at `/en/`); all
UI copy comes from `src/locales/{es,en}.json` via `t(locale, key)` and
every internal href goes through `localePath()`. The full contract is in
[docs/i18n.md](i18n.md); below only the UI-structure consequences.

The palette, type scale and signature element ("el apunte de visita") come
from feature 47 and live in `src/styles/identity.css`; they are documented
in [docs/visual-identity.md](visual-identity.md). This page covers UI
structure only — which token to use for which job is over there.

## Nav component (`src/components/Nav.astro`)

The component takes a required `locale` prop (i18n contract: components
get the locale as a prop, never from context). One component, two layouts
around a single 720px breakpoint:

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
  animation, 0.18s). The drawer closes when any link is clicked (event
  delegation on the container, so it also covers links injected later)
  and on `Escape`, which refocuses the button.

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

## Catalog page polish (`src/pages/[...lang]/index.astro`)

The page moved from `src/pages/index.astro` into `[...lang]/` for the
bilingual routes (see [docs/i18n.md](i18n.md)); relative imports are one
level deeper (`../../lib/pb`). The property catalog is rendered
client-side from PocketBase data, so its styles live in the page's
`<style is:global>` block — Astro scoped styles cannot match JS-rendered
nodes. Any style for catalog cards, the `dialog` or the form must go in
that global block. All strings the client script renders come from
`_ = (key, vars) => t(locale, key, vars)` with
`locale = localeFromPath(location.pathname)`; prices go through
`fmtMoney(locale, p.precio, 'AED')` (the old `eur()` helper is gone).

Merged polish (feature 44):

- Hero title is fluid: `font-size: clamp(1.8rem, 6vw, 2.4rem)`.
- Property cards get hover elevation (`translateY(-3px)` + deeper shadow)
  with a transition.
- `.ver` buttons and the `#interes` submit button: `min-height: 44px`,
  hover brightness/shadow, `:active` press, `:focus-visible` outline.
- `dialog#ficha`: `max-height: min(85dvh, 720px)` with internal scroll;
  under 720px it takes `calc(100vw - spacing)` with tighter padding; the
  close button is 44x44 with hover/focus states.
- `#interes` inputs/textarea: `min-height: 44px`, `:focus-visible` outline
  and a border-color transition.

## Property photo gallery (feature 46)

Before this feature only `fotos[0]` was ever rendered, so photos appended
in the CRM (`fotos+` lands at the end of the array) never showed up on the
landing. Fixed purely at the rendering layer — the catalog already fetches
PocketBase client-side on every visit, so new photos appear on the next
page load with **no rebuild**.

### Catalog cards: photo-count badge

Cards with more than one photo get a `.fotos-badge` overlay (top-right,
`pointer-events: none`) so visitors know a gallery exists. The label is
the localized plural `card.photos` (`{count} foto` / `{count} fotos`,
`.one`/`.other` picked by `Intl.PluralRules`):

```js
${(p.fotos?.length ?? 0) > 1
  ? `<span class="fotos-badge data">${_('card.photos', { count: p.fotos.length })}</span>`
  : ''}
```

The badge is absolutely positioned, so `.card` is now `position: relative`.

### Detail dialog: full gallery

`abrir()` no longer injects a single `<img>`; it prepends the element
returned by `galeria(p)` (a `.galeria` flex column) into `#ficha-contenido`.
With zero photos `galeria()` returns `null` and nothing is prepended.
Structure:

- `.galeria-marco` — large main image (`.galeria-principal`, **original**
  file URL, `aspect-ratio: 3/2`, `object-fit: cover`) with an `aria-live=
  "polite"` wrapper so the alt text (`gallery.photoAlt`, "… — foto N de M")
  is announced on change.
- `.galeria-tira` — horizontally scrollable thumbnail strip
  (`overflow-x: auto`, `scroll-snap-type: x proximity`). Each thumb is a
  `<button class="galeria-mini">` wrapping an `<img>` loaded via
  `?thumb=600x400` with `loading="lazy"` — never put originals (up to 5 MB
  each) in the strip. Each button carries an `aria-label` from
  `gallery.thumb` ("Ver foto N de M" / "View photo N of M"; the inner
  `<img>` has an empty `alt`). The active thumb gets `.activa` +
  `aria-current` and is kept in view with `scrollIntoView`.
- `.galeria-flecha.anterior` / `.siguiente` — prev/next buttons (44px
  targets, wrap-around navigation via `(i + total) % total`).

With a single photo only the main image is rendered (no strip, no arrows).

Maintainer notes — keep these invariants:

- **Built with plain DOM (`createElement`), no `innerHTML`.** `titulo` is
  agent input; the DOM API keeps it as text and the XSS surface unchanged.
  Do not rewrite the gallery as a template string.
- **Styles live in the `<style is:global>` block** (see the section above:
  scoped styles never match runtime-created nodes). Two rules are
  intentionally scoped under `dialog#ficha` (`.galeria-principal`,
  `.galeria-mini img`) to win over the generic dialog `img` styling.
- Thumb URLs are stable per filename and PocketBase renames files on
  upload, so replaced photos get new URLs — do not add cache-busting
  params.

## Polish conventions (apply to any new landing UI)

- **44px minimum touch targets** for anything tappable (links in the
  drawer, buttons, form controls, dialog close).
- **`:focus-visible` outlines** on every interactive element
  (`outline: 2px solid var(--primary); outline-offset: 2px`).
- **Token-only styling**: colors, spacing, radii, shadows and font sizes
  come from the variables (`--primary`, `--surface`, `--space-*`,
  `--radius`, `--shadow`, `--font-display`, `--text-*`); no hardcoded
  values. Which token means what — and the `--accent`/apunte invariants —
  is in [docs/visual-identity.md](visual-identity.md).
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
