// campanas.test.mjs — the campaign catalog is data, and data has rules. Every
// rule here is something that has to be true before a message can leave;
// pb/campanas.lib.mjs is the one place they are written, and the last test
// checks that the seed's validator and this file agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CATALOG_KEYS, CONTENT_FIELDS, ESTADOS_SEMBRABLES, EVENTO_CONSENTIMIENTO, EXPECTED_ROWS, NOMBRE_MAX,
  REQUIRED_ON_CREATE, VARIABLES_POR_LEAD, bloqueadas, createBody, missingOnCreate, problemasConPlantillas,
  problems, updateBody,
} from './campanas.lib.mjs';
import { VARIABLES_DEL_CHASIS, hhmmAMinutos, problemasSegmento } from '../jobs/campanas.lib.mjs';

const rows = JSON.parse(readFileSync(new URL('./campanas.json', import.meta.url), 'utf8'));
const plantillas = JSON.parse(readFileSync(new URL('./plantillas.json', import.meta.url), 'utf8'));
const porClave = new Map(plantillas.map((p) => [p.clave, p]));
const clone = (v) => JSON.parse(JSON.stringify(v));

test('the catalog is valid on its own and against the template catalog', () => {
  assert.deepEqual(problems(rows), []);
  assert.deepEqual(problemasConPlantillas(rows, plantillas), []);
});

test('shape: the expected rows, exactly the catalog keys, a nota on each', () => {
  assert.equal(rows.length, EXPECTED_ROWS);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [...CATALOG_KEYS].sort(), row.nombre);
    assert.ok(row.nota.trim().length > 0, `${row.nombre} nota`);
    assert.ok(row.nombre.length <= NOMBRE_MAX, row.nombre);
  }
  const nombres = rows.map((r) => r.nombre);
  assert.equal(new Set(nombres).size, nombres.length, 'nombre is the natural key');
});

test('every segment satisfies the runner\'s own contract, not a copy of it', () => {
  for (const row of rows) assert.deepEqual(problemasSegmento(row.segmento), [], row.nombre);
});

test('a seed may only ever write borrador or programada', () => {
  for (const row of rows) assert.ok(ESTADOS_SEMBRABLES.includes(row.estado), `${row.nombre}: ${row.estado}`);
  const running = clone(rows);
  running[0].estado = 'en_curso';
  assert.ok(problems(running).some((p) => p.includes('estado must be')));
});

test('the sending window is a window: HH:MM, and desde before hasta', () => {
  for (const row of rows) {
    assert.ok(hhmmAMinutos(row.hora_desde) < hhmmAMinutos(row.hora_hasta), row.nombre);
  }
  const wrap = clone(rows);
  wrap[0].hora_desde = '22:00';
  wrap[0].hora_hasta = '06:00';
  assert.ok(problems(wrap).some((p) => p.includes('does not wrap around midnight')));
});

test('marketing to someone who has not consented is only the consent request itself', () => {
  // The rule has teeth: it is what lets CU-15 into the catalog at all.
  const cu15 = rows.find((r) => r.segmento.consentimiento === false);
  assert.ok(cu15, 'the catalog no longer has a consent-request campaign');
  const plantilla = porClave.get(cu15.plantilla);
  assert.equal(plantilla.categoria, 'marketing');
  assert.equal(plantilla.evento, EVENTO_CONSENTIMIENTO);

  // Any other marketing template with the same segment is refused.
  const otra = plantillas.find((p) => p.categoria === 'marketing' && p.evento !== EVENTO_CONSENTIMIENTO && p.canal === plantilla.canal);
  const mal = clone(rows);
  mal[0].plantilla = otra.clave;
  mal[0].segmento.variables = {};
  assert.ok(
    problemasConPlantillas(mal, plantillas).some((p) => p.includes(`evento is ${EVENTO_CONSENTIMIENTO}`)),
    'a marketing template that is not a consent request must not be sent to a lead who never consented',
  );
});

test('every template variable has a source: the lead, the chassis or the segment', () => {
  for (const row of rows) {
    const plantilla = porClave.get(row.plantilla);
    const fijas = row.segmento.variables ?? {};
    for (const v of plantilla.variables) {
      const source = VARIABLES_DEL_CHASIS.includes(v) ? 'chassis'
        : VARIABLES_POR_LEAD.includes(v) ? 'lead'
          : (v in fijas) ? 'segmento' : null;
      assert.ok(source, `${row.nombre}: nothing can fill {{${v}}} of ${plantilla.clave}`);
    }
    // And the signed links are never ours to supply.
    for (const v of VARIABLES_DEL_CHASIS) assert.equal(v in fijas, false, `${row.nombre} must not set ${v}`);
  }
  const falta = clone(rows);
  delete falta[1].segmento.variables.municipio;
  assert.ok(problemasConPlantillas(falta, plantillas).some((p) => p.includes('lacks municipio')));
});

test('CU-15 filters on nothing that is empty on the whole cartera', () => {
  // canal_preferido and idioma are empty on all 216 historical leads: a filter
  // on either would match nobody and the campaign would complete as
  // "0 destinatarios" — green, and having done nothing.
  const cu15 = rows.find((r) => r.nombre.startsWith('CU-15'));
  assert.equal('canal_preferido' in cu15.segmento, false);
  assert.equal('idioma' in cu15.segmento, false);
  // The accent is the point: the importer writes 'histórico'.
  assert.deepEqual(cu15.segmento.origen, ['histórico']);
  assert.equal(porClave.get(cu15.plantilla).canal, 'whatsapp');
});

test('a campaign whose template is not approved is reported blocked, not ready', () => {
  // The approval state is a fact about Twilio and Meta, so it is read from the
  // instance rows, not from the catalog.
  const instancia = plantillas.map((p) => ({
    ...p, estado: 'borrador', content_estado: p.canal === 'whatsapp' ? 'unsubmitted' : '',
  }));
  const bloqueos = bloqueadas(rows, instancia);
  const cu15 = bloqueos.find((b) => b.nombre.startsWith('CU-15'));
  assert.ok(cu15, 'a WhatsApp campaign on an unsubmitted template must be blocked');
  assert.equal(cu15.code, 'template_not_approved');
  assert.match(cu15.motivo, /Meta/);

  // Approved, and the same catalog is clear.
  const aprobadas = instancia.map((p) => ({ ...p, content_estado: p.canal === 'whatsapp' ? 'approved' : '' }));
  assert.deepEqual(bloqueadas(rows, aprobadas), []);
});

test('the bodies the seed would send: identity on create, never on update', () => {
  for (const row of rows) {
    const create = createBody(row, 'plant000000000');
    assert.equal(create.nombre, row.nombre);
    assert.equal(create.plantilla, 'plant000000000');
    assert.deepEqual(Object.keys(create).sort(), ['nombre', ...CONTENT_FIELDS].sort());
    assert.deepEqual(missingOnCreate(create), []);
    const update = updateBody(row, 'plant000000000');
    assert.equal('nombre' in update, false, 'renaming through the seed would create a second campaign');
    assert.deepEqual(Object.keys(update).sort(), [...CONTENT_FIELDS].sort());
    // The report is the runner's: a seed must never blank it.
    assert.equal('informe' in update, false);
    assert.equal('ultimo_envio_en' in update, false);
  }
  assert.deepEqual(missingOnCreate({ nombre: '  ' }), REQUIRED_ON_CREATE);
});

test('problems() catches what the tests above assert, one readable line each', () => {
  assert.deepEqual(problems('not an array'), ['catalog: not an array']);
  const roto = clone(rows);
  roto[0].nombre = '';
  roto[0].lote_diario = 0;
  roto[0].intervalo_min = -1;
  roto[0].plantilla = 'NO ES UNA CLAVE';
  roto[0].segmento = { v: 2, ojo: true };
  delete roto[1].nota;
  const out = problems(roto);
  for (const esperado of ['nombre is empty', 'lote_diario', 'intervalo_min', 'plantilla must be', 'segmento: v must be', 'segmento: unknown key ojo', 'missing key nota']) {
    assert.ok(out.some((p) => p.includes(esperado)), `${esperado} not reported in: ${out.join(' | ')}`);
  }
});
