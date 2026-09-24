// owner-report.lib.test.mjs — the monthly owner report draft rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MESSAGE, inMonth, ownerReports, reportDue, textOwnerReports } from './owner-report.lib.mjs';

// 10:00 Madrid on a given day (CEST in these months: 08:00Z).
const at = (ymd) => new Date(`${ymd}T08:00:00Z`);

describe('reportDue', () => {
  it('Thursday 1 October is due for September', () => {
    assert.deepEqual(reportDue(at('2026-10-01'), null), { due: true, month: '2026-09', why: 'first weekday run for 2026-09' });
  });
  it('Saturday 1 and Sunday 2 August are not; Monday 3 August is', () => {
    assert.equal(reportDue(at('2026-08-01'), null).due, false);
    assert.equal(reportDue(at('2026-08-02'), null).due, false);
    assert.deepEqual(reportDue(at('2026-08-03'), null).due, true);
    assert.equal(reportDue(at('2026-08-03'), null).month, '2026-07');
  });
  it('the 7th is the last day; the 8th is not due', () => {
    assert.equal(reportDue(at('2026-10-07'), null).due, true);
    assert.equal(reportDue(at('2026-10-08'), null).due, false);
  });
  it('a marker equal to the month stops it', () => {
    const v = reportDue(at('2026-10-02'), '2026-09');
    assert.equal(v.due, false);
    assert.match(v.why, /already drafted/);
    assert.equal(reportDue(at('2026-10-02'), '2026-08').due, true);
  });
  it('January reports the previous December', () => {
    const v = reportDue(new Date('2027-01-04T09:00:00Z'), null); // Monday 4 Jan 10:00 CET
    assert.deepEqual([v.due, v.month], [true, '2026-12']);
  });
  it('the day is the Madrid day: 22:30Z on 30 Sep is already 1 Oct', () => {
    assert.equal(reportDue(new Date('2026-09-30T22:30:00Z'), null).month, '2026-09');
  });
});

describe('inMonth', () => {
  it('uses the Madrid month', () => {
    assert.equal(inMonth('2026-09-30 22:30:00.000Z', '2026-10'), true);
    assert.equal(inMonth('2026-09-30 21:59:00.000Z', '2026-09'), true);
    assert.equal(inMonth('', '2026-09'), false);
  });
});

describe('ownerReports', () => {
  const owner = { id: 'o1', nombre: 'Carmen Ruiz Díaz', telefono: '+34600000000', consentimiento: true };
  const p1 = { id: 'p1', titulo: 'Piso '.repeat(20), estado: 'publicada', expand: { propietario: owner } };
  const p2 = { id: 'p2', titulo: 'Ático', estado: 'publicada', expand: { propietario: { id: 'o2', nombre: '', telefono: '', consentimiento: false } } };
  const p3 = { id: 'p3', titulo: 'Sin dueño', estado: 'publicada' };
  const p4 = { id: 'p4', titulo: 'Borrador', estado: 'borrador', expand: { propietario: owner } };
  const sep = '2026-09-15 10:00:00.000Z';
  const aug = '2026-08-15 10:00:00.000Z';
  const data = {
    properties: [p1, p2, p3, p4],
    leads: [
      { id: 'l1', propiedad: 'p1', created: sep, origen: 'web' },
      { id: 'l2', propiedad: 'p1', created: sep, origen: 'histórico' },
      { id: 'l3', propiedad: 'p1', created: aug, origen: 'web' },
      { id: 'l4', propiedad: 'p2', created: sep, origen: 'cartel' },
    ],
    visitas: [
      { propiedad: 'p1', cuando: sep, resultado: 'realizada' },
      { propiedad: 'p1', cuando: sep, resultado: 'no_show' },
      { propiedad: 'p1', cuando: sep, resultado: 'cancelada' },
      { propiedad: 'p1', cuando: aug, resultado: 'realizada' },
    ],
    actividades: [
      { lead: 'l1', created: sep }, { lead: 'l3', created: sep }, { lead: 'l1', created: aug }, { lead: 'l4', created: sep },
    ],
  };
  const drafts = ownerReports(data, '2026-09', { agent: 'Marta' });
  it('one draft per published property with an owner', () => {
    assert.deepEqual(drafts.map((d) => d.propiedad_id), ['p1', 'p2']);
  });
  it('counts the month only, imports excluded', () => {
    const [d] = drafts;
    assert.equal(d.contactos, 1);
    assert.equal(d.visitas, 1);
    assert.equal(d.visitas_agendadas, 2);
    assert.equal(d.visitas_no_show, 1);
    assert.equal(d.actividad, 2);
  });
  it('first name, cut title, Spanish month, agent', () => {
    const [d] = drafts;
    assert.equal(d.nombre, 'Carmen');
    assert.equal(d.propiedad.length, 60);
    assert.equal(d.mes, 'septiembre');
    assert.equal(d.agente, 'Marta');
    assert.equal(ownerReports(data, '2026-09').at(0).agente, 'el equipo');
  });
  it('flags what could not be sent', () => {
    assert.deepEqual(drafts[0].no_enviable, []);
    assert.deepEqual(drafts[1].no_enviable, ['sin teléfono', 'sin consentimiento']);
    assert.equal(drafts[1].nombre, 'propietario');
  });
});

describe('textOwnerReports', () => {
  const draft = (i, over = {}) => ({
    propietario_id: `o${i}`, propiedad_id: `p${i}`, nombre: 'Carmen', propiedad: `Piso <${i}>`, mes: 'septiembre',
    agente: 'Marta', contactos: 2, visitas: 1, visitas_agendadas: 2, visitas_no_show: 1, actividad: 3, no_enviable: [], ...over,
  });
  const template = { cuerpo_es: 'Hola {{nombre}}, resumen de {{mes}} de {{propiedad}}: {{visitas}} visitas y {{contactos}} contactos. {{agente}}' };
  it('is empty without drafts', () => {
    assert.deepEqual(textOwnerReports([], template, 'septiembre'), []);
  });
  it('renders the template, escaped, with header and footer', () => {
    const [t] = textOwnerReports([draft(1, { no_enviable: ['sin teléfono'] })], template, 'septiembre');
    assert.match(t, /^📨 <b>Informes a propietarios<\/b> — septiembre · 1 borrador para revisar/);
    assert.match(t, /<i>Hola Carmen, resumen de septiembre de Piso &lt;1&gt;: 1 visitas y 2 contactos\. Marta<\/i>/);
    assert.match(t, /⚠️ no enviable: sin teléfono/);
    assert.ok(t.endsWith('Nada se ha enviado: falta la aprobación de Meta de la plantilla propietario.informe.'));
  });
  it('a missing template shows the variables instead of throwing', () => {
    const [t] = textOwnerReports([draft(1)], null, 'septiembre');
    assert.match(t, /no hay plantilla propietario\.informe/);
    assert.match(t, /nombre=Carmen · mes=septiembre/);
  });
  it('splits under the limit, never inside a draft', () => {
    const drafts = Array.from({ length: 40 }, (_, i) => draft(i, { propiedad: `Piso ${i} ${'x'.repeat(50)}` }));
    const chunks = textOwnerReports(drafts, template, 'septiembre');
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= MAX_MESSAGE, `chunk of ${c.length}`);
    assert.equal(chunks.join('\n').match(/🏠/g).length, 40);
    for (const c of chunks) assert.equal(c.match(/🏠/g)?.length ?? 0, c.match(/<i>/g)?.length ?? 0);
    assert.match(chunks[0], /^📨/);
    assert.match(chunks.at(-1), /Nada se ha enviado/);
  });
  it('an oversized template body is not shown whole', () => {
    const [t] = textOwnerReports([draft(1)], { cuerpo_es: 'x'.repeat(5000) }, 'septiembre');
    assert.ok(t.length <= MAX_MESSAGE);
    assert.match(t, /demasiado largo/);
  });
});
