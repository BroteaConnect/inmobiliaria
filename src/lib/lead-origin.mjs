// Where a lead came from, read from the address it arrived at. Its own module,
// with no imports, because the lead form's browser script needs it and must
// not pull the QR encoder into the bundle with it (poster.mjs re-exports it).

/** The one `origen` a URL can claim: anything else is the website itself. */
export const POSTER_ORIGIN = 'cartel';

/**
 * 'cartel' only when the query says exactly `origen=cartel`; every other
 * value, casing or absence is 'web'. Strict on purpose: the value lands in
 * `leads.origen`, and a URL anybody can type must not invent new origins.
 *
 * @param {string} search `location.search`, with or without the leading `?`
 * @returns {'cartel' | 'web'}
 */
export function leadOrigin(search) {
  try {
    return new URLSearchParams(String(search ?? '')).get('origen') === POSTER_ORIGIN ? POSTER_ORIGIN : 'web';
  } catch {
    return 'web';
  }
}

/** @param {string} propertyId the sessionStorage key a poster visit is remembered under */
export const originKey = (propertyId) => `origen:${propertyId}`;

/**
 * The origin a lead is saved with: the poster when this URL says so, or when
 * this tab arrived through the poster earlier (`stored`, the value remembered
 * under `originKey`); the website otherwise.
 *
 * @param {string} search `location.search` at submit time
 * @param {string | null | undefined} stored the remembered value, if any
 * @returns {'cartel' | 'web'}
 */
export function decideOrigin(search, stored) {
  return leadOrigin(search) === POSTER_ORIGIN || stored === POSTER_ORIGIN ? POSTER_ORIGIN : 'web';
}
