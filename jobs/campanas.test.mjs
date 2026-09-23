// campanas.test.mjs — the job against a fake PocketBase and a fake chassis:
// what it writes, what it sends, what it emits, and that it throws.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './campanas.mjs';
import { TEST_LEAD_IDS } from './campanas.lib.mjs';

const T = TEST_LEAD_IDS[0];
const NOW = new Date('2026-09-23T10:00:00.000Z'); // 12:00 Madrid
const SECRET = 's3cr3t+/=value';
const REAL = ['aaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbb', 'ccccccccccccccc', 'ddddddddddddddd', 'eeeeeeeeeeeeeee'];
const ENV = { CHASSIS_URL: 'https://chassis.test/', OUTBOUND_SECRET: SECRET };
const READY = { ...ENV, CAMPAIGN_SENDER_READY: '1' };
const TEMPLATES = [
  { id: 'pemail000000001', clave: 'consentimiento.baja.email', canal: 'email', variables: ['nombre', 'agencia'], estado: 'borrador' },
  { id: 'pwhats000000001', clave: 'consentimiento.solicitud', canal: 'whatsapp', variables: ['nombre', 'agencia'], estado: 'borrador', cuerpo_es: 'Hola {{nombre}}, somos {{agencia}}.', cuerpo_en: 'Hi {{nombre}}' },
];
const AGENCIA = { key: 'negocio.razonSocial', value: { v: 1, text: 'Agencia Test' } };

const campaign = (over = {}) => ({
  id: 'camp00000000001', nombre: 'Ensayo', plantilla: 'pemail000000001', segmento: { v: 1, ids: [T] },
  lote_diario: 10, intervalo_min: 0, hora_desde: '09:00', hora_hasta: '20:00', inicio: '', estado: 'programada',
  ultimo_envio_en: '', informe: null, ...over,
});

function world({ campanas, settings = [AGENCIA], envios = [], leads } = {}) {
  const db = {
    campanas, settings, envios, plantillas: TEMPLATES,
    leads: leads ?? [T, ...REAL].map((id) => ({ id, nombre: `N ${id.slice(0, 3)}`, origen: id === T ? '' : 'histórico' })),
  };
  const writes = [];
  const collection = (name) => ({
    getFullList: async ({ filter = '' } = {}) => {
      const m = /campana = "(\w+)"/.exec(filter);
      return structuredClone(db[name].filter((r) => (m ? r.campana === m[1] : true)));
    },
    getOne: async (id) => {
      const r = db[name].find((x) => x.id === id);
      if (!r) throw new Error(`${name} ${id} → 404`);
      return structuredClone(r);
    },
    update: async (id, body) => { writes.push({ name, id, body }); Object.assign(db[name].find((x) => x.id === id), structuredClone(body)); },
    create: async (body) => { writes.push({ name, body }); },
    delete: async (id) => { writes.push({ name, id, deleted: true }); },
  });
  return { db, writes, pb: { collection } };
}

/** answers: a list consumed in order; each is {status, body} or an Error to throw. */
// `ledger`: a 200 also writes the envios row, as the chassis does before it answers.
function harness(w, { env = ENV, answers = [], dryRun = false, ledger = false } = {}) {
  const calls = [];
  const events = [];
  const notes = [];
  const logs = [];
  const queue = [...answers];
  const ctx = {
    pb: w.pb, env, now: NOW, dryRun,
    log: (m) => logs.push(m),
    event: async (type, payload) => { events.push({ type, payload }); },
    notify: async (text) => { notes.push(text); },
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const a = queue.shift() ?? { status: 200, body: { ok: true, envio_id: 'env000000000001' } };
      if (a instanceof Error) throw a;
      const sent = JSON.parse(init.body);
      if (ledger && a.status === 200 && sent.campana_id) w.db.envios.push({ lead: sent.lead_id, campana: sent.campana_id, estado: 'enviado' });
      return { status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
    },
  };
  const tick = async () => { try { return await run(ctx); } catch (e) { return e; } };
  return { ctx, calls, events, notes, logs, tick };
}

const states = (w, id = 'camp00000000001') => Object.values(w.db.campanas.find((c) => c.id === id).informe?.recipients ?? {}).map((r) => r.state);
const campanaEvents = (h) => h.events.filter((e) => e.type.startsWith('campana.'));

describe('guards: nothing is written, sent or emitted', () => {
  const cu = campaign({ id: 'cu1500000000001', nombre: 'Consentimiento CU-15', plantilla: 'pwhats000000001', segmento: { v: 1, origen: ['histórico'] }, estado: 'programada' });
  it('CU-15 in borrador is never touched', async () => {
    const w = world({ campanas: [{ ...cu, estado: 'borrador' }] });
    const h = harness(w, { env: { ...READY, CU15_OWNER_YES: cu.id } });
    assert.equal(await h.tick(), 'no active campaign');
    assert.deepEqual([w.writes.length, h.events.length, h.calls.length], [0, 0, 0]);
  });
  for (const [label, env] of [['no owner yes', READY], ['wrong owner yes', { ...READY, CU15_OWNER_YES: 'x' }], ['no sender flag', { ...ENV, CU15_OWNER_YES: cu.id }]]) {
    it(`CU-15 programada, ${label}: throws, zero writes, zero campana.* events, zero fetches`, async () => {
      const w = world({ campanas: [cu] });
      const h = harness(w, { env });
      assert.match(String((await h.tick()).message), /cu15_not_authorised/);
      assert.deepEqual([w.writes.length, campanaEvents(h).length, h.calls.length, h.notes.length], [0, 0, 0, 0]);
    });
  }
  it('CU-15 unauthorised with a broken segment is refused before the segment can pause it', async () => {
    const w = world({ campanas: [{ ...cu, segmento: { v: 1 } }] });
    const h = harness(w, { env: READY });
    assert.match(String((await h.tick()).message), /cu15_not_authorised/);
    assert.deepEqual([w.writes.length, campanaEvents(h).length, h.notes.length], [0, 0, 0]);
  });
  it('a real recipient without CAMPAIGN_SENDER_READY is refused before any write or send', async () => {
    const w = world({ campanas: [campaign({ segmento: { v: 1, ids: [T, REAL[0]] } })] });
    const h = harness(w);
    assert.match(String((await h.tick()).message), /sender_not_ready/);
    assert.deepEqual([w.writes.length, h.events.length, h.calls.length], [0, 0, 0]);
  });
  it('real recipients with the flag still need CU-15 completada', async () => {
    const w = world({ campanas: [campaign({ segmento: { v: 1, ids: REAL } }), { ...cu, estado: 'borrador' }] });
    const h = harness(w, { env: READY });
    assert.match(String((await h.tick()).message), /cu15_not_completed/);
    assert.deepEqual([w.writes.length, h.calls.length], [0, 0]);
  });
});

describe('dry run and secrets', () => {
  it('a dry run writes nothing and reaches no network', async () => {
    const w = world({ campanas: [campaign()] });
    const h = harness(w, { dryRun: true });
    const out = await h.tick();
    assert.equal(typeof out, 'string', String(out));
    assert.deepEqual([w.writes.length, h.calls.length], [0, 0]);
    assert.ok(h.logs.some((l) => l.includes(`would send consentimiento.baja.email to ${T}`)));
  });
  it('missing CHASSIS_URL or OUTBOUND_SECRET pauses by name without a fetch', async () => {
    const w = world({ campanas: [campaign()] });
    const h = harness(w, { env: { CHASSIS_URL: 'https://x' } });
    assert.match(String((await h.tick()).message), /chassis_not_configured/);
    assert.equal(w.db.campanas[0].estado, 'pausada');
    assert.equal(h.calls.length, 0);
  });
  it('the secret never reaches a log, an event, a notification, a write or an error', async () => {
    for (const answer of [
      { status: 403, body: { ok: false, error: { code: SECRET, text: SECRET } } },
      { status: 502, body: `<html>${encodeURIComponent(SECRET)}</html>` },
      new Error(`connect ECONNREFUSED ${SECRET}`),
    ]) {
      const w = world({ campanas: [campaign()] });
      const h = harness(w, { answers: [answer] });
      const err = await h.tick();
      assert.equal(h.calls.length, 1);
      assert.ok(h.calls[0].url.endsWith(`?secret=${encodeURIComponent(SECRET)}`));
      assert.equal(h.calls[0].init.headers.Authorization, undefined);
      const seen = JSON.stringify([h.logs, h.events, h.notes, w.writes, String(err?.message ?? err)]);
      assert.equal(seen.includes(SECRET) || seen.includes(encodeURIComponent(SECRET)), false, JSON.stringify(answer));
    }
  });
});

describe('the inversion: refusals about the run never cost a person', () => {
  const five = () => world({ campanas: [campaign({ segmento: { v: 1, ids: REAL } }), { id: 'cu1500000000001', nombre: 'CU-15', estado: 'completada' }] });
  it('an unknown 403 on recipient 1 of 5 leaves all 5 pending; three ticks pause with nobody excluded', async () => {
    const w = five();
    const unknown = { status: 403, body: { ok: false, error: { code: 'auth_token_required' } } };
    const h = harness(w, { env: READY, answers: [unknown, unknown, unknown] });
    assert.match(String((await h.tick()).message), /stopped on infra auth_token_required/);
    assert.deepEqual([h.calls.length, states(w)], [1, ['pending', 'pending', 'pending', 'pending', 'pending']]);
    await h.tick();
    assert.match(String((await h.tick()).message), /paused: auth_token_required/);
    const c = w.db.campanas[0];
    assert.deepEqual([c.estado, c.informe.excluidos.length, h.calls.length], ['pausada', 0, 3]);
  });
  for (const [label, answer] of [
    ['503 auth_not_configured', { status: 503, body: { ok: false, error: { code: 'auth_not_configured' } } }],
    ['403 forbidden', { status: 403, body: { ok: false, error: { code: 'forbidden' } } }],
    ['503 not configured', { status: 503, body: { error: 'not configured' } }],
    ['503 smtp not configured', { status: 503, body: { error: 'smtp not configured' } }],
  ]) {
    it(`${label}: pausada, code named, throw, no recipient touched`, async () => {
      const w = five();
      const h = harness(w, { env: READY, answers: [answer] });
      assert.match(String((await h.tick()).message), /paused/);
      const code = answer.body.error?.code ?? 'chassis_503';
      assert.equal(w.db.campanas[0].estado, 'pausada');
      assert.equal(w.db.campanas[0].informe.pausa.code, code);
      assert.ok(h.notes[0].includes(code));
      assert.deepEqual(states(w), ['pending', 'pending', 'pending', 'pending', 'pending']);
      assert.equal(w.db.campanas[0].informe.excluidos.length, 0);
    });
  }
  for (const answer of [{ status: 502, body: { error: 'send failed', detail: 'x' } }, { status: 500, body: { error: 'internal error' } }]) {
    it(`email ${answer.status} may have left: uncertain, then doubtful, one chassis call across three ticks`, async () => {
      const w = world({ campanas: [campaign()] });
      const h = harness(w, { answers: [answer] });
      assert.match(String((await h.tick()).message), /stopped on ambiguous/);
      assert.deepEqual(states(w), ['uncertain']);
      assert.match(String((await h.tick()).message), /paused: nothing_sent/);
      assert.deepEqual(states(w), ['doubtful']);
      await h.tick();
      assert.equal(h.calls.length, 1);
      assert.deepEqual(w.db.campanas[0].informe.revision_humana, [T]);
    });
  }
  it('WhatsApp provider_unavailable leaves an error row that proves nothing: doubtful, never resent', async () => {
    const w = world({ campanas: [campaign({ plantilla: 'pwhats000000001' })] });
    const h = harness(w, { answers: [{ status: 502, body: { ok: false, envio_id: 'e1', estado: 'error', error: { code: 'provider_unavailable' } } }] });
    await h.tick();
    w.db.envios.push({ id: 'e1', lead: T, campana: 'camp00000000001', estado: 'error', error_codigo: 'provider_unavailable' });
    await h.tick();
    assert.deepEqual([states(w), h.calls.length], [['doubtful'], 1]);
  });
  it('a gateway 502 page may follow a send: uncertain, not re-sent; a refused connection is infra', async () => {
    const w = world({ campanas: [campaign()] });
    const h = harness(w, { answers: [{ status: 502, body: '<html>Bad Gateway</html>' }] });
    assert.match(String((await h.tick()).message), /stopped on ambiguous http_502/);
    assert.deepEqual(states(w), ['uncertain']);
    const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const w2 = world({ campanas: [campaign()] });
    const h2 = harness(w2, { answers: [refused] });
    assert.match(String((await h2.tick()).message), /stopped on infra chassis_refused_connection/);
    assert.deepEqual(states(w2), ['pending']);
  });
  it('a lead refused by number before any send is deferred, then excluded once someone was reached', async () => {
    const two = REAL.slice(0, 2);
    const w = world({ campanas: [campaign({ segmento: { v: 1, ids: two } }), { id: 'cu1500000000001', nombre: 'CU-15', estado: 'completada' }] });
    const bad = { status: 502, body: { ok: false, error: { code: '21211' } } };
    const h = harness(w, { env: READY, answers: [bad, { status: 200, body: { ok: true } }, bad], ledger: true });
    await h.tick();
    assert.deepEqual(states(w), ['deferred', 'sent']);
    assert.equal(w.db.campanas[0].estado, 'en_curso');
    await h.tick();
    assert.deepEqual(states(w), ['excluded', 'sent']);
    assert.deepEqual([w.db.campanas[0].estado, h.calls.map((c) => c.body.lead_id)], ['completada', [two[0], two[1], two[0]]]);
  });
  it('the lease is wall-clock time, not ctx.now', async () => {
    const informe = (until) => ({ v: 1, alcanzados: 0, intentados_ids: [], excluidos: [], revision_humana: [], infra_streak: 0, lease: { run: 'x', until }, recipients: { [T]: { state: 'pending' } } });
    const stale = world({ campanas: [campaign({ estado: 'en_curso', informe: informe(new Date(NOW.getTime() + 60_000).toISOString()) })] });
    await harness(stale, { ledger: true }).tick();
    assert.equal(stale.db.campanas[0].estado, 'completada');
    const live = world({ campanas: [campaign({ estado: 'en_curso', informe: informe(new Date(Date.now() + 60_000).toISOString()) })] });
    assert.match(String(await harness(live).tick()), /leased until/);
    assert.equal(live.writes.length, 0);
  });
  it('a claimed recipient found at tick start is not re-sent', async () => {
    const w = world({ campanas: [campaign({ estado: 'en_curso', informe: { v: 1, alcanzados: 0, intentados_ids: [T], excluidos: [], revision_humana: [], infra_streak: 0, recipients: { [T]: { state: 'claimed', at: NOW.toISOString() } } } })] });
    const h = harness(w);
    await h.tick();
    assert.deepEqual([states(w), h.calls.length], [['doubtful'], 0]);
  });
});

describe('the rehearsal path, end to end', () => {
  it('sends once, completes from the ledger, event before row, informe v1 the gate can check', async () => {
    const w = world({ campanas: [campaign()] });
    const h = harness(w, { ledger: true });
    const order = [];
    const update = w.pb.collection('campanas').update;
    w.pb.collection = ((orig) => (name) => ({ ...orig(name), update: async (id, b) => { if (b.estado === 'completada') order.push('row'); return update(id, b); } }))(w.pb.collection);
    const event = h.ctx.event;
    h.ctx.event = async (type, p) => { if (type === 'campana.completada') order.push('event'); return event(type, p); };
    assert.match(String(await h.tick()), /completada, 1 reached/);
    assert.deepEqual(h.calls[0].body, { lead_id: T, plantilla: 'consentimiento.baja.email', variables: { agencia: 'Agencia Test' }, campana_id: 'camp00000000001' });
    assert.ok(h.calls[0].url.includes('/send-email?'));
    const c = w.db.campanas[0];
    assert.equal(c.estado, 'completada');
    assert.deepEqual(order, ['event', 'row']);
    assert.deepEqual([c.informe.v, c.informe.alcanzados, c.informe.intentados_ids], [1, 1, [T]]);
    assert.ok(c.informe.completada_en);
    assert.equal(c.informe.lease, undefined);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.events.find((e) => e.type === 'campana.informe').payload.whatsapp, 'not_configured');
  });
  it('the chassis ignoring campana_id leaves no ledger row: pause, never a completada that reached nobody', async () => {
    const w = world({ campanas: [campaign()] });
    const h = harness(w);
    assert.match(String((await h.tick()).message), /paused: ledger_empty/);
    assert.equal(h.calls.length, 1);
  });
  it('the manager report goes over WhatsApp without campana_id when configured', async () => {
    const w = world({ campanas: [campaign({ estado: 'en_curso', informe: { v: 1, alcanzados: 1, intentados_ids: [T], excluidos: [], revision_humana: [], infra_streak: 0, recipients: { [T]: { state: 'sent', at: NOW.toISOString() } } } })], envios: [{ lead: T, campana: 'camp00000000001', estado: 'entregado' }] });
    const h = harness(w, { env: { ...ENV, CAMPAIGN_REPORT_LEAD_ID: T } });
    await h.tick();
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].url.includes('/send-whatsapp?'));
    assert.equal('campana_id' in h.calls[0].body, false);
    assert.equal(h.calls[0].body.plantilla, 'campana.informe');
  });
  it('missing agencia pauses naming it, before any send', async () => {
    const w = world({ campanas: [campaign()], settings: [] });
    const h = harness(w);
    assert.match(String((await h.tick()).message), /variables_missing/);
    assert.ok(w.db.campanas[0].informe.pausa.reason.includes('agencia'));
    assert.equal(h.calls.length, 0);
  });
  it('an empty or invalid segment pauses; nothing before inicio or outside hours', async () => {
    for (const segmento of [{ v: 1, ids: ['zzzzzzzzzzzzzzz'] }, { v: 1 }]) {
      const w = world({ campanas: [campaign({ segmento })] });
      assert.match(String((await harness(w).tick()).message), /paused: segment_(empty|invalid)/);
    }
    for (const over of [{ inicio: '2026-09-24 00:00:00.000Z' }, { hora_desde: '13:00' }]) {
      const w = world({ campanas: [campaign(over)] });
      const h = harness(w);
      assert.equal(typeof (await h.tick()), 'string');
      assert.deepEqual([w.writes.length, h.calls.length], [0, 0]);
    }
  });
  it('a sent consent request leaves lead.consent_requested with the WhatsApp service\'s shape', async () => {
    const w = world({ campanas: [campaign({ plantilla: 'pwhats000000001' })] });
    const h = harness(w);
    await h.tick();
    const e = h.events.find((x) => x.type === 'lead.consent_requested');
    assert.deepEqual(e.payload, { project_id: 14, via: 'campaign', lead_id: T, text: 'Hola N 1dl, somos Agencia Test.', campana_id: 'camp00000000001' });
    assert.ok(h.events.some((x) => x.type === 'campana.lote'));
  });
});
