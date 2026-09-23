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
