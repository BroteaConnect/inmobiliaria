// The printable poster: the URL its QR encodes and the QR itself, drawn as one
// inline SVG so the poster needs no image request and no JavaScript.
//
// Server only (the poster route's frontmatter and node --test): `uqr` must
// never reach a browser bundle. The browser gets `leadOrigin` from
// lead-origin.mjs directly.
import { encode } from 'uqr';

export { decideOrigin, leadOrigin, originKey, POSTER_ORIGIN } from './lead-origin.mjs';

/** Four modules of white around the code: the quiet zone the QR spec asks for. */
const QUIET = 4;

/**
 * The absolute URL of a property page in a language, marked as coming from a
 * poster. The default language is unprefixed, like every other route.
 *
 * @param {string | URL} site the site origin (`Astro.site`)
 * @param {string} locale
 * @param {string} id the property id
 * @param {string} [defaultLocale]
 * @returns {string}
 */
export function posterTarget(site, locale, id, defaultLocale = 'es') {
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  const url = new URL(`${prefix}/propiedad/${encodeURIComponent(id)}`, site);
  url.search = 'origen=cartel';
  return url.href;
}

/** @param {string} s */
const attr = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * The QR for `text` as an inline SVG: one path, one `M…h…v1h…z` subpath per
 * horizontal run of dark modules, drawn in `currentColor` so the theme (and
 * the printer) decide the ink. ECC M survives a crease or a smudge on a
 * poster in a shop window; crispEdges keeps a scanner from reading blur.
 *
 * @param {string} text what the code encodes (the poster's target URL)
 * @param {string} label the accessible name of the image
 * @returns {string}
 */
export function qrSvg(text, label) {
  const { data, size } = encode(String(text), { ecc: 'M', border: 0 });
  const n = size + QUIET * 2;
  let d = '';
  data.forEach((row, y) => {
    for (let x = 0; x < size; x += 1) {
      if (!row[x]) continue;
      let run = 1;
      while (x + run < size && row[x + run]) run += 1;
      d += `M${x + QUIET} ${y + QUIET}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" data-qr="${attr(text)}" viewBox="0 0 ${n} ${n}" role="img" aria-label="${attr(label)}" shape-rendering="crispEdges"><path fill="currentColor" d="${d}"/></svg>`;
}
