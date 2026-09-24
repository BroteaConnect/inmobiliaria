// weekly-summary.lib.test.mjs — the Friday business summary rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capOrigins, inWeek, isoWeek, textWeeklySummary, weekWindow, weeklySummary } from './weekly-summary.lib.mjs';
import { MAX_MESSAGE_CHARS, PIE_CRM } from './lib.mjs';

// Friday 2026-09-25 18:00 Madrid (CEST) = 16:00Z.
const FRI = new Date('2026-09-25T16:00:00.000Z');
const pb = (iso) => iso.replace('T', ' ');

describe('weekWindow / inWeek', () => {
  const win = weekWindow(FRI);
  it('closes at this Friday 18:00 when run at 18:00', () => {
    assert.equal(win.hasta.toISOString(), '2026-09-25T16:00:00.000Z');
    assert.equal(win.desde.toISOString(), '2026-09-18T16:00:00.000Z');
  });
  it('Fri 17:59 is in, Fri 18:00 is out, last Fri 18:00 is in', () => {
    assert.equal(inWeek('2026-09-25 15:59:00.000Z', win), true);
    assert.equal(inWeek('2026-09-25 16:00:00.000Z', win), false);
    assert.equal(inWeek('2026-09-18 16:00:00.000Z', win), true);
    assert.equal(inWeek('2026-09-18 15:59:59.999Z', win), false);
  });
  it('an empty or broken date is in no week', () => {
    assert.equal(inWeek('', win), false);
    assert.equal(inWeek('nonsense', win), false);
  });
  it('a run late in the evening still reports the week that closed at 18:00', () => {
    assert.equal(weekWindow(new Date('2026-09-25T21:30:00Z')).hasta.toISOString(), '2026-09-25T16:00:00.000Z');
  });
  it('a run before Friday 18:00 reports the previous week', () => {
    assert.equal(weekWindow(new Date('2026-09-25T15:59:00Z')).hasta.toISOString(), '2026-09-18T16:00:00.000Z');
    assert.equal(weekWindow(new Date('2026-09-23T10:00:00Z')).hasta.toISOString(), '2026-09-18T16:00:00.000Z');
  });
  it('the October DST week keeps seven local days (169 h)', () => {
    const w = weekWindow(new Date('2026-10-30T17:00:00Z')); // Fri 30 Oct 18:00 CET
    assert.equal(w.hasta.toISOString(), '2026-10-30T17:00:00.000Z');
    assert.equal(w.desde.toISOString(), '2026-10-23T16:00:00.000Z');
    assert.equal((w.hasta - w.desde) / 3_600_000, 169);
  });
  it('the March DST week keeps seven local days (167 h)', () => {
    const w = weekWindow(new Date('2026-04-03T16:00:00Z')); // Fri 3 Apr 18:00 CEST
    assert.equal(w.desde.toISOString(), '2026-03-27T17:00:00.000Z');
    assert.equal((w.hasta - w.desde) / 3_600_000, 167);
  });
});

describe('isoWeek', () => {
  it('handles the year edges', () => {
    assert.equal(isoWeek('2026-01-01'), '2026-W01');
    assert.equal(isoWeek('2026-12-31'), '2026-W53');
    assert.equal(isoWeek('2027-01-01'), '2026-W53');
    assert.equal(isoWeek('2025-12-29'), '2026-W01');
    assert.equal(isoWeek('2026-09-25'), '2026-W39');
  });
});

describe('weeklySummary', () => {
  const inside = pb('2026-09-22T10:00:00.000Z');
  const outside = pb('2026-09-10T10:00:00.000Z');
  const data = {
    leads: [
      { id: 'l1', created: inside, origen: 'web', etapa: 'nuevo' },
      { id: 'l2', created: inside, origen: 'cartel', etapa: 'contactado' },
      { id: 'l3', created: inside, origen: '', etapa: 'nuevo' },
      { id: 'l4', created: inside, origen: 'histórico', etapa: 'vendido' },
      { id: 'l5', created: outside, origen: 'web', etapa: 'nuevo' },
      { id: 'l6', created: '', origen: 'web', etapa: '' },
      { id: 'l7', created: inside, origen: 'x'.repeat(100), etapa: 'nuevo' },
      { id: 'l8', created: inside, origen: '__proto__', etapa: 'nuevo' },
    ],
    actividades: [
      { lead: 'l1', created: inside, direccion: 'saliente', tipo: 'whatsapp' },
      { lead: 'l1', created: inside, direccion: 'saliente', tipo: 'llamada' },
      { lead: 'l1', created: inside, direccion: 'saliente', tipo: 'nota' },
      { lead: 'l2', created: inside, direccion: 'entrante', tipo: 'whatsapp' },
      { lead: 'l2', created: outside, direccion: 'saliente', tipo: 'email' },
      { lead: 'l2', created: inside, direccion: 'saliente', tipo: 'whatsapp', estado_envio: 'error' },
    ],
    visitas: [
      { created: outside, cuando: inside, resultado: 'realizada' },
      { created: inside, cuando: pb('2026-09-30T10:00:00.000Z'), resultado: 'pendiente' },
      { created: inside, cuando: inside, resultado: 'no_show' },
      { created: inside, cuando: inside, resultado: 'cancelada' },
    ],
    propiedades: [
      { estado: 'publicada', updated: inside },
      { estado: 'publicada', updated: outside },
      { estado: 'borrador', updated: inside },
    ],
    envios: [{ created: inside, estado: 'entregado' }, { created: inside, estado: 'error' }, { created: outside, estado: 'enviado' }],
  };
  const s = weeklySummary(data, FRI);
  it('names the week and its Madrid days', () => {
    assert.equal(s.semana, '2026-W39');
    assert.equal(s.desde, '2026-09-18');
    assert.equal(s.hasta, '2026-09-25');
  });
  it('an import is not a new lead; empty origen is "sin origen"; keys are cut; __proto__ is a bucket', () => {
    assert.equal(s.leads_nuevos, 5);
    assert.equal(s.importados, 1);
    assert.equal(s.por_origen.web, 1);
    assert.equal(s.por_origen.cartel, 1);
    assert.equal(s.por_origen['sin origen'], 1);
    assert.equal(s.por_origen['x'.repeat(40)], 1);
    assert.ok(Object.hasOwn(s.por_origen, '__proto__'));
    assert.equal(Object.getPrototypeOf(s.por_origen), Object.prototype);
  });
  it('notes and failed sends are not contacts', () => {
    assert.equal(s.contactos, 2);
    assert.deepEqual(s.contactos_por_canal, { whatsapp: 1, llamada: 1 });
    assert.equal(s.entrantes, 1);
  });
  it('visits: held by cuando, booked by created, no-shows apart, cancelled never', () => {
    assert.equal(s.visitas, 1);
    assert.equal(s.visitas_agendadas, 2);
    assert.equal(s.visitas_no_show, 1);
  });
  it('publications, sends, funnel', () => {
    assert.equal(s.publicadas, 1);
    assert.deepEqual(s.envios, { total: 2, por_estado: { entregado: 1, error: 1 } });
    assert.deepEqual(Object.keys(s.embudo), ['nuevo', 'contactado', 'vendido', 'sin etapa']);
    assert.equal(s.embudo.nuevo, 5);
  });
  it('an unreadable ledger is null, not zero', () => {
    assert.equal(weeklySummary({ ...data, envios: null }, FRI).envios, null);
  });
  it('counts who is waiting for an answer now', () => {
    const acts = [{ id: 'a1', lead: 'l9', tipo: 'email', direccion: 'entrante', created: pb('2026-09-25T12:00:00.000Z') }];
    assert.equal(weeklySummary({ actividades: acts }, FRI).sin_respuesta, 1);
    assert.equal(weeklySummary({ actividades: acts }, FRI, { excludeLeadIds: ['l9'] }).sin_respuesta, 0);
  });
});

describe('capOrigins', () => {
  it('keeps the top 6 and sums the rest into "otros"', () => {
    assert.deepEqual(capOrigins({ a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, g: 3, otros: 2, h: 1 }),
      { a: 9, b: 8, c: 7, d: 6, e: 5, f: 4, otros: 6 });
    assert.deepEqual(capOrigins({ a: 1, b: 1 }), { a: 1, b: 1 });
  });
  it('the payload is capped too', () => {
    const leads = Array.from({ length: 20 }, (_, i) => ({ created: pb('2026-09-22T10:00:00.000Z'), origen: `o${i}` }));
    const s = weeklySummary({ leads }, FRI);
    assert.equal(Object.keys(s.por_origen).length, 7);
    assert.equal(s.por_origen.otros, 14);
    assert.equal(s.leads_nuevos, 20);
  });
});

describe('textWeeklySummary', () => {
  it('never exceeds the Telegram limit', () => {
    const s = weeklySummary({}, FRI);
    const t = textWeeklySummary({ ...s, embudo: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`etapa-${'x'.repeat(30)}-${i}`, i])) });
    assert.ok(t.length <= MAX_MESSAGE_CHARS);
    assert.match(t, /^📊/);
  });
  it('says a quiet week instead of staying silent', () => {
    const t = textWeeklySummary(weeklySummary({}, FRI));
    assert.match(t, /^📊 <b>Resumen de la semana<\/b> — semana 39 · /);
    assert.match(t, /Semana sin movimiento: ni leads nuevos, ni contactos, ni visitas\./);
    assert.ok(t.endsWith(PIE_CRM));
  });
  it('lists the counts and escapes user-made keys', () => {
    const t = textWeeklySummary(weeklySummary({
      leads: [{ created: pb('2026-09-22T10:00:00.000Z'), origen: '<i>feria</i>', etapa: 'nuevo' }],
    }, FRI));
    assert.match(t, /• Leads nuevos: <b>1<\/b> \(1 &lt;i&gt;feria&lt;\/i&gt;\)/);
    assert.match(t, /Embudo hoy: nuevo 1/);
    assert.doesNotMatch(t, /Semana sin movimiento/);
  });
});
