// unanswered.lib.test.mjs — the "nobody answered in two hours" rules, plus the
// shared Madrid calendar helpers and the PocketBase marker helpers they use.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueAlerts, insideAlertHours, markAlerted, pruneMarker, textUnanswered, unansweredStreaks, waitText,
} from './unanswered.lib.mjs';
import { addDays, madridParts, madridWallTime, monthNameEs, previousMonth } from './madrid.lib.mjs';
import { onDutyName, readMarker, safeName, writeMarker } from './pb-helpers.lib.mjs';
import { MAX_LINES, MAX_MESSAGE_CHARS, PIE_CRM, firstName, fitTelegram } from './lib.mjs';

// 2026-09-23 12:00 Madrid (CEST, UTC+2) = 10:00Z.
const NOW = new Date('2026-09-23T10:00:00.000Z');
const minAgo = (m) => new Date(NOW - m * 60_000).toISOString().replace('T', ' ');
let seq = 0;
const act = (lead, over = {}) => ({
  id: `a${++seq}`, lead, tipo: 'whatsapp', direccion: 'entrante', created: minAgo(130), ...over,
});

describe('unansweredStreaks', () => {
  it('alerts at 130 minutes, not at 119', () => {
    const out = unansweredStreaks([act('l1', { created: minAgo(130) }), act('l2', { created: minAgo(119) })], NOW);
    assert.deepEqual(out.map((s) => s.lead_id), ['l1']);
    assert.equal(out[0].waited_min, 130);
  });
  it('a reply after the inbound closes the streak', () => {
    const out = unansweredStreaks([
      act('l1', { created: minAgo(200) }),
      act('l1', { direccion: 'saliente', created: minAgo(150) }),
    ], NOW);
    assert.deepEqual(out, []);
  });
  it('a reply before the inbound does not', () => {
    const inbound = act('l1', { created: minAgo(150) });
    const out = unansweredStreaks([inbound, act('l1', { direccion: 'saliente', created: minAgo(300) })], NOW);
    assert.deepEqual(out.map((s) => s.activity_id), [inbound.id]);
  });
  it('three inbounds in one streak: the first is the anchor', () => {
    const first = act('l1', { created: minAgo(400) });
    const out = unansweredStreaks([act('l1', { created: minAgo(10) }), first, act('l1', { created: minAgo(200) })], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].activity_id, first.id);
    assert.equal(out[0].waited_min, 400);
  });
  it('an outbound nota counts as a reply', () => {
    const out = unansweredStreaks([
      act('l1', { created: minAgo(300) }),
      act('l1', { tipo: 'nota', direccion: 'saliente', created: minAgo(200) }),
    ], NOW);
    assert.deepEqual(out, []);
  });
  it('a failed send is not a reply', () => {
    const inbound = act('l1', { created: minAgo(300) });
    const out = unansweredStreaks([inbound, act('l1', { direccion: 'saliente', estado_envio: 'error', created: minAgo(200) })], NOW);
    assert.deepEqual(out.map((s) => s.activity_id), [inbound.id]);
  });
  it('an inbound llamada opens no streak', () => {
    assert.deepEqual(unansweredStreaks([act('l1', { tipo: 'llamada', created: minAgo(300) })], NOW), []);
  });
  it('an anchor older than 24 h is ignored', () => {
    assert.deepEqual(unansweredStreaks([act('l1', { created: minAgo(24 * 60 + 5) })], NOW), []);
  });
  it('a row with an unparseable date is ignored', () => {
    assert.deepEqual(unansweredStreaks([act('l1', { created: '' }), act('l2', { created: 'nonsense' })], NOW), []);
  });
  it('an excluded lead is never alerted', () => {
    const out = unansweredStreaks([act('l1'), act('l2')], NOW, { excludeLeadIds: ['l1'] });
    assert.deepEqual(out.map((s) => s.lead_id), ['l2']);
  });
  it('sorts the oldest wait first', () => {
    const out = unansweredStreaks([act('l1', { created: minAgo(150) }), act('l2', { created: minAgo(600) })], NOW);
    assert.deepEqual(out.map((s) => s.lead_id), ['l2', 'l1']);
  });
  it('a "__proto__" lead id is just another lead', () => {
    const out = unansweredStreaks([act('__proto__'), act('l1')], NOW);
    assert.deepEqual(out.map((s) => s.lead_id).sort(), ['__proto__', 'l1']);
    assert.equal({}.lead_id, undefined);
  });
});

describe('the alerted marker', () => {
  const s1 = { lead_id: 'l1', activity_id: 'a1', waited_min: 130 };
  const s2 = { lead_id: 'l2', activity_id: 'a2', waited_min: 140 };
  it('dueAlerts drops the anchors already alerted', () => {
    assert.deepEqual(dueAlerts([s1, s2], { v: 1, alerted: { a1: NOW.toISOString() } }), [s2]);
  });
  it('a broken marker counts as empty', () => {
    for (const m of [null, 'x', { v: 2, alerted: { a1: 'x' } }, { v: 1, alerted: ['a1'] }]) {
      assert.deepEqual(dueAlerts([s1], m), [s1]);
    }
  });
  it('pruneMarker keeps 7 days and drops unusable dates', () => {
    const old = new Date(NOW - 8 * 86_400_000).toISOString();
    const fresh = new Date(NOW - 6 * 86_400_000).toISOString();
    assert.deepEqual(pruneMarker({ v: 1, alerted: { a1: old, a2: fresh, a3: '' } }, NOW), { v: 1, alerted: { a2: fresh } });
  });
  it('markAlerted returns a new marker and leaves the input alone', () => {
    const before = { v: 1, alerted: { a0: 'x' } };
    const after = markAlerted(before, [s1], NOW);
    assert.deepEqual(before, { v: 1, alerted: { a0: 'x' } });
    assert.deepEqual(after, { v: 1, alerted: { a0: 'x', a1: NOW.toISOString() } });
  });
});

describe('insideAlertHours (Madrid wall clock)', () => {
  it('summer (CEST): 07:00Z is 09:00 in, 06:59Z is 08:59 out, 19:00Z is 21:00 out', () => {
    assert.equal(insideAlertHours(new Date('2026-07-01T07:00:00Z')), true);
    assert.equal(insideAlertHours(new Date('2026-07-01T06:59:00Z')), false);
    assert.equal(insideAlertHours(new Date('2026-07-01T18:59:00Z')), true);
    assert.equal(insideAlertHours(new Date('2026-07-01T19:00:00Z')), false);
  });
  it('winter (CET): 08:00Z is 09:00 in, 07:59Z out, 20:00Z is 21:00 out', () => {
    assert.equal(insideAlertHours(new Date('2026-01-15T08:00:00Z')), true);
    assert.equal(insideAlertHours(new Date('2026-01-15T07:59:00Z')), false);
    assert.equal(insideAlertHours(new Date('2026-01-15T20:00:00Z')), false);
  });
});

describe('waitText', () => {
  it('reads hours and minutes', () => {
    assert.equal(waitText(135), '2 h 15 min');
    assert.equal(waitText(120), '2 h');
    assert.equal(waitText(45), '45 min');
  });
});

describe('textUnanswered', () => {
  const alerts = [{ lead_id: 'l1', activity_id: 'a1', tipo: 'whatsapp', created: minAgo(135), waited_min: 135 }];
  it('is null with nothing to say', () => {
    assert.equal(textUnanswered([], new Map(), null), null);
  });
  it('names the lead, channel, wait and assigned agent, escaped', () => {
    const leads = new Map([['l1', { id: 'l1', nombre: 'Ana<b> Pérez', expand: { asignado: { name: 'Luis' } } }]]);
    const t = textUnanswered(alerts, leads, 'Marta');
    assert.match(t, /^⏰ <b>Sin respuesta<\/b> — 1 lead lleva más de 2 h esperando:/);
    assert.doesNotMatch(t, /Pérez/);
    assert.match(t, /• <b>Ana&lt;b&gt;<\/b> · WhatsApp · 2 h 15 min \(desde las \d\d:\d\d\) · Luis/);
    assert.ok(t.endsWith(`Si ya contestaste fuera del CRM, regístralo allí.\n${PIE_CRM}`));
  });
  it('falls back to the on-duty agent, then to "sin asignar"', () => {
    const leads = new Map([['l1', { id: 'l1', nombre: 'Ana' }]]);
    assert.match(textUnanswered(alerts, leads, 'Marta'), /· Marta \(guardia\)$/m);
    assert.match(textUnanswered(alerts, new Map(), null), /lead sin nombre.*· sin asignar$/m);
  });
  it('caps the list', () => {
    const many = Array.from({ length: MAX_LINES + 3 }, (_, i) => ({ ...alerts[0], lead_id: `l${i}`, activity_id: `a${i}` }));
    const t = textUnanswered(many, new Map(), null);
    assert.match(t, /13 leads llevan/);
    assert.match(t, /… y 3 más/);
  });
});

describe('fitTelegram', () => {
  it('leaves a short message alone and shortens a long one', () => {
    assert.equal(fitTelegram('hola'), 'hola');
    assert.equal(fitTelegram(null), null);
    const long = `cabecera\n${'x'.repeat(5000)}`;
    const t = fitTelegram(long);
    assert.ok(t.length <= MAX_MESSAGE_CHARS);
    assert.ok(t.startsWith('cabecera\n'));
    assert.ok(t.endsWith(PIE_CRM));
  });
  it('the unanswered alert never exceeds the limit', () => {
    const alerts = Array.from({ length: 10 }, (_, i) => ({ lead_id: `l${i}`, activity_id: `a${i}`, tipo: 'x'.repeat(2000), created: minAgo(130), waited_min: 130 }));
    const t = textUnanswered(alerts, new Map(), 'y'.repeat(2000));
    assert.ok(t.length <= MAX_MESSAGE_CHARS);
    assert.match(t, /^⏰ <b>Sin respuesta<\/b>/);
  });
});

describe('madrid.lib', () => {
  it('madridWallTime survives both DST edges', () => {
    assert.equal(madridWallTime(2026, 3, 29, 18, 0).toISOString(), '2026-03-29T16:00:00.000Z');
    assert.equal(madridWallTime(2026, 3, 28, 18, 0).toISOString(), '2026-03-28T17:00:00.000Z');
    assert.equal(madridWallTime(2026, 10, 25, 18, 0).toISOString(), '2026-10-25T17:00:00.000Z');
    assert.equal(madridWallTime(2026, 10, 24, 18, 0).toISOString(), '2026-10-24T16:00:00.000Z');
  });
  it('madridParts reads the Madrid day across midnight UTC', () => {
    const p = madridParts(new Date('2026-09-24T22:30:00Z'));
    assert.equal(p.ymd, '2026-09-25');
    assert.equal(p.dow, 5);
    assert.equal(p.hour, 0);
    assert.equal(madridParts(''), null);
  });
  it('calendar arithmetic', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(previousMonth('2026-01'), '2025-12');
    assert.equal(previousMonth('2026-10'), '2026-09');
    assert.equal(monthNameEs('2026-09'), 'septiembre');
  });
  it('firstName', () => {
    assert.equal(firstName('  María José Pérez '), 'María');
    assert.equal(firstName(''), '');
    assert.equal(firstName(undefined), '');
  });
});

// A fake PocketBase client that records every call.
const fakePb = ({ rows = [], fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    collection: (name) => ({
      getFullList: async (opts) => { calls.push(['list', name, opts?.filter]); if (fail) throw (fail instanceof Error ? fail : new Error('down')); return rows; },
      getOne: async (id) => { calls.push(['getOne', name, id]); if (fail) throw new Error('down'); return { id, name: 'Marta' }; },
      create: async (body) => { calls.push(['create', name, body]); return body; },
      update: async (id, body) => { calls.push(['update', name, id, body]); return body; },
    }),
  };
};

describe('pb-helpers', () => {
  it('safeName drops email addresses and phone numbers', () => {
    assert.equal(safeName('agente.uno@example.com'), 'agente.uno');
    assert.equal(safeName('+34 600 123 456'), '');
    assert.equal(safeName('Ana (600123456)'), 'Ana ()');
    assert.equal(safeName('María José'), 'María José');
    assert.equal(safeName('Piso 3'), 'Piso 3');
    assert.equal(safeName(undefined), '');
  });
  it('the alert never shows an address or a phone', () => {
    const leads = new Map([['l1', { id: 'l1', nombre: '+971 50 123 4567', expand: { asignado: { name: 'luis@example.com' } } }]]);
    const t = textUnanswered([{ lead_id: 'l1', activity_id: 'a1', tipo: 'email', created: minAgo(130), waited_min: 130 }], leads, null);
    assert.doesNotMatch(t, /@|\d{3} \d{4}/);
    assert.match(t, /<b>lead sin nombre<\/b>.*· luis$/m);
  });
  it('writeMarker writes nothing and reads nothing under dry-run', async () => {
    const pb = fakePb();
    const logs = [];
    await writeMarker(pb, 'jobs.unanswered', { v: 1 }, true, (m) => logs.push(m));
    assert.deepEqual(pb.calls, []);
    assert.deepEqual(logs, ['dry-run: would write jobs.unanswered']);
  });
  it('writeMarker creates when absent and updates when present', async () => {
    const empty = fakePb();
    await writeMarker(empty, 'jobs.unanswered', { v: 1 }, false, () => {});
    assert.equal(empty.calls.at(-1)[0], 'create');
    assert.equal(empty.calls.at(-1)[2].key, 'jobs.unanswered');
    const present = fakePb({ rows: [{ id: 'abc123', key: 'jobs.unanswered' }] });
    await writeMarker(present, 'jobs.unanswered', { v: 1 }, false, () => {});
    assert.deepEqual(present.calls.at(-1), ['update', 'settings', 'abc123', { value: { v: 1 } }]);
  });
  it('readMarker: absent is null, unreadable is an error', async () => {
    assert.equal(await readMarker(fakePb(), 'jobs.unanswered'), null);
    assert.deepEqual(await readMarker(fakePb({ rows: [{ value: { v: 1 } }] }), 'jobs.unanswered'), { v: 1 });
    const notFound = fakePb({ fail: Object.assign(new Error('PocketBase GET /x → 404 {}'), {}) });
    assert.equal(await readMarker(notFound, 'jobs.unanswered'), null);
    assert.equal(await readMarker(fakePb({ fail: Object.assign(new Error('nope'), { status: 404 }) }), 'jobs.unanswered'), null);
    await assert.rejects(readMarker(fakePb({ fail: true }), 'jobs.unanswered'), /down/);
    await assert.rejects(readMarker(fakePb({ fail: new Error('PocketBase GET /x → 500 {}') }), 'jobs.unanswered'), /500/);
    await assert.rejects(readMarker(fakePb(), 'bad key"'), /not a settings key/);
  });
  it('onDutyName degrades to null and never puts a non-id in a URL', async () => {
    assert.equal(await onDutyName(fakePb({ fail: true }), () => {}, 't'), null);
    const bad = fakePb({ rows: [{ value: { text: '../x' } }] });
    assert.equal(await onDutyName(bad, () => {}, 't'), null);
    assert.ok(!bad.calls.some((c) => c[0] === 'getOne'));
    assert.equal(await onDutyName(fakePb({ rows: [{ value: { text: 'u1' } }] }), () => {}, 't'), 'Marta');
  });
});
