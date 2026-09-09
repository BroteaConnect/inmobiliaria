// Server side only: the published property behind an id. Imported by the
// on-demand page, never by a browser script (it reads the runtime env).
import { pbUrl } from './pb';
import type { Property } from './property';

/** The property is not for the public, or does not exist: the route answers 404. */
export type Lookup = Property | 'missing' | 'error';

/**
 * The PocketBase URL: inlined at build time like everywhere else in the app,
 * with the container's own environment as the fallback for a runtime that
 * was built without it.
 */
export function pbBase(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return pbUrl() || (env?.PUBLIC_PB_URL ?? '').trim();
}

/**
 * Only a `publicada` record renders. A draft, a reserved or a sold one is
 * `ausente` exactly like an unknown id: the page must not tell a crawler
 * that a listing exists in any state the CRM has not published.
 */
export async function publishedProperty(id: string, base = pbBase()): Promise<Lookup> {
  // PocketBase ids are 15 alphanumerics; anything else cannot be a record and
  // is not worth a round trip.
  if (!base || !/^[a-z0-9]{15}$/i.test(id)) return 'missing';
  try {
    const res = await fetch(`${base}/api/collections/propiedades/records/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return 'missing';
    if (!res.ok) return 'error';
    const p = (await res.json()) as Property;
    return p?.id === id && p.estado === 'publicada' ? p : 'missing';
  } catch {
    return 'error';
  }
}
