// campanas.lib.mjs — the rules the campaign catalog (pb/campanas.json) must
// satisfy. Pure: no I/O, no PocketBase. Shared by pb/campanas.test.mjs (which
// asserts every rule) and pb/campanas.mjs (the seed, which refuses to contact
// the instance while problems() has anything to say).
//
// Conventions fixed here as data, not prose:
// - `nombre` is the natural key. There is no `clave` column on `campanas`, and
//   a campaign is named by a human in Spanish; the seed matches on it exactly.
// - `plantilla` in the catalog is the template's CLAVE; the seed resolves it to
//   the record id, because a relation needs an id and a clave is what a person
//   can read in a diff.
// - `nota` lives only in the catalog (the seed strips it). JSON carries no
//   comments and some of these numbers are a snapshot of live data that a
//   future reader must not mistake for a rule.
//
// The segment contract itself is NOT redefined here: it is the same
// jobs/campanas.lib.mjs the runner uses, so the catalog cannot be valid for the
// seed and invalid for the job that reads it.
import {
  CLAVE_VARIABLES, VARIABLES_DEL_CHASIS, hhmmAMinutos, plantillaLista, problemasSegmento,
} from '../jobs/campanas.lib.mjs';

export { plantillaLista };

// Keys a catalog row may carry.
export const CATALOG_KEYS = ['nombre', 'plantilla', 'segmento', 'lote_diario', 'intervalo_min', 'hora_desde', 'hora_hasta', 'estado', 'nota'];
// Fields the seed writes; `nombre` is the identity and only travels on create.
export const CONTENT_FIELDS = ['plantilla', 'segmento', 'lote_diario', 'intervalo_min', 'hora_desde', 'hora_hasta', 'estado'];
// pb/schema.json marks only `nombre` required on `campanas`.
export const REQUIRED_ON_CREATE = ['nombre'];

// A seed may only ever put a campaign in one of these. `en_curso`, `pausada`,
// `completada` and `cancelada` are what the runner and a human write; a seed
// that could set them could restart a finished campaign from a JSON file.
export const ESTADOS_SEMBRABLES = ['borrador', 'programada'];
export const NOMBRE_MAX = 120;
export const EXPECTED_ROWS = 2;
export const CLAVE = /^[a-z0-9_.]+$/;

// Variables the runner computes per lead: they are never the campaign's job to
// supply, so the catalog must not be asked for them (see variablesPara()).
export const VARIABLES_POR_LEAD = ['nombre', 'agente'];

// The one template allowed to reach a lead who has not consented: asking for
// consent. The chassis keys the same exemption on this `evento`, not on a
// clave, so a second consent-request template inherits it by declaring it.
export const EVENTO_CONSENTIMIENTO = 'campana.consentimiento';

const esObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const entero = (v, min) => typeof v === 'number' && Number.isInteger(v) && v >= min;

/** Exactly CONTENT_FIELDS, with the template clave replaced by its record id. */
export const contentOf = (row, plantillaId) => ({
  plantilla: plantillaId ?? '',
  segmento: row.segmento,
  lote_diario: row.lote_diario,
  intervalo_min: row.intervalo_min,
  hora_desde: row.hora_desde,
  hora_hasta: row.hora_hasta,
  estado: row.estado,
});

export const createBody = (row, plantillaId) => ({ nombre: row.nombre, ...contentOf(row, plantillaId) });
// Never `nombre`: the row already is that name, and renaming it would create a
// second campaign on the next run instead of updating this one.
export const updateBody = (row, plantillaId) => contentOf(row, plantillaId);

export const missingOnCreate = (body) =>
  REQUIRED_ON_CREATE.filter((k) => body?.[k] == null || String(body[k]).trim() === '');

/**
 * Every problem of the catalog on its own, one "<nombre>: <what>" line each.
 * The cross-checks against the template catalog live in problemasConPlantillas().
 */
export function problems(rows) {
  const out = [];
  if (!Array.isArray(rows)) return ['catalog: not an array'];
  if (rows.length !== EXPECTED_ROWS) out.push(`catalog: expected ${EXPECTED_ROWS} rows, got ${rows.length}`);
  const seen = new Set();
  rows.forEach((row, i) => {
    const nombre = typeof row?.nombre === 'string' ? row.nombre : `#${i}`;
    const p = (what) => out.push(`${nombre}: ${what}`);
    if (!esObjeto(row)) { p('not an object'); return; }
    for (const k of CATALOG_KEYS) if (!(k in row)) p(`missing key ${k}`);
    for (const k of Object.keys(row)) if (!CATALOG_KEYS.includes(k)) p(`unexpected key ${k}`);

    if (typeof row.nombre !== 'string' || row.nombre.trim() === '') p('nombre is empty');
    else {
      if (row.nombre.length > NOMBRE_MAX) p(`nombre longer than ${NOMBRE_MAX}`);
      if (seen.has(row.nombre)) p('duplicate nombre (it is the natural key)');
      seen.add(row.nombre);
    }
    if (typeof row.plantilla !== 'string' || !CLAVE.test(row.plantilla)) p('plantilla must be a template clave');
    if (typeof row.nota !== 'string' || row.nota.trim() === '') p('nota is empty (say why these numbers are what they are)');
    if (!ESTADOS_SEMBRABLES.includes(row.estado)) p(`estado must be one of ${ESTADOS_SEMBRABLES.join('|')}`);
    if (!entero(row.lote_diario, 1)) p('lote_diario must be an integer >= 1');
    if (!entero(row.intervalo_min, 0)) p('intervalo_min must be an integer >= 0');
    const desde = hhmmAMinutos(row.hora_desde);
    const hasta = hhmmAMinutos(row.hora_hasta);
    if (desde == null) p('hora_desde must be HH:MM');
    if (hasta == null) p('hora_hasta must be HH:MM');
    if (desde != null && hasta != null && desde >= hasta) p('hora_desde must be before hora_hasta (the window does not wrap around midnight)');
    for (const problema of problemasSegmento(row.segmento)) p(`segmento: ${problema}`);
  });
  return out;
}

/**
 * The rules that need the template catalog too: they are the ones that decide
 * whether a campaign could ever send anything.
 */
export function problemasConPlantillas(rows, plantillas) {
  const out = [];
  if (!Array.isArray(rows) || !Array.isArray(plantillas)) return ['catalog: not an array'];
  const porClave = new Map(plantillas.map((p) => [p.clave, p]));
  for (const row of rows) {
    const nombre = typeof row?.nombre === 'string' ? row.nombre : '#?';
    const p = (what) => out.push(`${nombre}: ${what}`);
    const plantilla = porClave.get(row?.plantilla);
    if (!plantilla) { p(`plantilla ${row?.plantilla} is not in pb/plantillas.json`); continue; }

    // Marketing to people who have not consented is exactly what the law is
    // about. The ONE exception is the message that asks for consent, and it is
    // recognised by its `evento` — a clave is a name, an evento is a promise.
    const pideConsentimiento = row?.segmento?.consentimiento === false;
    if (plantilla.categoria === 'marketing' && pideConsentimiento && plantilla.evento !== EVENTO_CONSENTIMIENTO) {
      p(`segmento consentimiento:false with the marketing template ${plantilla.clave}: only a template whose evento is ${EVENTO_CONSENTIMIENTO} may be sent to someone who has not consented`);
    }

    // Every value the body needs has to have a source, or the campaign blocks
    // on its first recipient instead of at review time.
    const declaradas = Array.isArray(plantilla.variables) ? plantilla.variables : [];
    const fijas = esObjeto(row?.segmento?.[CLAVE_VARIABLES]) ? row.segmento[CLAVE_VARIABLES] : {};
    for (const v of declaradas) {
      if (VARIABLES_DEL_CHASIS.includes(v)) continue;   // minted and signed by the chassis
      if (VARIABLES_POR_LEAD.includes(v)) continue;     // resolved per lead by the runner
      if (!(v in fijas)) p(`segmento.variables lacks ${v}, which ${plantilla.clave} declares`);
    }
    for (const v of Object.keys(fijas)) {
      if (!declaradas.includes(v)) p(`segmento.variables has ${v}, which ${plantilla.clave} does not declare`);
    }
  }
  return out;
}

/**
 * Is this seeded campaign ready to send, or blocked on something outside the
 * catalog? `plantillas` here are the rows as they are ON THE INSTANCE (the
 * approval state is a fact about Twilio and Meta, not about a JSON file).
 * Returns one { nombre, code, motivo } per blocked campaign, [] when all clear.
 */
export function bloqueadas(rows, plantillasInstancia) {
  const porClave = new Map((plantillasInstancia ?? []).map((p) => [p.clave, p]));
  return (rows ?? []).map((row) => {
    const estado = plantillaLista(porClave.get(row?.plantilla) ?? null);
    return estado.listo ? null : { nombre: row?.nombre, code: estado.code, motivo: estado.motivo };
  }).filter(Boolean);
}
