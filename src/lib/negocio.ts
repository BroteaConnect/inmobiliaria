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

/**
 * Rellena cada `<span data-negocio="...">` de la página.
 *
 * Lo que no está configurado se marca como pendiente en vez de quedarse en
 * blanco: un aviso legal con un hueco mudo parece completo y no lo está.
 */
export async function pintarNegocio(pendiente: string): Promise<void> {
  const huecos = [...document.querySelectorAll<HTMLElement>('[data-negocio]')];
  if (!huecos.length) return;
  let datos: Record<string, string> = {};
  try {
    const r = await list<Fila>('settings', { perPage: '50' });
    datos = Object.fromEntries(r.items
      .filter((f) => f.key?.startsWith('negocio.') || f.key === 'contacto.whatsapp')
      .map((f) => [f.key.split('.')[1], texto(f.value)]));
  } catch {
    // Sin base de datos se queda lo que ya hay en la página: el marcador.
  }
  for (const hueco of huecos) {
    const clave = hueco.dataset.negocio ?? '';
    const valor = datos[clave] ?? '';
    hueco.textContent = valor || pendiente;
    hueco.classList.toggle('negocio-pendiente', !valor);
  }
}
