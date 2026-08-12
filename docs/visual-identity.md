# Landing visual identity — "la costa a última hora"

The design system of the public landing (feature 47). Concept in one line:
**the catalog is the agent's visit notebook — every card is a listing
annotated by someone who has walked the house, not a search result.**

That is why the site does not look like a property portal: portals are
white pages with a filter sidebar and a stock-photo hero. This one is sand
paper with deep-teal ink, one brass hairline, and a handwritten-feeling
note on every card. Everything below is skin: the redesign changed **no
PocketBase collection, field, rule or query** — see
[docs/architecture.md](architecture.md) for the data model.

Scope: this repo (the landing). The CRM (`BroteaConnect/inmobiliaria-crm`)
keeps the factory theme and is not covered here.

## The cascade contract (read this before restyling anything)

`src/styles/theme.css` is **generated** by the factory
(`brotea theme brotea`, `brotea@2.0.0`) and must never be hand-edited.
Every client-specific token lives in `src/styles/identity.css`, which
`Layout.astro` imports **after** `theme.css` and `base.css` so it wins by
cascade order:

```astro
import '../styles/theme.css';      // generated factory theme — do not edit
import '../styles/base.css';       // element resets, themed via tokens
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/archivo';
import '@fontsource-variable/archivo/wght-italic.css';
import '../styles/identity.css';   // client identity — wins by cascade order
```

Consequence: regenerating the factory theme is harmless. It also means
`identity.css` only needs to redefine what changes — `--space-*`,
`--container`, `--ok`, `--warn`, `--danger` still come from `theme.css`
(`#interes-status` is coloured with `--ok`).

## Palette (six named values)

Rooted in the Gulf coast the client sells on: whitewashed gypsum, wet
sand, shallow-water teal, souk brass, and the blue-green shadow hard light
casts.

| Name | Hex | Token | Function rule |
|---|---|---|---|
| **Cal** | `#FBF9F4` | `--surface` | Card, dialog and nav surfaces — the bright anchors on top of the sand |
| **Arena** | `#E8E1D1` | `--bg` | Page background; also form inputs and the no-photo placeholder |
| **Marea** | `#143433` | `--text` | All ink, wordmark included. Replaces black entirely (≈9.8:1 on Arena) |
| **Golfo** | `#0F6E6B` | `--primary` | Everything interactive: buttons, links, focus rings, active thumbnail |
| **Latón** | `#8A6A28` | `--accent` | **Numerals and hairlines only** — price, hero filete, `.apunte` rule |
| **Sombra** | `#52615A` | `--muted` | Secondary text: eyebrow, lede, metadata, loading/empty/error copy |

Supporting tokens set in `identity.css`: `--border: #D8CFBB`,
`--primary-contrast: #FBF9F4` (Cal on Golfo, never white),
`--radius: 10px` / `--radius-lg: 18px` (down from the template's 14/28 —
rounded enough to avoid a razor-sharp newspaper look, tight enough to lose
the pill-ness), and `--shadow` tinted with Marea instead of neutral grey.

**The Latón invariant.** Brass is the one value that reads as craft
instead of bling *only* while it stays on numerals and 2px rules. It is
never a background, never a button, never body text. `.precio` and the
brass hairlines are its entire surface area; a "brass CTA" would turn the
whole site into a generic gold-luxury theme.

### The deliberate risk: no black, no white

There is no `#000` and no `#fff` anywhere on the landing, and no white
page background. Sand can read "dirty" on a bad monitor and teal ink can
read low-contrast — accepted on purpose, because it is the single move
that makes the site fail the "could be any portal" test in the first three
seconds. The defence is measured: Marea on Arena is ≈9.8:1 (AAA) and Cal
cards provide local brightness hierarchy.

The only literal colours left in the page's `<style is:global>` block are
`rgba(20, 52, 51, …)` (Marea at alpha) for the dialog backdrop, the
`.fotos-badge` and the `.galeria-flecha` buttons, with `#FBF9F4` (Cal) as
their text. They are literals on purpose: that chrome sits **on top of
photographs** and must stay dark in both colour schemes, so it cannot
follow `--surface`/`--text`. Nothing else may hardcode a colour.

### Dark scheme, and the trap it exists to fix

"La misma costa de noche": `--bg: #0C2423`, `--surface: #123231`,
`--text: #F2EEE3`, `--muted: #9DB0A8`, `--primary: #4FB3AC`,
`--accent: #C9A45C`, `--border: #1E3D3B`, `--primary-contrast: #0C2423`.

The factory theme ships **two** dark selectors, and `identity.css` must
override **both** or the generated near-black + acid-green palette leaks
through for dark-mode visitors:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* … */ }
}
:root[data-theme="dark"] { /* … */ }
```

Overriding only the media query leaves forced dark (`data-theme="dark"`)
acid-green; overriding only the attribute leaves every OS-dark visitor
acid-green. Any new token added to the light block has to be added to both
dark blocks too — preview both schemes before merging.

## Typography

- **Display — Bricolage Grotesque** (`@fontsource-variable/bricolage-grotesque`),
  via `--font-display`. Used by `base.css` for `h1, h2, h3` and by the nav
  wordmark. Not a high-contrast serif (the "elegant real estate" cliché),
  not Inter/Space Grotesk (the template tell).
- **Text and data — Archivo** (`@fontsource-variable/archivo`), via
  `--font-sans`. The `wght-italic.css` subset is imported separately
  because the signature element needs **real** italics, not synthesised
  obliques.

Both are imported in `src/layouts/Layout.astro`. The Brotea brand faces
(PP Neue Machina) stay on disk in `public/fonts/` and their `@font-face`
rules stay at the top of `theme.css`, but nothing references those
families anymore — an unused `@font-face` is never downloaded, so there is
no payload cost. They are Brotea's identity, not the client's; do not
delete them (the composer owns those files).

### Scale (`--text-*` in `identity.css`)

| Token | Value | Applied to | Face / weight / tracking |
|---|---|---|---|
| `--text-display-xl` | `clamp(2.4rem, 7vw, 4rem)` | `.hero h1` | Bricolage 800, −0.02em, lh 1.05 |
| `--text-display-lg` | `clamp(1.5rem, 4vw, 2.1rem)` | `dialog#ficha h2` | Bricolage 700, −0.015em, lh 1.15 |
| `--text-title` | `1.15rem` | `.card h2`, `#interes h3` | Bricolage 600, −0.01em |
| `--text-body-lg` | `1.125rem` | `.hero .lede` | Archivo 400, lh 1.55, `max-width: 52ch` |
| `--text-body` | `1rem` | base copy (available for new UI) | Archivo 400 |
| `--text-note` | `0.95rem` | `.apunte` | Archivo *italic* 450, lh 1.5 |
| `--text-data-lg` | `1.35rem` | `.precio` | Archivo 700, tabular, Latón |
| `--text-data` | `0.9rem` | `.meta` | Archivo 500, +0.01em, tabular |
| `--text-eyebrow` | `0.78rem` | `.eyebrow` | Archivo 600, uppercase, +0.08em |

### Why the data is tabular

The catalog is a grid: prices and meta rows (`3 hab · 2 baños · 110 m²`)
sit next to each other across cards, and proportional figures make them
wobble column to column. The `.data` utility pins them:

```css
.data {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;   /* belt and braces */
}
```

The `font-feature-settings` line is a deliberate fallback: the standard
property is what should apply the feature, but the low-level one keeps
`tnum` working on engines/builds where Archivo's variable font does not
pick it up. Keep both. `.data` is applied alongside the semantic class
(`class="precio data"`, `class="meta data"`, `class="fotos-badge data"`) —
numbers rendered by new UI should get it too.

## The signature element: *el apunte de visita*

One first-person line — the first sentence of the property's existing
`descripcion` — typeset in Archivo italic hanging off a 2px brass left
rule. It appears on **every card** and at the **top of every ficha**, and
it is the visual proof of the value proposition ("we have walked through
every one of them").

It is derived client-side in `src/pages/[...lang]/index.astro`, with
**zero schema change**:

```ts
const apunteDe = (p: Propiedad) => {
  const a = (p.descripcion ?? '').split(/\.\s/)[0].trim().slice(0, 140);
  return a ? (/[.!?…]$/.test(a) ? a : `${a}.`) : '';
};
```

Rendered as `<p class="apunte">` by both `render()` (cards) and `abrir()`
(ficha); when `descripcion` is empty the element is not emitted at all.
The styling is the whole signature:

```css
.apunte {
  font-style: italic;
  font-weight: 450;
  border-left: 2px solid var(--accent);
  padding-left: var(--space-3);
}
```

**Invariant: nothing else in the UI may use the italic + brass-rule
treatment.** A signature repeated everywhere is decoration. It echoes
exactly once more, as the hero's brass hairline `.hero-filete` — a 2px
Latón rule with a 6px dot at its right end, `aria-hidden` because it says
nothing to a screen reader.

**Duplicate guard.** A one-sentence `descripcion` would otherwise be
printed twice in the ficha (once as the apunte, once as the description
paragraph). `abrir()` compares them and drops the paragraph:

```ts
const descDuplicada = !!apunte && (desc === apunte || `${desc}.` === apunte);
```

Keep that check if the apunte derivation ever changes.

## Why `.eyebrow` / `.apunte` / `.data` are global

They live in `identity.css` (a plain global stylesheet), not in a scoped
`<style>` block. Catalog cards, the ficha body and the gallery are all
**JS-created DOM**, and Astro scoped styles only match nodes the component
rendered — a scoped `.apunte` rule would silently never apply. Same reason
the page keeps every card/dialog/gallery rule in its `<style is:global>`
block (see [docs/frontend-ui.md](frontend-ui.md)).

## The microcopy the identity calls for

The identity is half copy: portal-speak ("Encuentra tu próxima casa",
"Ver ficha") was replaced by the agent's own voice. Since feature 52 the
landing is bilingual and none of these strings live in the markup — they
are keys in `src/locales/{es,en}.json` read through `t(locale, key)` (see
[docs/i18n.md](i18n.md)). The slots the identity depends on:

| Slot | Key | es | en |
|---|---|---|---|
| Hero headline | `hero.title` | Casas que hemos pisado. | Homes we have walked through. |
| Hero lede | `hero.lede` | Vendemos pocas propiedades a la vez, y todas las hemos visitado… | We sell only a handful of homes at a time… |
| Catalog loading | `catalog.loading` | Abriendo el cuaderno de visitas… | Opening the visit notebook… |
| Catalog empty | `catalog.empty` | Ahora mismo no hay fichas publicadas. Estamos visitando casas nuevas… | No listings published right now. We are out visiting new homes… |
| Catalog error | `catalog.error` | No hemos podido abrir el catálogo. Recarga la página o llámanos. | We could not open the catalogue. Reload the page or give us a call. |
| Card CTA | `card.cta` | Cómo es por dentro | See it from inside |
| Form heading | `form.title` | Quiero verla por dentro | I want to see it inside |
| Form submit | `form.submit` | Quiero que me llamen | Call me back |
| Form success | `form.thanks` | ¡Recibido! Te llamamos muy pronto. | Got it! We will call you very soon. |

Translations must keep the register: first person plural, no portal
vocabulary ("resultados", "búsqueda"), states written as things the agent
is doing ("we are out visiting new homes"), never as system status.

**No emoji in the UI.** The two `📷` emojis the redesign removed were
replaced by a text photo-count badge (`card.photos`, `.fotos-badge data`)
and an inline SVG house outline (`casaSvg`) for the no-photo placeholder.

## Rules for new UI

- Interactive → `--primary`. Ink → `--text`. Secondary text → `--muted`.
  Surfaces → `--surface` on `--bg`.
- `--accent` (Latón) only on numerals and 2px rules. Never a background,
  a button, or a block of text.
- Numbers get `class="… data"`. Labels above a title get `.eyebrow`.
- The apunte treatment (italic + brass left rule) is reserved; new
  emphasis needs a different device.
- Sizes come from the `--text-*` scale, spacing/radii/shadow from the
  theme tokens. No hardcoded values except the Marea-alpha overlay chrome
  described above.
- No emoji. Iconography is inline SVG using `currentColor`.
- New colour tokens go in `identity.css` in **all three** blocks (light +
  both dark selectors), never in `theme.css`.
- Styles for anything rendered by JS go in the page's `<style is:global>`
  block or in `identity.css` — never in a scoped `<style>`.

## Deliberately out of scope

Explicitly deferred by the feature 47 analysis and **not implemented**:

- A real `apunte` field in `propiedades` so the agent writes the note
  deliberately instead of it being derived from `descripcion`.
- Per-property detail routes with shareable URLs (the ficha is still a
  `<dialog>` on the single catalog page).
- Photography direction — the seed data still ships placeholder images.
- The wordmark is still the placeholder `nav.brand: "Inmobiliaria"`; a
  real brand name is a client input and a one-key change.
