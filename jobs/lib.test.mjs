// lib.test.mjs — unit tests for the pure job logic. Run: node --test jobs/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  desatendidos, textoAgenda, resumenDelDia, textoResumen, haceCuanto,
  diaMadrid, visitasDeHoy, textoVisitas, MAX_LINES, MAX_NOMBRE, ORIGEN_IMPORTADO,
  normalizarTexto, vocabularioMunicipios, extraerPrecioMax, extraerHabitaciones,
  normalizarCriterios, normalizarLeads, candidatos, esReciente, textoShortlist, PIE_CRM,
  JUNK_ZONA, esZonaValida, zonasDePropiedad, vocabularioZonas, PESO_ZONA_TEXTO, PESO_ZONA_PISTA,
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

// The 09:00 agenda lists today's visits. "Today" is the Madrid-local day:
// a visit stored at 22:30Z is already tomorrow's 00:30 for the agent.
const visita = (over = {}) => ({
  id: `v${++seq}`, cuando: '2026-07-30 08:00:00.000Z', resultado: 'pendiente',
  expand: {
    lead: { nombre: `Lead ${seq}` },
    propiedad: { titulo: `Piso ${seq}` },
    agente: { name: `Agente ${seq}` },
  },
  ...over,
});

describe('visitasDeHoy', () => {
  it('keeps a 22:30Z visit of yesterday: it is 00:30 today in Madrid (CEST)', () => {
    const v = visita({ cuando: '2026-07-29 22:30:00.000Z' });
    assert.deepEqual(visitasDeHoy([v], NOW).map((x) => x.id), [v.id]);
  });

  it('drops a 23:30Z visit of today: it is 01:30 tomorrow in Madrid', () => {
    const v = visita({ cuando: '2026-07-30 23:30:00.000Z' });
    assert.deepEqual(visitasDeHoy([v], NOW), []);
  });

  it('follows the clock change in October (CEST → CET on 2026-10-25)', () => {
    const now = new Date('2026-10-25T08:00:00.000Z'); // 09:00 CET, after the switch
    const madrugada = visita({ cuando: '2026-10-24 22:30:00.000Z' }); // 00:30 CEST, today
    const noche = visita({ cuando: '2026-10-25 22:30:00.000Z' }); // 23:30 CET, today
    const manana = visita({ cuando: '2026-10-25 23:30:00.000Z' }); // 00:30 CET, tomorrow
    const out = visitasDeHoy([manana, noche, madrugada], now);
    assert.deepEqual(out.map((x) => x.id), [madrugada.id, noche.id]);
  });

  it('follows the clock change in March (CET → CEST on 2026-03-29)', () => {
    const now = new Date('2026-03-29T07:00:00.000Z'); // 09:00 CEST, after the switch
    const madrugada = visita({ cuando: '2026-03-28 23:30:00.000Z' }); // 00:30 CET, today
    const manana = visita({ cuando: '2026-03-29 22:30:00.000Z' }); // 00:30 CEST, tomorrow
    const out = visitasDeHoy([manana, madrugada], now);
    assert.deepEqual(out.map((x) => x.id), [madrugada.id]);
  });

  it('excludes cancelled visits, keeps every other outcome', () => {
    const cancelada = visita({ resultado: 'cancelada' });
    const confirmada = visita({ resultado: 'confirmada' });
    const sinResultado = visita({ resultado: '' });
    const out = visitasDeHoy([cancelada, confirmada, sinResultado], NOW);
    assert.deepEqual(out.map((x) => x.id), [confirmada.id, sinResultado.id]);
  });

  it('sorts by cuando ascending, whatever order PocketBase returned', () => {
    const tarde = visita({ cuando: '2026-07-30 16:00:00.000Z' });
    const manana = visita({ cuando: '2026-07-30 07:30:00.000Z' });
    const mediodia = visita({ cuando: '2026-07-30 11:00:00.000Z' });
    const out = visitasDeHoy([tarde, manana, mediodia], NOW);
    assert.deepEqual(out.map((x) => x.id), [manana.id, mediodia.id, tarde.id]);
  });

  it('returns an empty list for zero visits or an unusable date', () => {
    assert.deepEqual(visitasDeHoy([], NOW), []);
    assert.deepEqual(visitasDeHoy([visita({ cuando: '' })], NOW), []);
  });
});

describe('textoVisitas', () => {
  it('returns null when there are no visits', () => {
    assert.equal(textoVisitas([], NOW), null);
  });

  it('prints HH:MM in Madrid time, the lead in bold, then property and agent', () => {
    const v = visita({
      cuando: '2026-07-30 08:05:00.000Z', // 10:05 CEST
      expand: { lead: { nombre: 'Ana' }, propiedad: { titulo: 'Ático en Ruzafa' }, agente: { name: 'Luis' } },
    });
    const txt = textoVisitas(visitasDeHoy([v], NOW), NOW);
    assert.match(txt, /Visitas de hoy/);
    assert.match(txt, /^• 10:05 · <b>Ana<\/b> · Ático en Ruzafa · Luis$/m);
  });

  it('shows midnight as 00:MM, not 24:MM', () => {
    const v = visita({ cuando: '2026-07-29 22:10:00.000Z' }); // 00:10 CEST
    assert.match(textoVisitas([v], NOW), /• 00:10 · /);
  });

  it('escapes lead, property and agent names (HTML mode)', () => {
    const v = visita({
      expand: { lead: { nombre: 'P&J <SL>' }, propiedad: { titulo: 'Piso <2>' }, agente: { name: 'A & B' } },
    });
    assert.match(textoVisitas([v], NOW), /<b>P&amp;J &lt;SL&gt;<\/b> · Piso &lt;2&gt; · A &amp; B/);
  });

  it('truncates an unbounded lead name before escaping', () => {
    const v = visita({ expand: { lead: { nombre: '&'.repeat(500) } } });
    assert.match(textoVisitas([v], NOW), new RegExp(`<b>${'&amp;'.repeat(MAX_NOMBRE)}</b> · `));
  });

  it('truncates property title and agent name too (titulo has no max)', () => {
    const v = visita({
      expand: { lead: { nombre: 'Ana' }, propiedad: { titulo: '<'.repeat(500) }, agente: { name: '>'.repeat(500) } },
    });
    const txt = textoVisitas([v], NOW);
    assert.match(txt, new RegExp(`<b>Ana</b> · ${'&lt;'.repeat(MAX_NOMBRE)} · ${'&gt;'.repeat(MAX_NOMBRE)}$`, 'm'));
    assert.ok(txt.length < 4096);
  });

  it('degrades a missing relation to a placeholder, never to "undefined"', () => {
    const sinExpand = visita({ expand: undefined });
    const parcial = visita({ expand: { lead: { nombre: 'Bea' } } });
    const txt = textoVisitas([sinExpand, parcial], NOW);
    assert.match(txt, /<b>lead sin nombre<\/b> · sin propiedad · sin agente/);
    assert.match(txt, /<b>Bea<\/b> · sin propiedad · sin agente/);
    assert.doesNotMatch(txt, /undefined/);
  });

  it('caps at MAX_LINES and adds the "y N más" tail', () => {
    const vs = Array.from({ length: 13 }, () => visita());
    const txt = textoVisitas(vs, NOW);
    assert.equal((txt.match(/^• /gm) || []).length, MAX_LINES);
    assert.match(txt, /… y 3 más/);
  });
});

// ---------------------------------------------------------------------------
// Matcher

// Every property the agency has ever listed, published or not: the vocabulary
// comes from all of them.
const PROPIEDADES = [
  { id: 'p1', titulo: 'Piso en Chamberí', municipio: 'Chamberí', precio: 620000, habitaciones: 3, estado: 'publicada' },
  { id: 'p2', titulo: 'Chalet en Las Rozas', municipio: 'Las Rozas', precio: 545000, habitaciones: 4, estado: 'publicada' },
  { id: 'p3', titulo: 'Apartamento en JLT', municipio: 'Jumeirah Lakes Towers', precio: 0, habitaciones: 0, estado: 'borrador' },
  { id: 'p4', titulo: 'Loft', municipio: 'Madrid', precio: 289000, habitaciones: 2, estado: 'publicada' },
];
const MUNICIPIOS = vocabularioMunicipios(PROPIEDADES);
const norm = (over) => normalizarCriterios(lead(over), MUNICIPIOS);

describe('normalizarTexto', () => {
  it('lowercases, strips accents and collapses spaces', () => {
    assert.equal(normalizarTexto('  Chamberí   JUMEIRAH\tLakes '), 'chamberi jumeirah lakes');
    assert.equal(normalizarTexto(null), '');
  });

  it('builds the town vocabulary from every property, published or not', () => {
    assert.deepEqual(MUNICIPIOS, ['chamberi', 'las rozas', 'jumeirah lakes towers', 'madrid']);
    assert.deepEqual(vocabularioMunicipios([{ municipio: '' }, { municipio: 'Getafe' }, { municipio: 'getafe ' }]), ['getafe']);
  });
});

describe('normalizarCriterios', () => {
  it('reads the historical import shape: master project as zona, ~precio, no rooms', () => {
    const n = norm({
      criterios: 'Compró en Jumeirah Lakes Towers · Seven City · unidad 1413 · ~1200000 · Procedimiento: compra · Fecha: 29/12/2022 · País: España',
    });
    assert.deepEqual(n.zona, ['jumeirah lakes towers']);
    assert.deepEqual(n.zona_texto, ['jumeirah lakes towers']);
    assert.equal(n.precio_max, 1200000);
    assert.equal(n.habitaciones, null);
  });

  it('reads a web lead: budget and rooms from the message, zona from the linked property', () => {
    const n = norm({
      mensaje: 'Buscamos chalet con jardín, presupuesto 550k, 4 habitaciones',
      expand: { propiedad: PROPIEDADES[1] },
    });
    assert.deepEqual(n.zona, ['las rozas']);
    assert.deepEqual(n.zona_texto, []); // the town came from the hint, not the text
    assert.equal(n.precio_max, 550000);
    assert.equal(n.habitaciones, 4);
  });

  it('ignores accents and case: "chamberi" finds Chamberí, and the hint is not repeated', () => {
    assert.deepEqual(norm({ mensaje: 'Busco piso en CHAMBERI' }).zona, ['chamberi']);
    assert.deepEqual(norm({ criterios: 'Zona: chamberí' }).zona, ['chamberi']);
    const n = norm({ mensaje: 'algo en Chamberí', expand: { propiedad: PROPIEDADES[0] } });
    assert.deepEqual(n.zona, ['chamberi']);
    assert.deepEqual(n.zona_texto, ['chamberi']);
  });

  it('matches multi-word towns whole, never a fragment or a longer word', () => {
    assert.deepEqual(norm({ mensaje: 'un estudio en jumeirah lakes towers' }).zona, ['jumeirah lakes towers']);
    assert.deepEqual(norm({ mensaje: 'un estudio en lakes towers' }).zona, []);
    assert.deepEqual(norm({ mensaje: 'algo en Madridejos' }).zona, []);
    assert.deepEqual(norm({ mensaje: 'Madrid, o Las Rozas.' }).zona, ['las rozas', 'madrid']);
  });

  it('prefers the longest town: "las rozas de madrid" is Las Rozas, not Madrid too', () => {
    assert.deepEqual(norm({ mensaje: 'chalet en Las Rozas de Madrid' }).zona, ['las rozas']);
    assert.deepEqual(norm({ mensaje: 'Las Rozas de Madrid, o en Madrid centro' }).zona, ['las rozas', 'madrid']);
  });

  it('yields null zona/price/rooms for an empty lead', () => {
    assert.deepEqual(norm({ criterios: '', mensaje: '' }), { zona: [], zona_texto: [], precio_max: null, habitaciones: null });
  });
});

describe('extraerPrecioMax / extraerHabitaciones', () => {
  it('reads every amount format the forms produce', () => {
    assert.equal(extraerPrecioMax('~1200000'), 1200000);
    assert.equal(extraerPrecioMax('550k'), 550000);
    assert.equal(extraerPrecioMax('unos 1.2m'), 1200000);
    assert.equal(extraerPrecioMax('1,200,000'), 1200000);
    assert.equal(extraerPrecioMax('hasta 300.000'), 300000);
    assert.equal(extraerPrecioMax('presupuesto 550k'), 550000);
    assert.equal(extraerPrecioMax('€ 450.000 como maximo'), 450000);
    assert.equal(extraerPrecioMax('1,5 millones'), 1500000);
    assert.equal(extraerPrecioMax('maximo 300000'), 300000);
  });

  it('takes the FIRST amount', () => {
    assert.equal(extraerPrecioMax('entre 300k y 400k'), 300000);
  });

  it('does not mistake a flat number, a date, a surface or a room count for money', () => {
    assert.equal(extraerPrecioMax('unidad 1413 · Fecha: 29/12/2022'), null);
    assert.equal(extraerPrecioMax('hasta 4 habitaciones y 120 m2'), null);
    assert.equal(extraerPrecioMax('120m² con terraza'), null);
    assert.equal(extraerPrecioMax(''), null);
  });

  it('rejects what is not a purchase budget: years, phones, lengths, rents, out-of-band amounts', () => {
    assert.equal(extraerPrecioMax('hasta 2024'), null);
    assert.equal(extraerPrecioMax('tel 600.123.456'), null);
    assert.equal(extraerPrecioMax('120 m'), null);
    assert.equal(extraerPrecioMax('3 m de fachada'), null);
    assert.equal(extraerPrecioMax('12.000 €/mes'), null);
    assert.equal(extraerPrecioMax('12.000 € al mes'), null);
    assert.equal(extraerPrecioMax('hasta 9.999'), null);
    assert.equal(extraerPrecioMax('~150000000'), null);
    // …and the next plausible amount still wins
    assert.equal(extraerPrecioMax('12.000 €/mes o hasta 300.000 de compra'), 300000);
  });

  it('returns fast on a pathological digit run (no quadratic backtracking)', () => {
    const t0 = performance.now();
    assert.equal(extraerPrecioMax('9'.repeat(50_000)), null);
    assert.equal(extraerPrecioMax(`hasta ${'1'.repeat(50_000)}`), null);
    assert.ok(performance.now() - t0 < 100, `took ${Math.round(performance.now() - t0)} ms`);
  });

  it('reads rooms in Spanish and English, null when absent', () => {
    assert.equal(extraerHabitaciones('4 habitaciones'), 4);
    assert.equal(extraerHabitaciones('3hab'), 3);
    assert.equal(extraerHabitaciones('2 dormitorios'), 2);
    assert.equal(extraerHabitaciones('2 bedrooms'), 2);
    assert.equal(extraerHabitaciones('3br'), 3);
    assert.equal(extraerHabitaciones('sin datos'), null);
  });
});

describe('candidatos', () => {
  const chamberi = PROPIEDADES[0]; // 620000 · 3 hab
  const cands = (leads, prop = chamberi) => candidatos(prop, normalizarLeads(leads, MUNICIPIOS));

  it('requires the town: price and rooms alone never make a candidate', () => {
    const rico = lead({ mensaje: 'presupuesto 900k, 2 habitaciones' });
    assert.deepEqual(cands([rico]), []);
  });

  it('scores a town written in the text over a town inferred from the linked listing', () => {
    const escrito = lead({ mensaje: 'piso en Chamberí' });
    const pista = lead({ mensaje: 'me interesa', expand: { propiedad: chamberi } });
    const out = cands([pista, escrito]);
    assert.deepEqual(out.map((c) => [c.lead.id, c.score]), [[escrito.id, 5], [pista.id, 4]]);
    assert.match(out[1].motivos[0], /por la propiedad que consultó/);
  });

  it('price and rooms only reorder: a mismatch still lists, a match ranks higher', () => {
    const pobre = lead({ mensaje: 'Chamberí, hasta 300.000, 5 habitaciones' }); // both fail → 3
    const justo = lead({ mensaje: 'Chamberí, presupuesto 550k' }); // 620000 <= 632500 → 4+1
    const sinDatos = lead({ mensaje: 'Chamberí' }); // unknowns count → 5
    const out = cands([pobre, justo, sinDatos]);
    assert.deepEqual(out.map((c) => c.lead.id), [justo.id, sinDatos.id, pobre.id]);
    assert.deepEqual(out.map((c) => c.score), [5, 5, 3]);
    assert.deepEqual(out[2].motivos, ['zona chamberi']);
  });

  it('applies the 15 % price margin and the rooms floor exactly', () => {
    const limite = lead({ mensaje: 'Chamberí, hasta 539.130' }); // 620000 / 1.15 = 539130.4 → fails
    const dentro = lead({ mensaje: 'Chamberí, hasta 539.131' });
    const [a, b] = cands([limite, dentro]).sort((x, y) => x.lead.id.localeCompare(y.lead.id));
    assert.equal(a.score, 4);
    assert.equal(b.score, 5);
    assert.equal(cands([lead({ mensaje: 'Chamberí, 3 hab' })])[0].score, 5);
    assert.equal(cands([lead({ mensaje: 'Chamberí, 4 hab' })])[0].score, 4);
  });

  it('excludes vendido only: nutriendo is a candidate', () => {
    const vendido = lead({ etapa: 'vendido', mensaje: 'Chamberí' });
    const parked = lead({ etapa: 'nutriendo', mensaje: 'Chamberí' });
    assert.deepEqual(cands([vendido, parked]).map((c) => c.lead.id), [parked.id]);
  });

  it('cuts an unbounded municipio in the reasons', () => {
    const largo = { ...chamberi, municipio: 'x'.repeat(500) };
    const out = candidatos(largo, normalizarLeads([lead({ mensaje: 'algo', expand: { propiedad: largo } })], MUNICIPIOS));
    assert.equal(out[0].motivos[0], `zona ${'x'.repeat(MAX_NOMBRE)} (por la propiedad que consultó)`);
  });

  it('a property without a town has no candidates', () => {
    assert.deepEqual(cands([lead({ mensaje: 'Chamberí' })], { municipio: '' }), []);
  });

  it('a 0 price (unset in PocketBase) fits every budget', () => {
    const out = cands([lead({ mensaje: 'jumeirah lakes towers, 100k' })], PROPIEDADES[2]);
    assert.equal(out[0].score, 5);
  });
});

// ---------------------------------------------------------------------------
// Zones: a property's building and master project count as much as its town,
// and a "-" / "N/A" cell counts for nothing. Vocabulary + scoring, end to end.
//
// TWIN FILE: the esZonaValida vector table below is the one pinned by
// src/crm/import-mapping.test.mjs of BroteaConnect/inmobiliaria-crm (same
// rules, minus the CRM's 80-char cap — see the last assertion).

// A Dubai export the way the importer stored it before and after the junk
// rule: junk master projects, a building in its own field, a legacy row whose
// building lives only in the title.
const DUBAI = [
  { id: 'd1', titulo: 'Dubai Marina · Marina Gate 1 · unidad 1413', municipio: 'Dubai Marina', edificio: 'Marina Gate 1', precio: 0, habitaciones: 0, estado: 'publicada' },
  { id: 'd2', titulo: 'Burj Vista 1 · unidad 2205', municipio: '-', edificio: 'Burj Vista 1', precio: 0, habitaciones: 0, estado: 'publicada' },
  { id: 'd3', titulo: 'N/A · Burj Vista 1 · unidad 2205', municipio: 'N/A', precio: 0, habitaciones: 0, estado: 'borrador' },
  { id: 'd4', titulo: 'Master Project · Seven City · unidad 302', municipio: 'Master Project', proyecto: 'Seven City', precio: 0, habitaciones: 0, estado: 'borrador' },
  { id: 'd5', titulo: 'Loft', municipio: 'Madrid', precio: 289000, habitaciones: 2, estado: 'publicada' },
];

describe('esZonaValida', () => {
  it('pins the vectors the twin file also pins', () => {
    for (const v of ['Dubai Marina', 'Jumeirah Lakes Towers', 'Marsa Dubai']) {
      assert.equal(esZonaValida(v), true, v);
    }
    const malas = ['', '-', '—', 'N/A', 'n/a', '0', '12', 'Master Project', 'master  project'];
    for (const v of malas) assert.equal(esZonaValida(v), false, JSON.stringify(v));
    for (const j of JUNK_ZONA) assert.equal(esZonaValida(j.toUpperCase()), false, j);
    // The CRM rejects this one (its 80-char cap); the matcher has no cap —
    // "cuts an unbounded municipio in the reasons" pins that a 500-char town
    // still matches and is only cut in the message.
    assert.equal(esZonaValida('x'.repeat(81)), true);
    assert.equal(esZonaValida(null), false);
  });
});

describe('zonasDePropiedad / vocabularioZonas', () => {
  it('drops a junk municipio and keeps the building', () => {
    assert.deepEqual(zonasDePropiedad({ municipio: '-', edificio: 'Marina Gate 1' }), ['marina gate 1']);
  });

  it('lists town, master project and building, normalised, in that order', () => {
    const p = { municipio: 'Dubai Marina', proyecto: 'Marina Promenade', edificio: 'Marina Gate 1' };
    assert.deepEqual(zonasDePropiedad(p), ['dubai marina', 'marina promenade', 'marina gate 1']);
  });

  it('reads a legacy title (no edificio field yet) minus its junk and its unit', () => {
    assert.deepEqual(zonasDePropiedad(DUBAI[2]), ['burj vista 1']);
  });

  it('never reads a prose title as a zone', () => {
    assert.deepEqual(zonasDePropiedad({ municipio: 'Madrid', titulo: 'Piso en Chamberí' }), ['madrid']);
  });

  it('ignores the title once the row carries an edificio', () => {
    const p = { municipio: '-', edificio: 'Burj Vista 1', titulo: 'Old Town · Burj Vista 1 · unidad 2205' };
    assert.deepEqual(zonasDePropiedad(p), ['burj vista 1']);
  });

  it('a row that names no zone yields none; a missing row too', () => {
    assert.deepEqual(zonasDePropiedad({ municipio: 'N/A', titulo: '-' }), []);
    assert.deepEqual(zonasDePropiedad(undefined), []);
  });

  it('builds the vocabulary from every property and never contains junk', () => {
    const zonas = vocabularioZonas(DUBAI);
    assert.deepEqual(zonas, ['dubai marina', 'marina gate 1', 'burj vista 1', 'seven city', 'madrid']);
    for (const junk of ['-', 'n/a', 'master project', '']) assert.ok(!zonas.includes(junk), junk);
    // the old vocabulary is untouched: the same junk still leaks there
    assert.ok(vocabularioMunicipios(DUBAI).includes('master project'));
  });
});

describe('candidatos por zona (edificio y master project)', () => {
  const ZONAS = vocabularioZonas(DUBAI);
  const cands = (leads, prop) => candidatos(prop, normalizarLeads(leads, ZONAS));

  it('reads the junk-titled historical criterios: the building as zona_texto, the price', () => {
    const n = normalizarCriterios(lead({ criterios: 'Compró en - · Marina Gate 1 · unidad 1413 · ~1,200,000' }), ZONAS);
    assert.deepEqual(n.zona_texto, ['marina gate 1']);
    assert.deepEqual(n.zona, ['marina gate 1']);
    assert.equal(n.precio_max, 1200000);
  });

  it('a lead who bought in the building is a candidate for a junk-municipio property', () => {
    const l = lead({ criterios: 'Compró en - · Marina Gate 1 · unidad 1413 · ~1,200,000' });
    const out = cands([l], { municipio: '-', edificio: 'Marina Gate 1', precio: 0 });
    assert.equal(out.length, 1);
    assert.equal(out[0].score, 5);
    assert.equal(out[0].motivos[0], 'zona marina gate 1');
  });

  it('a lead naming only the master project still scores the written weight', () => {
    const l = lead({ criterios: 'Compró en Dubai Marina · ~900,000' });
    const [c] = cands([l], DUBAI[0]);
    assert.equal(c.motivos[0], 'zona dubai marina');
    assert.equal(c.score, PESO_ZONA_TEXTO + 2);
  });

  it('"Marina Gate 2" is not "Marina Gate 1"', () => {
    const l = lead({ criterios: 'Compró en Dubai Marina · Marina Gate 2 · unidad 800' });
    const zonas = vocabularioZonas([{ municipio: '-', edificio: 'Marina Gate 1' }]);
    assert.deepEqual(candidatos({ municipio: '-', edificio: 'Marina Gate 1' }, normalizarLeads([l], zonas)), []);
  });

  it('two junk-municipio properties share no candidate through the junk', () => {
    const props = [
      { id: 'j1', titulo: 'Piso A', municipio: '-', precio: 0 },
      { id: 'j2', titulo: 'Piso B', municipio: '-', precio: 0 },
    ];
    const zonas = vocabularioZonas(props);
    const l = lead({ criterios: 'Compró en - · unidad 12 · ~500,000', mensaje: 'zona -' });
    for (const p of props) assert.deepEqual(candidatos(p, normalizarLeads([l], zonas)), []);
  });

  it('the linked property hints its building, scored as a hint', () => {
    const prop = { id: 'd2', titulo: 'Burj Vista 1 · unidad 2205', municipio: '-', edificio: 'Burj Vista 1', precio: 0 };
    const l = lead({ mensaje: 'me interesa', expand: { propiedad: prop } });
    const [c] = cands([l], prop);
    assert.equal(c.score, PESO_ZONA_PISTA + 2);
    assert.equal(c.motivos[0], 'zona burj vista 1 (por la propiedad que consultó)');
  });

  it('the shortlist header names the building when the municipio is junk', () => {
    const prop = DUBAI[1];
    const l = lead({ nombre: 'Omar', criterios: 'Compró en - · Burj Vista 1 · unidad 2205' });
    const txt = textoShortlist(prop, cands([l], prop), null, NOW);
    assert.match(txt, /· Burj Vista 1 · unidad 2205 \(Burj Vista 1\) · 1 candidato:/);
    const gate = { ...prop, titulo: 'Marina Gate 1 · unidad 1413', edificio: 'Marina Gate 1' };
    const l2 = lead({ nombre: 'Omar', criterios: 'Compró en - · Marina Gate 1 · unidad 1413' });
    assert.match(textoShortlist(gate, cands([l2], gate), null, NOW), /\(Marina Gate 1\)/);
  });
});

describe('esReciente', () => {
  it('is true inside the last 24 h, false beyond, false for an unusable date', () => {
    assert.equal(esReciente(hoursAgo(23), NOW), true);
    assert.equal(esReciente(pbDate(hoursAgo(25)), NOW), false);
    assert.equal(esReciente('', NOW), false);
  });
});

describe('textoShortlist', () => {
  const prop = PROPIEDADES[0];
  const shortlist = (leads, guardia = null) =>
    textoShortlist(prop, candidatos(prop, normalizarLeads(leads, MUNICIPIOS)), guardia, NOW);

  it('returns null without candidates', () => {
    assert.equal(textoShortlist(prop, [], 'Luis', NOW), null);
  });

  it('names the property and prints lead, agent and reasons per line, with the CRM footer', () => {
    const l = lead({ nombre: 'Ana', mensaje: 'Chamberí', expand: { asignado: { name: 'Luis' } } });
    const txt = shortlist([l]);
    assert.match(txt, /<b>Encaje<\/b> — .* · Piso en Chamberí \(Chamberí\) · 1 candidato:/);
    assert.match(txt, /^• <b>Ana<\/b> · Luis · zona chamberi, presupuesto sin indicar, habitaciones sin indicar$/m);
    assert.ok(txt.endsWith(PIE_CRM));
  });

  it('falls back to the on-duty agent, then to "sin asignar"', () => {
    const l = lead({ nombre: 'Ana', mensaje: 'Chamberí' });
    assert.match(shortlist([l], 'Marta'), /<b>Ana<\/b> · Marta \(guardia\) · /);
    assert.match(shortlist([l]), /<b>Ana<\/b> · sin asignar · /);
  });

  it('escapes and truncates names (HTML mode)', () => {
    const l = lead({ nombre: 'P&J <SL>', mensaje: 'Chamberí', expand: { asignado: { name: '&'.repeat(500) } } });
    const txt = shortlist([l]);
    assert.match(txt, new RegExp(`<b>P&amp;J &lt;SL&gt;</b> · ${'&amp;'.repeat(MAX_NOMBRE)} · `));
    const largo = { ...prop, titulo: '<'.repeat(500) };
    assert.match(textoShortlist(largo, candidatos(largo, normalizarLeads([l], MUNICIPIOS)), null, NOW), new RegExp(`· ${'&lt;'.repeat(MAX_NOMBRE)} \\(`));
  });

  it('caps at MAX_LINES with "… y N más" and stays under 4096 chars with 200 candidates', () => {
    const many = Array.from({ length: 200 }, () =>
      lead({ nombre: 'x'.repeat(200), mensaje: 'Chamberí, 550k, 3 hab', expand: { asignado: { name: 'y'.repeat(200) } } }));
    const txt = shortlist(many);
    assert.equal((txt.match(/^• /gm) || []).length, MAX_LINES);
    assert.match(txt, new RegExp(`… y ${200 - MAX_LINES} más`));
    assert.ok(txt.length < 4096, `length ${txt.length}`);
  });

  it('lists the best-scored candidate first', () => {
    const flojo = lead({ nombre: 'Flojo', mensaje: 'Chamberí, hasta 100.000, 6 hab' });
    const fuerte = lead({ nombre: 'Fuerte', mensaje: 'Chamberí, 700k' });
    const txt = shortlist([flojo, fuerte]);
    assert.ok(txt.indexOf('<b>Fuerte</b>') < txt.indexOf('<b>Flojo</b>'));
  });
});
