# Landing frontend UI

How the public landing (Astro, this repo) renders its navigation and applies
the premium polish conventions. Scope: this repo only — the CRM's responsive
work is tracked separately in `BroteaConnect/inmobiliaria-crm` and is not
documented here (different repo).

## Nav component (`src/components/Nav.astro`)

One component, two layouts around a single 720px breakpoint:

- **Desktop (≥720px)**: brand wordmark "Inmobiliaria" on the left
  (`var(--font-display)`), horizontal row of links on the right. Hover shows
  a pill background (`color-mix` of `--primary`).
- **Mobile (<720px)**: the links collapse into a dropdown drawer behind a
  hamburger `<button class="menu-btn">`. The button carries
  `aria-expanded`, `aria-controls="nav-links"` and an `aria-label` that
  toggles between "Abrir menú" / "Cerrar menú". The bars animate into an X
  when open (`nav-drop` animation, 0.18s). The drawer closes when any link
  is clicked (event delegation on the container, so it also covers links
  injected later) and on `Escape`, which refocuses the button.

The header is sticky (`position: sticky; top: 0; z-index: 50`) with a
translucent `color-mix` background and `backdrop-filter: blur`.

### The `brotea:nav` injection contract

Feature installs add nav entries by injecting **bare `<a>` tags** at the
`<!-- brotea:nav -->` marker inside `<div class="links" id="nav-links">`:

```html
<div class="links" id="nav-links">
  <a href="/">Home</a>
  <!-- brotea:nav -->   <!-- installs insert plain <a href="...">…</a> here -->
</div>
```

Rules that make this work — keep all three:

- The marker must stay **inside** `.links`; injected anchors land in the
  same container as the built-in ones.
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

## Catalog page polish (`src/pages/index.astro`)

The property catalog is rendered client-side from PocketBase data, so its
styles live in the page's `<style is:global>` block — Astro scoped styles
cannot match JS-rendered nodes. Any style for catalog cards, the `dialog`
or the form must go in that global block.

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
`pointer-events: none`, `role="img"` + `aria-label`) so visitors know a
gallery exists:

```js
${(p.fotos?.length ?? 0) > 1
  ? `<span class="fotos-badge" role="img" aria-label="${p.fotos.length} fotos">📷 ${p.fotos.length}</span>`
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
  "polite"` wrapper so the alt text ("foto N de M") is announced on change.
- `.galeria-tira` — horizontally scrollable thumbnail strip
  (`overflow-x: auto`, `scroll-snap-type: x proximity`). Each thumb is a
  `<button class="galeria-mini">` wrapping an `<img>` loaded via
  `?thumb=600x400` with `loading="lazy"` — never put originals (up to 5 MB
  each) in the strip. Each button carries `aria-label="Ver foto N de M"`
  (the inner `<img>` has an empty `alt`). The active thumb gets `.activa` +
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
- **Token-only styling**: colors, spacing, radii and shadows come from the
  theme variables (`--primary`, `--surface`, `--space-*`, `--radius`,
  `--shadow`, `--font-display`); no hardcoded palette values.
- **`src/styles/theme.css` is generated** by the factory theme
  (`brotea@2.0.0`) — never hand-edit it; restyle via tokens in component
  styles instead.
