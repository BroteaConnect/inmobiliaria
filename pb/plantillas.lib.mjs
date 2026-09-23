// plantillas.lib.mjs — the rules the message-template catalog must satisfy.
// Pure: no I/O, no PocketBase. Shared by pb/plantillas.test.mjs (which asserts
// every rule one by one) and pb/plantillas.mjs (the seed, which refuses to
// contact the instance while `problems()` has anything to say).
//
// Conventions fixed here as data, not prose:
// - `clave` is the natural key. A bare key is a WhatsApp template
//   (`visita.confirmacion`); the `.email` suffix is its email sibling.
// - `variables` is ORDERED: index i is Twilio's positional `{{i+1}}`.
//   Reordering it is a content change and bumps the version.
// - `audiencia` lives only in the catalog JSON (the seed strips it); it lets
//   the tests say "internal rows are whatsapp + utility" without a schema field.

// Strict placeholder: what the senders substitute.
export const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;
// Loose placeholder: anything that LOOKS like one. Every loose match must
// also be a strict match, or a typo (`{{ nombre }}`, `{nombre}`) ships raw.
export const LOOSE = /\{\{[^}]*\}\}|\{[^{}]*\}/g;

export const REQUIRED_CLAVES = [
  'visita.confirmacion',
  'propiedad.encaja',
  'propietario.informe',
  'lead.nuevo',
  'visita.briefing',
  'visita.cierre',
];

// Marketing WhatsApp bodies carry the opt-out sentence verbatim; marketing
// emails carry a signed unsubscribe link instead.
export const OPT_OUT = {
  es: 'Responde BAJA para no recibir más mensajes.',
  en: 'Reply STOP to opt out.',
};
export const EMAIL_OPT_OUT_VAR = 'baja_url';

export const AUDIENCES = ['lead', 'propietario', 'agente', 'gestor'];
export const INTERNAL = ['agente', 'gestor'];
export const CANALES = ['whatsapp', 'email'];
export const CATEGORIAS = ['utility', 'marketing'];

export const WHATSAPP_MAX = 1024; // Twilio Content body limit
export const CLAVE = /^[a-z0-9_.]+$/;
export const CLAVE_MAX = 80;
export const ASUNTO_MAX = 200;
export const EVENTO_MAX = 80;
export const EVENTO = /^[a-z0-9_.]+$/;
export const VARIABLE = /^[a-z0-9_]+$/;
export const EXPECTED_ROWS = 30;

// The catalog keys a row may carry. Subjects only on email rows.
export const CATALOG_KEYS = ['clave', 'nombre', 'audiencia', 'canal', 'categoria', 'evento', 'variables', 'cuerpo_es', 'cuerpo_en'];
export const EMAIL_KEYS = ['asunto_es', 'asunto_en'];
// Lifecycle fields the seed owns; the catalog never carries them.
export const LIFECYCLE_KEYS = ['estado', 'version', 'content_sid', 'content_estado', 'content_motivo', 'content_sid_en', 'content_estado_en', 'content_motivo_en'];

// What the seed compares and writes: the content, nothing else.
export const CONTENT_FIELDS = ['nombre', 'canal', 'categoria', 'evento', 'asunto_es', 'asunto_en', 'cuerpo_es', 'cuerpo_en', 'variables'];

// Placeholder names in order of appearance, duplicates kept.
export const placeholders = (text) => Array.from(String(text ?? '').matchAll(PLACEHOLDER), (m) => m[1]);

const uniq = (arr) => Array.from(new Set(arr));
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// Exactly CONTENT_FIELDS, normalised so a PocketBase record and a catalog row
// compare equal: subjects are '' on WhatsApp rows, variables is a plain array.
export const contentOf = (row) => {
  const out = {};
  for (const k of CONTENT_FIELDS) {
    if (k === 'variables') out[k] = Array.isArray(row.variables) ? [...row.variables] : [];
    else out[k] = row[k] == null ? '' : String(row[k]);
  }
  if (row.canal !== 'email') { out.asunto_es = ''; out.asunto_en = ''; }
  return out;
};

export const sameContent = (a, b) => JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b));

// Every rule the test asserts, as one "<clave>: <what>" line each. [] when
// the catalog is valid. The seed prints these and exits 2 before any I/O.
export const problems = (rows) => {
  const out = [];
  if (!Array.isArray(rows)) return ['catalog: not an array'];
  if (rows.length !== EXPECTED_ROWS) out.push(`catalog: expected ${EXPECTED_ROWS} rows, got ${rows.length}`);

  const seen = new Map();
  rows.forEach((row, i) => {
    const clave = typeof row?.clave === 'string' ? row.clave : `#${i}`;
    const p = (what) => out.push(`${clave}: ${what}`);
    if (!row || typeof row !== 'object') { p('not an object'); return; }

    // shape
    const isEmail = row.canal === 'email';
    const expected = isEmail ? [...CATALOG_KEYS, ...EMAIL_KEYS] : CATALOG_KEYS;
    const keys = Object.keys(row);
    for (const k of expected) if (!keys.includes(k)) p(`missing key ${k}`);
    for (const k of keys) if (!expected.includes(k)) p(`unexpected key ${k}`);

    // claves
    if (typeof row.clave !== 'string' || !CLAVE.test(row.clave)) p('clave does not match ^[a-z0-9_.]+$');
    if (typeof row.clave === 'string' && row.clave.length > CLAVE_MAX) p(`clave longer than ${CLAVE_MAX}`);
    if (typeof row.clave === 'string') {
      if (seen.has(row.clave)) p('duplicate clave');
      seen.set(row.clave, row);
      if (row.clave.endsWith('.email') !== isEmail) p('.email suffix must match canal === email');
    }

    // enums
    if (!CANALES.includes(row.canal)) p(`canal must be one of ${CANALES.join('|')}`);
    if (!CATEGORIAS.includes(row.categoria)) p(`categoria must be one of ${CATEGORIAS.join('|')}`);
    if (!AUDIENCES.includes(row.audiencia)) p(`audiencia must be one of ${AUDIENCES.join('|')}`);
    if (typeof row.evento !== 'string' || !EVENTO.test(row.evento) || row.evento.length > EVENTO_MAX) p('evento must match ^[a-z0-9_.]+$ and be at most 80 chars');
    if (typeof row.nombre !== 'string' || row.nombre.trim() === '') p('nombre is empty');

    // both languages
    const es = typeof row.cuerpo_es === 'string' ? row.cuerpo_es : '';
    const en = typeof row.cuerpo_en === 'string' ? row.cuerpo_en : '';
    if (es.trim() === '') p('cuerpo_es is empty');
    if (en.trim() === '') p('cuerpo_en is empty');
    if (es !== '' && es === en) p('cuerpo_es and cuerpo_en are identical');
    if (isEmail) {
      const aes = typeof row.asunto_es === 'string' ? row.asunto_es : '';
      const aen = typeof row.asunto_en === 'string' ? row.asunto_en : '';
      if (aes.trim() === '') p('asunto_es is empty');
      if (aen.trim() === '') p('asunto_en is empty');
      if (aes.length > ASUNTO_MAX) p(`asunto_es longer than ${ASUNTO_MAX}`);
      if (aen.length > ASUNTO_MAX) p(`asunto_en longer than ${ASUNTO_MAX}`);
      if (aes !== '' && aes === aen) p('asunto_es and asunto_en are identical');
    }

    // placeholders declared
    const vars = Array.isArray(row.variables) ? row.variables : [];
    if (!Array.isArray(row.variables)) p('variables is not an array');
    for (const v of vars) if (typeof v !== 'string' || !VARIABLE.test(v)) p(`variable ${String(v)} does not match ^[a-z0-9_]+$`);
    if (uniq(vars).length !== vars.length) p('variables has duplicates');
    const pes = uniq(placeholders(es));
    const pen = uniq(placeholders(en));
    if (!sameSet(pes, vars)) p(`cuerpo_es placeholders [${pes}] differ from variables [${vars}]`);
    if (!sameSet(pen, vars)) p(`cuerpo_en placeholders [${pen}] differ from variables [${vars}]`);
    if (isEmail) {
      for (const [k, text] of [['asunto_es', row.asunto_es], ['asunto_en', row.asunto_en]]) {
        for (const ph of uniq(placeholders(text))) if (!vars.includes(ph)) p(`${k} uses undeclared {{${ph}}}`);
      }
    }
    const texts = isEmail ? [es, en, String(row.asunto_es ?? ''), String(row.asunto_en ?? '')] : [es, en];
    for (const text of texts) {
      for (const m of text.match(LOOSE) ?? []) {
        if (!new RegExp(`^${PLACEHOLDER.source}$`).test(m)) p(`malformed placeholder ${m}`);
      }
    }

    // whatsapp
    if (row.canal === 'whatsapp') {
      for (const [k, text] of [['cuerpo_es', es], ['cuerpo_en', en]]) {
        if (text.length > WHATSAPP_MAX) p(`${k} longer than ${WHATSAPP_MAX}`);
        if (text.startsWith('{{')) p(`${k} starts with a placeholder`);
        if (text.endsWith('}}')) p(`${k} ends with a placeholder`);
        const all = placeholders(text);
        for (const ph of uniq(all)) if (all.filter((x) => x === ph).length !== 1) p(`${k} uses {{${ph}}} more than once`);
        if (/(https?:\/\/|www\.)\S*\{\{/.test(text)) p(`${k} has a placeholder inside a URL`);
        if (text.includes('\n')) p(`${k} contains a newline`);
      }
    }

    // opt-out
    if (row.categoria === 'marketing') {
      if (row.canal === 'whatsapp') {
        if (!es.includes(OPT_OUT.es)) p('marketing whatsapp cuerpo_es lacks the opt-out sentence');
        if (!en.includes(OPT_OUT.en)) p('marketing whatsapp cuerpo_en lacks the opt-out sentence');
      }
      if (isEmail && !vars.includes(EMAIL_OPT_OUT_VAR)) p(`marketing email does not declare ${EMAIL_OPT_OUT_VAR}`);
    }
    if (typeof row.clave === 'string' && row.clave.startsWith('consentimiento.solicitud') && row.categoria !== 'marketing') p('consentimiento.solicitud* must be marketing');

    // internal rows
    if (INTERNAL.includes(row.audiencia)) {
      if (row.canal !== 'whatsapp') p('internal audience must use whatsapp');
      if (row.categoria !== 'utility') p('internal audience must be utility');
    }
  });

  for (const clave of REQUIRED_CLAVES) if (!seen.has(clave)) out.push(`${clave}: required clave missing`);
  return out;
};
