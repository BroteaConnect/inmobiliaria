// lib.test.mjs — unit tests for the pure job logic. Run: node --test jobs/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  desatendidos, textoAgenda, resumenDelDia, textoResumen, haceCuanto,
  diaMadrid, MAX_LINES, MAX_NOMBRE, ORIGEN_IMPORTADO,
} from './lib.mjs';

// Fixed "now": 2026-07-30 09:00 Europe/Madrid (CEST, UTC+2) = 07:00Z.
const NOW = new Date('2026-07-30T07:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
// PocketBase-style date string ("YYYY-MM-DD HH:MM:SS.sssZ").
const pbDate = (iso) => iso.replace('T', ' ');

let seq = 0;
const lead = (over = {}) => ({
  id: `l${++seq}`, nombre: `Lead ${seq}`, etapa: 'nuevo',
  created: hoursAgo(1), ultimo_contacto: '', ...over,
});

describe('desatendidos', () => {
  it('applies the 48h boundary: 47h is fresh, 49h is stale', () => {
    const fresh = lead({ ultimo_contacto: hoursAgo(47) });
    const stale = lead({ ultimo_contacto: hoursAgo(49) });
    const out = desatendidos([fresh, stale], NOW);
    assert.deepEqual(out.map((l) => l.id), [stale.id]);
  });

  it('falls back to created when ultimo_contacto is empty', () => {
    const untouched = lead({ created: hoursAgo(72), ultimo_contacto: '' });
    const out = desatendidos([untouched], NOW);
    assert.deepEqual(out.map((l) => l.id), [untouched.id]);
  });

  it('prefers ultimo_contacto over an old created', () => {
    const contacted = lead({ created: hoursAgo(200), ultimo_contacto: hoursAgo(3) });
    assert.equal(desatendidos([contacted], NOW).length, 0);
  });

  it('excludes nutriendo and vendido no matter how old', () => {
    const parked = lead({ etapa: 'nutriendo', created: hoursAgo(500) });
    const won = lead({ etapa: 'vendido', created: hoursAgo(500) });
    const open = lead({ etapa: 'contactado', ultimo_contacto: hoursAgo(60) });
    const out = desatendidos([parked, won, open], NOW);
    assert.deepEqual(out.map((l) => l.id), [open.id]);
  });

  it('sorts oldest-wait-first', () => {
    const a = lead({ ultimo_contacto: hoursAgo(60) });
    const b = lead({ ultimo_contacto: hoursAgo(200) });
    const c = lead({ ultimo_contacto: hoursAgo(100) });
    const out = desatendidos([a, b, c], NOW);
    assert.deepEqual(out.map((l) => l.id), [b.id, c.id, a.id]);
  });

  it('parses PocketBase-style dates (space instead of T)', () => {
    const stale = lead({ ultimo_contacto: pbDate(hoursAgo(49)) });
    assert.equal(desatendidos([stale], NOW).length, 1);
  });
});

describe('textoAgenda', () => {
  it('returns null when there is nothing to say', () => {
    assert.equal(textoAgenda([], NOW), null);
  });

  it('caps at 10 lines and adds the "y N más" tail', () => {
    const stale = Array.from({ length: 13 }, (_, i) =>
      lead({ ultimo_contacto: hoursAgo(50 + i) }));
    const txt = textoAgenda(desatendidos(stale, NOW), NOW);
    assert.equal((txt.match(/^• /gm) || []).length, MAX_LINES);
    assert.match(txt, /… y 3 más/);
  });

  it('escalates with ⚠️ only past 5 days waiting', () => {
    const urgent = lead({ nombre: 'Ana', ultimo_contacto: hoursAgo(6 * 24) });
    const normal = lead({ nombre: 'Bea', ultimo_contacto: hoursAgo(3 * 24) });
    const txt = textoAgenda(desatendidos([urgent, normal], NOW), NOW);
    assert.match(txt, /⚠️ <b>Ana<\/b>/);
    assert.doesNotMatch(txt, /⚠️ <b>Bea<\/b>/);
  });

  it('truncates unbounded names before escaping (public form input)', () => {
    const l = lead({ nombre: '&'.repeat(500), ultimo_contacto: hoursAgo(72) });
    const txt = textoAgenda(desatendidos([l], NOW), NOW);
    assert.match(txt, new RegExp(`<b>${'&amp;'.repeat(MAX_NOMBRE)}</b>`));
  });

  it('shows name, stage and days waiting, HTML-escaped', () => {
    const l = lead({ nombre: 'P&J <SL>', etapa: 'visita', ultimo_contacto: hoursAgo(72) });
    const txt = textoAgenda(desatendidos([l], NOW), NOW);
    assert.match(txt, /<b>P&amp;J &lt;SL&gt;<\/b> — visita · hace 3 días/);
  });
});

describe('haceCuanto', () => {
  it('speaks hours below one day and days after', () => {
    assert.equal(haceCuanto(hoursAgo(0.5), NOW), 'hace menos de una hora');
    assert.equal(haceCuanto(hoursAgo(1), NOW), 'hace 1 hora');
    assert.equal(haceCuanto(hoursAgo(5), NOW), 'hace 5 horas');
    assert.equal(haceCuanto(hoursAgo(24), NOW), 'hace 1 día');
    assert.equal(haceCuanto(hoursAgo(72), NOW), 'hace 3 días');
  });
});

describe('diaMadrid / resumenDelDia', () => {
  it('uses the Madrid-local day, not the UTC day', () => {
    // 22:30Z on the 29th is already 00:30 on the 30th in Madrid (CEST).
    assert.equal(diaMadrid('2026-07-29 22:30:00.000Z'), '2026-07-30');
  });

  it('counts new leads, contacts by channel, deliveries and publications', () => {
    const r = resumenDelDia({
      leads: [
        lead({ created: pbDate('2026-07-29T22:30:00.000Z') }), // Madrid: today
        lead({ created: '2026-07-29 12:00:00.000Z' }), // yesterday
      ],
      actividades: [
        { tipo: 'llamada', direccion: 'saliente', created: hoursAgo(2) },
        { tipo: 'llamada', direccion: 'saliente', created: hoursAgo(3) },
        { tipo: 'whatsapp', direccion: 'saliente', created: hoursAgo(1) },
        { tipo: 'nota', direccion: 'saliente', created: hoursAgo(1) }, // not a contact
        { tipo: 'whatsapp', direccion: 'entrante', created: hoursAgo(1) },
        { tipo: 'email', direccion: 'saliente', estado_envio: 'entregado', created: hoursAgo(4) },
        { tipo: 'email', direccion: 'saliente', estado_envio: 'enviado', created: hoursAgo(4) },
        { tipo: 'email', direccion: 'saliente', estado_envio: 'abierto', created: '2026-07-28 10:00:00.000Z' }, // not today
      ],
      propiedades: [
        { estado: 'publicada', updated: hoursAgo(5) },
        { estado: 'publicada', updated: '2026-07-20 10:00:00.000Z' }, // old
        { estado: 'borrador', updated: hoursAgo(5) },
      ],
    }, NOW);
    assert.equal(r.nuevos, 1);
    assert.equal(r.importados, 0);
    // spread: contactos is a null-prototype object, deepEqual is strict
    assert.deepEqual({ ...r.contactos }, { llamada: 2, whatsapp: 1, email: 2 });
    assert.equal(r.entrantes, 1);
    assert.equal(r.emailsEntregados, 1);
    assert.equal(r.publicadas, 1);
    assert.equal(r.vacio, false);
  });

  it('flags an empty day', () => {
    const r = resumenDelDia({ leads: [], actividades: [], propiedades: [] }, NOW);
    assert.equal(r.vacio, true);
  });
});

// Regression: records written before pb/schema.json declared the autodate
// fields keep created/updated = "" for ever. Real data had them (4 leads,
// 2 actividades, 14 propiedades on 2026-07-30) and they used to make the
// digest throw "Invalid time value" and the agenda drop the lead silently.
describe('fechas vacías (registros previos a los autodate)', () => {
  it('treats an unparseable date as unknown, not as a crash', () => {
    assert.equal(diaMadrid(''), null);
    assert.equal(haceCuanto('', NOW), 'sin fecha registrada');
  });

  it('puts a lead with no usable date first in the agenda, never hides it', () => {
    const sinFecha = lead({ nombre: 'Jorge y Ana', created: '', ultimo_contacto: '' });
    const viejo = lead({ nombre: 'Otro', ultimo_contacto: hoursAgo(100) });
    const out = desatendidos([viejo, sinFecha], NOW);
    assert.deepEqual(out.map((l) => l.nombre), ['Jorge y Ana', 'Otro']);
  });

  it('marks it urgent and says so instead of inventing a wait', () => {
    const sinFecha = lead({ nombre: 'Isabel', created: '', ultimo_contacto: '' });
    const txt = textoAgenda(desatendidos([sinFecha], NOW), NOW);
    assert.match(txt, /⚠️ <b>Isabel<\/b> — nuevo · sin fecha registrada/);
  });

  it('counts dateless records as "not today" and still builds the digest', () => {
    const r = resumenDelDia({
      leads: [lead({ created: '' }), lead({ created: hoursAgo(2) })],
      actividades: [{ tipo: 'llamada', direccion: 'saliente', created: '' }],
      propiedades: [{ estado: 'publicada', updated: '', created: '' }],
    }, NOW);
    assert.equal(r.nuevos, 1);
    assert.deepEqual({ ...r.contactos }, {});
    assert.equal(r.publicadas, 0);
    assert.match(textoResumen(r, NOW), /Leads nuevos: <b>1<\/b>/);
  });
});

// A CSV import is bookkeeping, not lead generation: the day the real Excel
// landed the digest would have claimed "220 leads nuevos" (216 of them
// imported rows). The counters keep them apart.
describe('leads importados', () => {
  it('separates imported rows from real new leads', () => {
    const r = resumenDelDia({
      leads: [
        lead({ created: hoursAgo(2), origen: 'web' }),
        lead({ created: hoursAgo(1), origen: ORIGEN_IMPORTADO }),
        lead({ created: hoursAgo(1), origen: ORIGEN_IMPORTADO }),
        lead({ created: '2026-07-20 10:00:00.000Z', origen: ORIGEN_IMPORTADO }), // not today
      ],
      actividades: [], propiedades: [],
    }, NOW);
    assert.equal(r.nuevos, 1);
    assert.equal(r.importados, 2);
    const txt = textoResumen(r, NOW);
    assert.match(txt, /Leads nuevos: <b>1<\/b>/);
    assert.match(txt, /Importados a la cartera: 2/);
  });

  it('an import-only day is still worth reporting', () => {
    const r = resumenDelDia({
      leads: [lead({ created: hoursAgo(1), origen: ORIGEN_IMPORTADO })],
      actividades: [], propiedades: [],
    }, NOW);
    assert.equal(r.vacio, false);
    assert.doesNotMatch(textoResumen(r, NOW), /Leads nuevos/);
  });
});

describe('textoResumen', () => {
  it('returns null on an empty day — silence is a feature', () => {
    const r = resumenDelDia({ leads: [], actividades: [], propiedades: [] }, NOW);
    assert.equal(textoResumen(r, NOW), null);
  });

  it('lists only the non-zero counters', () => {
    const r = resumenDelDia({
      leads: [lead({ created: hoursAgo(2) })],
      actividades: [],
      propiedades: [],
    }, NOW);
    const txt = textoResumen(r, NOW);
    assert.match(txt, /Resumen del día/);
    assert.match(txt, /Leads nuevos: <b>1<\/b>/);
    assert.doesNotMatch(txt, /entrantes|entregados|publicadas|salientes/);
  });
});
