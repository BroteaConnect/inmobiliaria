// The facts of a property, phrased once for the catalogue card, the property
// page and its metadata. Isomorphic on purpose: the page renders these on the
// server and the catalogue renders them in the browser, and a buyer comparing
// the two must read the same words.
import { fmtMoney, fmtNumber, t, type Locale } from './i18n';
import type { Propiedades } from './model';
import { fileUrl } from './pb';

/** A property as PocketBase returns it: the schema's fields plus the file-URL keys. */
export interface Propiedad extends Propiedades { collectionId: string }

/**
 * The currency until the owner sets `negocio.moneda` in the CRM. AED is what
 * the live catalogue was printing, so it stays the default (Design Read,
 * tell 11: one currency for two markets is schema work, not this page's).
 */
export const DEFAULT_CURRENCY = 'AED';

/** The photo count, tolerant of a record with no `fotos` at all. */
export const fotos = (p: Pick<Propiedad, 'fotos'>): string[] => p.fotos ?? [];

/** The URL of the n-th photo, at strip size when asked; empty when there is none. */
export function fotoUrl(p: Pick<Propiedad, 'id' | 'collectionId' | 'fotos'>, i = 0, thumb = false): string {
  const f = fotos(p)[i];
  return f ? fileUrl(p, f) + (thumb ? '?thumb=600x400' : '') : '';
}

/**
 * El apunte de visita, the signature line: the first sentence of the
 * description, capped at 140 characters, ending in a full stop.
 */
export function apunteDe(p: Pick<Propiedad, 'descripcion'>): string {
  const a = (p.descripcion ?? '').split(/\.\s/)[0].trim().slice(0, 140);
  return a ? (/[.!?…]$/.test(a) ? a : `${a}.`) : '';
}

/**
 * The description as one preview line of at most `max` characters, for
 * `og:description` and the meta description. Whitespace collapsed, cut on a
 * word, never mid-word.
 */
export function resumenDe(p: Pick<Propiedad, 'descripcion'>, max = 160): string {
  const s = (p.descripcion ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

/** The description split into paragraphs, blank lines and newlines alike. */
export const parrafosDe = (p: Pick<Propiedad, 'descripcion'>): string[] =>
  (p.descripcion ?? '').split(/\n+/).map((s) => s.trim()).filter(Boolean);

/** True when the description is the note and nothing more: printing both would print it twice. */
export function descripcionEsApunte(p: Pick<Propiedad, 'descripcion'>): boolean {
  const apunte = apunteDe(p);
  const desc = (p.descripcion ?? '').trim();
  return !!apunte && (desc === apunte || `${desc}.` === apunte);
}

/** A real price, or nothing: a zero is a missing value, never an amount. */
export const precioReal = (p: Pick<Propiedad, 'precio'>): number =>
  typeof p.precio === 'number' && Number.isFinite(p.precio) && p.precio > 0 ? p.precio : 0;

/** The price as copy: Intl money in the buyer's language, or the on-request line. */
export function precioDe(locale: Locale, p: Pick<Propiedad, 'precio'>, moneda = DEFAULT_CURRENCY): string {
  const n = precioReal(p);
  return n ? fmtMoney(locale, n, moneda) : t(locale, 'prop.priceOnRequest');
}

/**
 * The facts line: bedrooms, bathrooms and area, each only when it is a
 * number above zero. Four live units carry `habitaciones: 0`, and "0 bed" is
 * not a fact about a home.
 */
export function metaDe(locale: Locale, p: Pick<Propiedad, 'habitaciones' | 'banos' | 'superficie'>): string {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const parts = [
    n(p.habitaciones) ? t(locale, 'prop.rooms', { count: n(p.habitaciones) }) : '',
    n(p.banos) ? t(locale, 'prop.baths', { count: n(p.banos) }) : '',
    n(p.superficie) ? t(locale, 'prop.area', { area: fmtNumber(locale, n(p.superficie)) }) : '',
  ];
  return parts.filter(Boolean).join(' · ');
}
