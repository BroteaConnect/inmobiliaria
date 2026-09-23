// plantillas.test.mjs — the message-template catalog is data, and data has
// rules. Every rule here is what a sender (WhatsApp via Twilio Content, email
// via the chassis) needs to hold true; pb/plantillas.lib.mjs is the one place
// they are written, and test (9) checks the two agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ASUNTO_MAX, AUDIENCES, CANALES, CATALOG_KEYS, CATALOG_VERSION, CATEGORIAS, CLAVE, CLAVE_MAX, CONTENT_FIELDS,
  EMAIL_KEYS, EMAIL_OPT_OUT_VAR, EVENTO, EVENTO_MAX, EXPECTED_ROWS, INTERNAL, LIFECYCLE_KEYS, LOOSE, OPT_OUT,
  PLACEHOLDER, REQUIRED_CLAVES, REQUIRED_ON_CREATE, VARIABLE, WHATSAPP_MAX, createBody, missingOnCreate,
  placeholders, problems, updateBody,
} from './plantillas.lib.mjs';

const rows = JSON.parse(readFileSync(new URL('./plantillas.json', import.meta.url), 'utf8'));
const uniq = (arr) => Array.from(new Set(arr));
const isEmail = (row) => row.canal === 'email';
const texts = (row) => (isEmail(row) ? [row.cuerpo_es, row.cuerpo_en, row.asunto_es, row.asunto_en] : [row.cuerpo_es, row.cuerpo_en]);

test('shape: 30 rows with exactly the catalog keys and no lifecycle fields', () => {
  assert.equal(rows.length, EXPECTED_ROWS);
  for (const row of rows) {
    const expected = isEmail(row) ? [...CATALOG_KEYS, ...EMAIL_KEYS] : CATALOG_KEYS;
    assert.deepEqual(Object.keys(row).sort(), [...expected].sort(), row.clave);
    for (const k of LIFECYCLE_KEYS) assert.equal(k in row, false, `${row.clave} carries ${k}`);
  }
});

test('claves: pattern, length, unique, .email suffix matches canal, required ones present', () => {
  const claves = rows.map((r) => r.clave);
  for (const row of rows) {
    assert.match(row.clave, CLAVE);
    assert.ok(row.clave.length <= CLAVE_MAX, row.clave);
    assert.equal(row.clave.endsWith('.email'), isEmail(row), row.clave);
  }
  assert.equal(uniq(claves).length, claves.length, 'duplicate clave');
  for (const clave of REQUIRED_CLAVES) assert.ok(claves.includes(clave), `missing ${clave}`);
});

test('enums: canal, categoria, audiencia, evento and nombre', () => {
  for (const row of rows) {
    assert.ok(CANALES.includes(row.canal), `${row.clave} canal`);
    assert.ok(CATEGORIAS.includes(row.categoria), `${row.clave} categoria`);
    assert.ok(AUDIENCES.includes(row.audiencia), `${row.clave} audiencia`);
    assert.match(row.evento, EVENTO, row.clave);
    assert.ok(row.evento.length <= EVENTO_MAX, row.clave);
    assert.ok(row.nombre.trim().length > 0, `${row.clave} nombre`);
  }
});

test('both languages: bodies and subjects non-empty and different', () => {
  for (const row of rows) {
    assert.ok(row.cuerpo_es.trim().length > 0, `${row.clave} cuerpo_es`);
    assert.ok(row.cuerpo_en.trim().length > 0, `${row.clave} cuerpo_en`);
    assert.notEqual(row.cuerpo_es, row.cuerpo_en, `${row.clave} bodies identical`);
    if (isEmail(row)) {
      for (const k of EMAIL_KEYS) {
        assert.ok(row[k].trim().length > 0, `${row.clave} ${k}`);
        assert.ok(row[k].length <= ASUNTO_MAX, `${row.clave} ${k}`);
      }
      assert.notEqual(row.asunto_es, row.asunto_en, `${row.clave} subjects identical`);
    }
  }
});

test('placeholders declared: variables unique, bodies use exactly them, no malformed braces', () => {
  for (const row of rows) {
    assert.ok(Array.isArray(row.variables), row.clave);
    for (const v of row.variables) assert.match(v, VARIABLE, row.clave);
    assert.equal(uniq(row.variables).length, row.variables.length, `${row.clave} duplicate variable`);
    const declared = [...row.variables].sort();
    assert.deepEqual(uniq(placeholders(row.cuerpo_es)).sort(), declared, `${row.clave} cuerpo_es`);
    assert.deepEqual(uniq(placeholders(row.cuerpo_en)).sort(), declared, `${row.clave} cuerpo_en`);
    if (isEmail(row)) {
      for (const k of EMAIL_KEYS) {
        for (const ph of placeholders(row[k])) assert.ok(row.variables.includes(ph), `${row.clave} ${k} uses {{${ph}}}`);
      }
    }
    const strict = new RegExp(`^${PLACEHOLDER.source}$`);
    for (const text of texts(row)) {
      for (const m of text.match(LOOSE) ?? []) assert.match(m, strict, `${row.clave} malformed ${m}`);
    }
  }
});

test('whatsapp: length, no leading/trailing placeholder, each once, none inside a URL, no newline', () => {
  const wa = rows.filter((r) => r.canal === 'whatsapp');
  assert.ok(wa.length > 0);
  for (const row of wa) {
    for (const text of [row.cuerpo_es, row.cuerpo_en]) {
      assert.ok(text.length <= WHATSAPP_MAX, `${row.clave} too long`);
      assert.equal(text.startsWith('{{'), false, `${row.clave} starts with a placeholder`);
      assert.equal(text.endsWith('}}'), false, `${row.clave} ends with a placeholder`);
      const all = placeholders(text);
      assert.equal(uniq(all).length, all.length, `${row.clave} repeats a placeholder`);
      assert.doesNotMatch(text, /(https?:\/\/|www\.)\S*\{\{/, `${row.clave} placeholder inside a URL`);
      assert.equal(text.includes('\n'), false, `${row.clave} has a newline`);
    }
  }
});

test('opt-out: marketing whatsapp carries the sentence, marketing email declares baja_url, consent requests are marketing', () => {
  for (const row of rows) {
    if (row.categoria === 'marketing' && row.canal === 'whatsapp') {
      assert.ok(row.cuerpo_es.includes(OPT_OUT.es), `${row.clave} es opt-out`);
      assert.ok(row.cuerpo_en.includes(OPT_OUT.en), `${row.clave} en opt-out`);
    }
    if (row.categoria === 'marketing' && isEmail(row)) {
      assert.ok(row.variables.includes(EMAIL_OPT_OUT_VAR), `${row.clave} ${EMAIL_OPT_OUT_VAR}`);
    }
    if (row.clave.startsWith('consentimiento.solicitud')) assert.equal(row.categoria, 'marketing', row.clave);
  }
});

test('internal rows: agente/gestor audiences are whatsapp + utility and are exactly the known set', () => {
  const internal = rows.filter((r) => INTERNAL.includes(r.audiencia));
  for (const row of internal) {
    assert.equal(row.canal, 'whatsapp', row.clave);
    assert.equal(row.categoria, 'utility', row.clave);
  }
  assert.deepEqual(internal.map((r) => r.clave), [
    'lead.nuevo',
    'lead.sin_respuesta',
    'visita.briefing',
    'visita.cierre',
    'matcher.shortlist',
    'campana.respuesta',
    'campana.informe',
    'borrador.propuesta',
    'resumen.semanal',
  ]);
});

test('lib agreement: problems() is empty for the catalog and catches duplicates and same-language bodies', () => {
  assert.deepEqual(problems(rows), []);

  const duplicated = [...rows.slice(0, 29), { ...rows[0] }];
  assert.ok(problems(duplicated).some((p) => p === `${rows[0].clave}: duplicate clave`), 'duplicate row undetected');

  const sameBody = rows.map((r, i) => (i === 0 ? { ...r, cuerpo_en: r.cuerpo_es } : r));
  assert.ok(problems(sameBody).some((p) => p === `${rows[0].clave}: cuerpo_es and cuerpo_en are identical`), 'same-body row undetected');
});

// The seed's bodies: PocketBase requires clave/nombre/cuerpo_es/cuerpo_en on
// POST, and `clave` is the identity — sent on create, never on update. The
// first live run 400ed on exactly this; the dry-run had never built a body.
test('seed bodies: create carries clave and every schema-required field, update never carries clave', () => {
  const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));
  const plantillas = (Array.isArray(schema) ? schema : schema.collections ?? []).find((c) => c.name === 'plantillas');
  const required = (plantillas.fields ?? plantillas.schema).filter((f) => f.required && !['created', 'updated'].includes(f.name)).map((f) => f.name);
  assert.deepEqual([...required].sort(), [...REQUIRED_ON_CREATE].sort(), 'REQUIRED_ON_CREATE disagrees with pb/schema.json');

  for (const row of rows) {
    const create = createBody(row);
    assert.equal(create.clave, row.clave, `${row.clave} create body lacks clave`);
    for (const k of REQUIRED_ON_CREATE) assert.ok(typeof create[k] === 'string' && create[k].trim() !== '', `${row.clave} create body lacks ${k}`);
    assert.deepEqual(missingOnCreate(create), [], row.clave);
    assert.equal(create.estado, 'borrador', row.clave);
    assert.equal(create.version, CATALOG_VERSION, row.clave);
    for (const k of CONTENT_FIELDS) assert.ok(k in create, `${row.clave} create body lacks ${k}`);
    assert.equal('audiencia' in create, false, `${row.clave} create body leaks audiencia`);

    const update = updateBody(row);
    assert.equal('clave' in update, false, `${row.clave} update body carries clave`);
    assert.equal(update.version, CATALOG_VERSION, row.clave);
    assert.equal(update.estado, 'borrador', row.clave);
    for (const k of ['content_sid', 'content_motivo', 'content_sid_en', 'content_motivo_en']) assert.equal(update[k], '', `${row.clave} update does not reset ${k}`);
    for (const k of CONTENT_FIELDS) assert.deepEqual(update[k], create[k], `${row.clave} ${k} differs between create and update`);
    const wa = row.canal === 'whatsapp';
    assert.equal(create.content_estado, wa ? 'unsubmitted' : '', row.clave);
    assert.equal(update.content_estado_en, wa ? 'unsubmitted' : '', row.clave);
  }

  // A body missing a required field is named, in schema order.
  const { clave: _c, ...noClave } = createBody(rows[0]);
  assert.deepEqual(missingOnCreate(noClave), ['clave']);
  assert.deepEqual(missingOnCreate({ ...createBody(rows[0]), nombre: '  ', cuerpo_en: '' }), ['nombre', 'cuerpo_en']);
});
