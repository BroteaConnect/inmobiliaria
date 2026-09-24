// e6-runs.test.mjs — run()-level tests of the four E6 jobs against a fake
// PocketBase that records every write. The point: ctx.pb is a LIVE production
// client under --dry-run too, so a dry run must write NOTHING — and the order
// of notify / marker / event is part of each job's contract.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as unanswered from './unanswered.mjs';
import * as weeklySummary from './weekly-summary.mjs';
import * as reactivation from './reactivation.mjs';
import * as ownerReport from './owner-report.mjs';

const pbDate = (d) => d.toISOString().replace('T', ' ');

// A fake client: lists come from `data[collection]` (settings filtered by the
// `key = "…"` in the filter), every create/update/delete is recorded.
function fakePb(data) {
  const writes = [];
  const trace = []; // shared with ctxFor: writes land in the same timeline
  const collection = (name) => ({
    getFullList: async (opts = {}) => {
      const rows = data[name] ?? [];
      const key = /key = "([^"]+)"/.exec(opts.filter ?? '')?.[1];
      return name === 'settings' && key ? rows.filter((r) => r.key === key) : rows;
    },
    getOne: async (id) => (data[name] ?? []).find((r) => r.id === id) ?? { id, name: 'Marta' },
    create: async (body) => { writes.push(['create', name, body]); trace.push(['write']); return body; },
    update: async (id, body) => { writes.push(['update', name, id, body]); trace.push(['write']); return body; },
    delete: async (id) => { writes.push(['delete', name, id]); trace.push(['write']); },
  });
  return { writes, trace, collection };
}

function ctxFor(pb, now, dryRun, env = {}) {
  const { trace } = pb;
  return {
    trace,
    ctx: {
      pb, now, dryRun, env, slug: 'inmobiliaria',
      log: (m) => trace.push(['log', m]),
      event: async (type, payload) => trace.push(['event', type, payload]),
      notify: async (text) => {
        assert.equal(typeof text, 'string');
        trace.push(['notify', text]);
      },
    },
  };
}
// The non-log timeline: 'event' | 'notify' | 'write', in the order they happened.
const kinds = (trace) => trace.filter(([k]) => k !== 'log').map(([k]) => k);

// Wednesday 2026-09-23 12:00 Madrid.
const NOW = new Date('2026-09-23T10:00:00.000Z');
const ago = (min) => pbDate(new Date(NOW - min * 60_000));

describe('unanswered run()', () => {
  const data = () => ({
    actividades: [{ id: 'act1', lead: 'lead1', tipo: 'whatsapp', direccion: 'entrante', created: ago(130) }],
    leads: [{ id: 'lead1', nombre: 'Ana López' }],
    settings: [],
  });
  it('dry run: alerts, writes nothing', async () => {
    const pb = fakePb(data());
    const { ctx, trace } = ctxFor(pb, NOW, true);
    await unanswered.run(ctx);
    assert.deepEqual(pb.writes, []);
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'unanswered: 1 lead(s) waiting over 2h'));
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'dry-run: would write jobs.unanswered'));
  });
  it('real run: notify → marker → events, and the marker then silences the next run', async () => {
    const pb = fakePb(data());
    const { ctx, trace } = ctxFor(pb, NOW, false);
    await unanswered.run(ctx);
    assert.deepEqual(kinds(trace), ['notify', 'write', 'event']);
    assert.deepEqual(trace.find(([k]) => k === 'event').slice(1), ['lead.unanswered_alert', { lead_id: 'lead1', activity_id: 'act1', waited_min: 130 }]);
    const marker = pb.writes[0][2];
    const again = fakePb({ ...data(), settings: [{ id: 'set1', key: 'jobs.unanswered', value: marker.value }] });
    const second = ctxFor(again, new Date(NOW.getTime() + 3_600_000), false);
    await unanswered.run(second.ctx);
    assert.deepEqual(kinds(second.trace), []);
  });
  it('a failed notify leaves no event and no marker', async () => {
    const pb = fakePb(data());
    const { ctx, trace } = ctxFor(pb, NOW, false);
    await assert.rejects(unanswered.run({ ...ctx, notify: async () => { throw new Error('telegram down'); } }), /telegram down/);
    assert.deepEqual(pb.writes, []);
    assert.ok(!trace.some(([k]) => k === 'event'));
  });
  it('an unreadable marker fails the run instead of re-alerting', async () => {
    const pb = fakePb(data());
    const orig = pb.collection;
    pb.collection = (name) => (name === 'settings'
      ? { ...orig(name), getFullList: async () => { throw new Error('PocketBase GET → 500'); } }
      : orig(name));
    const { ctx, trace } = ctxFor(pb, NOW, false);
    await assert.rejects(unanswered.run(ctx), /500/);
    assert.ok(!trace.some(([k]) => k === 'notify'));
  });
  it('outside 09:00–21:00 it holds, and writes nothing', async () => {
    const late = new Date('2026-09-23T20:30:00.000Z'); // 22:30 Madrid
    const pb = fakePb({ ...data(), actividades: [{ id: 'act1', lead: 'lead1', tipo: 'email', direccion: 'entrante', created: pbDate(new Date(late - 150 * 60_000)) }] });
    const { ctx, trace } = ctxFor(pb, late, false);
    await unanswered.run(ctx);
    assert.deepEqual(kinds(trace), []);
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'unanswered: holding 1 alert(s) until 09:00'));
  });
});

describe('weekly-summary run()', () => {
  it('dry run: logs the contract line, event then notify, writes nothing', async () => {
    const pb = fakePb({ leads: [{ id: 'l1', created: ago(60 * 24 * 3), origen: 'web', etapa: 'nuevo' }] });
    const { ctx, trace } = ctxFor(pb, new Date('2026-09-25T16:00:00.000Z'), true);
    await weeklySummary.run(ctx);
    assert.deepEqual(kinds(trace), ['event', 'notify']);
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'weekly-summary: 1 new lead(s) this week'));
  });
  it('an unreadable envios degrades, it does not throw', async () => {
    const pb = fakePb({});
    const orig = pb.collection;
    pb.collection = (name) => (name === 'envios' ? { ...orig(name), getFullList: async () => { throw new Error('403'); } } : orig(name));
    const { ctx, trace } = ctxFor(pb, NOW, true);
    await weeklySummary.run(ctx);
    assert.equal(trace.find(([k]) => k === 'event')[2].envios, null);
  });
});

describe('reactivation run()', () => {
  const old = pbDate(new Date(NOW - 60 * 86_400_000));
  const data = (actividades = []) => ({
    propiedades: [{ id: 'p1', titulo: 'Piso', municipio: 'Chamberí', estado: 'publicada', precio: 1, habitaciones: 1 }],
    leads: [{ id: 'l1', nombre: 'Ana', etapa: 'nutriendo', created: old, ultimo_contacto: old, criterios: 'Chamberí', consentimiento: true, consentimiento_en: old }],
    actividades,
    settings: [],
  });
  it('dry run: proposes, writes nothing', async () => {
    const pb = fakePb(data());
    const { ctx, trace } = ctxFor(pb, NOW, true);
    await reactivation.run(ctx);
    assert.deepEqual(pb.writes, []);
    assert.deepEqual(kinds(trace), ['event', 'notify']);
    assert.deepEqual(trace.find(([k]) => k === 'event').slice(1), ['reactivation.proposed', { leads: 1, properties: 1, with_consent: 1 }]);
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'reactivation: 1 dormant lead(s) fit published stock'));
  });
  it('a lead who wrote recently is not dormant: silence', async () => {
    const pb = fakePb(data([{ id: 'a1', lead: 'l1', direccion: 'entrante', tipo: 'whatsapp', created: ago(60) }]));
    const { ctx, trace } = ctxFor(pb, NOW, true);
    await reactivation.run(ctx);
    assert.deepEqual(kinds(trace), []);
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'reactivation: 0 dormant lead(s) fit published stock'));
  });
});

describe('owner-report run()', () => {
  const data = () => ({
    propiedades: [{ id: 'p1', titulo: 'Piso', estado: 'publicada', expand: { propietario: { id: 'o1', nombre: 'Carmen', telefono: '', consentimiento: false } } }],
    leads: [], visitas: [], actividades: [], plantillas: [], settings: [],
  });
  it('dry run off-calendar: drafts anyway, writes nothing', async () => {
    const pb = fakePb(data());
    const { ctx, trace } = ctxFor(pb, NOW, true);
    await ownerReport.run(ctx);
    assert.deepEqual(pb.writes, []);
    assert.deepEqual(kinds(trace), ['event', 'notify']);
    assert.ok(trace.some(([k, m]) => k === 'log' && m === 'owner-report: 1 draft(s) for 2026-08'));
  });
  it('real run on the calendar: event → messages → marker; off the calendar: nothing', async () => {
    const pb = fakePb(data());
    const { ctx, trace } = ctxFor(pb, new Date('2026-10-01T08:00:00.000Z'), false);
    await ownerReport.run(ctx);
    assert.deepEqual(kinds(trace), ['event', 'notify', 'write']);
    assert.deepEqual(pb.writes[0].slice(0, 2), ['create', 'settings']);
    assert.deepEqual(pb.writes[0][2].value, { v: 1, last_month: '2026-09' });
    const off = fakePb(data());
    const run2 = ctxFor(off, NOW, false);
    await ownerReport.run(run2.ctx);
    assert.deepEqual(kinds(run2.trace), []);
  });
});
