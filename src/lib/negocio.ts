import { list } from './pb';

// Los datos del negocio los escribe el titular en Ajustes (CRM) y esta web los
// lee al cargar. Viven en la colección `settings`, no en el código ni en los
// diccionarios: cambian sin desplegar y sin tocar a nadie más.
//
// La alternativa era escribirlos en el repositorio, y entonces cada corrección
// de una dirección sería un PR, un CI y un despliegue para cambiar una línea de
// una página legal.

interface Fila { key: string; value: unknown }

/** Un valor guardado puede venir como objeto o como cadena JSON. */
function texto(value: unknown): string {
  const obj = typeof value === 'string' ? safeParse(value) : value;
  if (obj && typeof obj === 'object') {
    const o = obj as { text?: unknown; numero?: unknown };
    if (typeof o.text === 'string') return o.text.trim();
    if (typeof o.numero === 'string') return o.numero.trim();
  }
  return '';
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** The settings the site reads, keyed by the part after the dot. */
export type Business = Record<string, string>;

let cache: Promise<Business> | null = null;

/**
 * The business settings, fetched once per page no matter how many scripts ask
 * (the footer, the WhatsApp doors and the price formatter all do). `negocio.*`
 * rows and `contacto.whatsapp` arrive keyed by their last segment
 * (`telefono`, `moneda`, `whatsapp`...).
 *
 * Never rejects: a `settings` collection that is unreadable or empty is an
 * empty map, and every caller already knows what to show when a value is
 * missing. A page must render its doors without this data, not wait for it.
 */
export function loadBusiness(): Promise<Business> {
  cache ??= list<Fila>('settings', { perPage: '50' })
    .then((r) => Object.fromEntries(r.items
      .filter((f) => f.key?.startsWith('negocio.') || f.key === 'contacto.whatsapp')
      .map((f) => [f.key.split('.')[1], texto(f.value)])))
    .catch(() => ({}));
  return cache;
}

/** The WhatsApp number as wa.me wants it: digits only, or nothing. */
export const whatsappOf = (d: Business): string => (d.whatsapp ?? '').replace(/[^\d]/g, '');

/**
 * The currency code, or nothing. Three letters or it is ignored: `Intl` throws
 * on anything else, and a blank page over a mistyped setting is worse than a
 * price in the previous currency.
 */
export function currencyOf(d: Business): string {
  const cod = (d.moneda ?? '').toUpperCase();
  return /^[A-Z]{3}$/.test(cod) ? cod : '';
}

/**
 * Rellena cada `<span data-negocio="...">` de la página.
 *
 * Lo que no está configurado se marca como pendiente en vez de quedarse en
 * blanco: un aviso legal con un hueco mudo parece completo y no lo está.
 */
export async function pintarNegocio(pendiente: string): Promise<void> {
  const huecos = [...document.querySelectorAll<HTMLElement>('[data-negocio]')];
  if (!huecos.length) return;
  const datos = await loadBusiness();
  for (const hueco of huecos) {
    const clave = hueco.dataset.negocio ?? '';
    const valor = datos[clave] ?? '';
    hueco.textContent = valor || pendiente;
    hueco.classList.toggle('negocio-pendiente', !valor);
  }
}
