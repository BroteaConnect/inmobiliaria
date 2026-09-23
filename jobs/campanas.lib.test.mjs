// campanas.lib.test.mjs — the campaign rules, one by one. Run: node --test jobs/
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUARDED_STREAK_PAUSE, INFRA_STREAK_PAUSE, MAX_PER_TICK, SENT_ESTADOS, TEST_LEAD_IDS, applyOutcome, catalogProblems,
  claim, closeDecision, excludeLead, freeze, guard, insideHours, matches, parseSegment, pausedInforme, quota,
  reachedFromLedger, reconcile, resolveVariables, seedPlan, sendQueue, settleClaims, started,
} from './campanas.lib.mjs';
import { classifyRefusal } from './refusals.lib.mjs';

const NOW = new Date('2026-09-23T10:00:00.000Z'); // 12:00 Madrid (CEST)
const T = TEST_LEAD_IDS[0];
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const verdict = (code, status = 403) => ({ verdict: classifyRefusal({ code, status }) });

describe('segment v1', () => {
  it('rejects every shape that could be read as "everybody"', () => {
    for (const seg of [null, {}, [], 'x', { v: 2, ids: [T] }, { ids: [T] }, { v: 1 }, { v: 1, zona: ['x'] },
      { v: 1, etapa: 'nuevo' }, { v: 1, ids: [] }, { v: 1, ids: ['../x'] }, { v: 1, consentimiento: 'true' }, { v: 1, idioma: 'fr' }]) {
      assert.ok(parseSegment(seg).error, JSON.stringify(seg));
    }
  });
  it('ids selects exactly those leads; other criteria are ANDed', () => {
    const leads = [{ id: T }, { id: 'aaaaaaaaaaaaaaa' }, { id: 'bbbbbbbbbbbbbbb', origen: 'histórico', consentimiento: false }];
    const { criteria } = parseSegment({ v: 1, ids: [T] });
    assert.deepEqual(leads.filter((l) => matches(criteria, l)).map((l) => l.id), [T]);
    const hist = parseSegment({ v: 1, origen: ['histórico'], consentimiento: false }).criteria;
    assert.deepEqual(leads.filter((l) => matches(hist, l)).map((l) => l.id), ['bbbbbbbbbbbbbbb']);
  });
});

describe('guards', () => {
  const cu = { id: 'cu15aaaaaaaaaaa', nombre: 'Consentimiento CU-15' };
  it('CU-15 needs its own id in CU15_OWNER_YES and CAMPAIGN_SENDER_READY=1', () => {
    for (const env of [{}, { CAMPAIGN_SENDER_READY: '1' }, { CU15_OWNER_YES: cu.id }, { CU15_OWNER_YES: 'other', CAMPAIGN_SENDER_READY: '1' }]) {
      assert.equal(guard(cu, null, env, null)?.code, 'cu15_not_authorised');
    }
    assert.equal(guard(cu, ['x'], { CU15_OWNER_YES: cu.id, CAMPAIGN_SENDER_READY: '1' }, null), null);
  });
  it('without the sender flag only test leads; with it, real leads also need CU-15 completada', () => {
    const row = { id: 'r', nombre: 'Ensayo' };
    assert.equal(guard(row, [T], {}, null), null);
    assert.equal(guard(row, [T, 'real'], {}, null).code, 'sender_not_ready');
    assert.equal(guard(row, ['real'], { CAMPAIGN_SENDER_READY: '1' }, { estado: 'borrador' }).code, 'cu15_not_completed');
    assert.equal(guard(row, ['real'], { CAMPAIGN_SENDER_READY: '1' }, { estado: 'completada' }), null);
  });
});

describe('cadence', () => {
  const row = { hora_desde: '09:00', hora_hasta: '20:00' };
  it('Madrid hours across DST, hora_hasta exclusive', () => {
    assert.equal(insideHours(row, new Date('2026-03-28T08:30:00Z')), true); // 09:30 CET
    assert.equal(insideHours(row, new Date('2026-03-30T06:30:00Z')), false); // 08:30 CEST
    assert.equal(insideHours(row, new Date('2026-03-30T07:30:00Z')), true); // 09:30 CEST
    assert.equal(insideHours(row, new Date('2026-09-23T18:00:00Z')), false); // 20:00
    assert.equal(insideHours(row, new Date('2026-09-23T17:59:00Z')), true); // 19:59
    assert.equal(insideHours({ hora_desde: '20:00', hora_hasta: '09:00' }, NOW), null);
    assert.equal(insideHours({}, NOW), null);
  });
  it('nothing before inicio', () => {
    assert.equal(started({ inicio: '2026-09-24 08:00:00.000Z' }, NOW), false);
    assert.equal(started({ inicio: '2026-09-23 08:00:00.000Z' }, NOW), true);
    assert.equal(started({ inicio: '' }, NOW), true);
  });
  it('interval credits: intervalo_min 0/15/90 against 60/120 minutes elapsed, capped at MAX_PER_TICK', () => {
    const inf = freeze([]);
    const q = (every, mins) => quota({ lote_diario: 100, intervalo_min: every, ultimo_envio_en: hoursAgo(mins / 60) }, inf, NOW);
    assert.deepEqual([q(0, 60), q(15, 60), q(15, 120), q(90, 60), q(90, 120)], [MAX_PER_TICK, 4, 8, 0, 1]);
  });
  it('lote_diario counts what may have left today (Madrid day), not yesterday', () => {
    const inf = freeze(['a', 'b', 'c', 'd']);
    inf.recipients.a = { state: 'sent', at: hoursAgo(1) };
    inf.recipients.b = { state: 'uncertain', at: hoursAgo(2) };
    inf.recipients.c = { state: 'sent', at: hoursAgo(30) };
    assert.equal(quota({ lote_diario: 3 }, inf, NOW), 1);
  });
});

describe('outcomes: an unknown refusal is infrastructure, never a person', () => {
  it('unknown code at every chassis status: pending, streak 1, stop; the third is a pause, nobody excluded', () => {
    for (const status of [400, 401, 403, 404, 422, 451, 500, 502, 503]) {
      let inf = claim(freeze(['a', 'b']), 'a', NOW);
      const r1 = applyOutcome(inf, 'a', verdict('nunca_visto', status), NOW);
      assert.deepEqual([r1.action, r1.informe.recipients.a.state, r1.informe.infra_streak], ['stop', 'pending', 1]);
      inf = r1.informe;
      for (let i = 2; i <= INFRA_STREAK_PAUSE; i++) inf = applyOutcome(claim(inf, 'a', NOW), 'a', verdict('nunca_visto', status), NOW).informe;
      assert.equal(inf.infra_streak, INFRA_STREAK_PAUSE);
      assert.equal(inf.excluidos.length, 0);
    }
    const third = applyOutcome({ ...claim(freeze(['a']), 'a', NOW), infra_streak: 2 }, 'a', verdict('x'), NOW);
    assert.equal(third.action, 'pause');
  });
  it('a run code pauses and touches nobody; a sent resets the streak', () => {
    const r = applyOutcome(claim(freeze(['a']), 'a', NOW), 'a', verdict('auth_not_configured', 503), NOW);
    assert.deepEqual([r.action, r.verdict.code, r.informe.recipients.a.state], ['pause', 'auth_not_configured', 'pending']);
    const s = applyOutcome({ ...claim(freeze(['a']), 'a', NOW), infra_streak: 2 }, 'a', { sent: true, envio_id: null }, NOW);
    assert.deepEqual([s.informe.recipients.a.state, s.informe.infra_streak], ['sent', 0]);
  });
  it('a guarded lead code before anything was sent defers that lead; only a run of them pauses', () => {
    let inf = freeze(['a', 'b', 'c', 'd']);
    const actions = [];
    for (const id of ['a', 'b', 'c']) {
      const r = applyOutcome(claim(inf, id, NOW), id, verdict('21211', 502), NOW);
      actions.push(r.action);
      inf = r.informe;
    }
    assert.equal(GUARDED_STREAK_PAUSE, 3);
    assert.deepEqual(actions, ['continue', 'continue', 'pause']);
    assert.deepEqual([inf.recipients.a.state, inf.excluidos.length], ['deferred', 0]);
    assert.deepEqual(sendQueue(inf, 10), ['d', 'a', 'b', 'c']); // deferred go after every pending
    assert.equal(closeDecision(inf), 'open');
    // A human resume gets fresh streaks and does not pause on the same lead again.
    const resumed = pausedInforme(inf, '21211', 'x', NOW);
    assert.deepEqual([resumed.guarded_streak, resumed.infra_streak, resumed.lease], [0, 0, undefined]);
  });
  it('once something was sent, a deferred lead retried on the same code is excluded by the normal rule', () => {
    let inf = applyOutcome(claim(freeze(['a', 'b']), 'a', NOW), 'a', verdict('21211', 502), NOW).informe;
    inf = applyOutcome(claim(inf, 'b', NOW), 'b', { sent: true }, NOW).informe;
    assert.equal(inf.guarded_streak, 0);
    const e = applyOutcome(claim(inf, 'a', NOW), 'a', verdict('21211', 502), NOW);
    assert.deepEqual([e.action, e.informe.recipients.a.state, e.informe.excluidos[0].code], ['continue', 'excluded', '21211']);
  });
  it('no_email excludes from this campaign on the channel, and never writes consent', () => {
    const r = applyOutcome(claim(freeze(['a']), 'a', NOW), 'a', verdict('no_email', 400), NOW);
    assert.deepEqual([r.informe.recipients.a.state, r.informe.excluidos[0].scope], ['excluded', 'channel']);
    assert.equal(JSON.stringify(r.informe).includes('consentimiento'), false);
  });
  it('excludeLead refuses anything mayExcludeLead refuses', () => {
    for (const code of ['nunca_visto', 'forbidden', 'provider_unavailable', '63016']) {
      assert.throws(() => excludeLead(freeze(['a']), 'a', classifyRefusal({ code })));
    }
  });
  it('ambiguous answers become uncertain and stop the tick', () => {
    const r = applyOutcome(claim(freeze(['a']), 'a', NOW), 'a', { verdict: classifyRefusal({ code: 'chassis_502', status: 502 }) }, NOW);
    assert.deepEqual([r.action, r.informe.recipients.a.state], ['stop', 'uncertain']);
  });
});

describe('reconciliation against the ledger', () => {
  const r = { state: 'uncertain', at: hoursAgo(1) };
  it('no row: WhatsApp never reached the provider (once it cannot be mid-request), email proves nothing', () => {
    assert.deepEqual(reconcile(r, [], 'whatsapp', NOW), { state: 'pending' });
    assert.deepEqual(reconcile({ state: 'uncertain', at: new Date(NOW - 30_000).toISOString() }, [], 'whatsapp', NOW), { state: 'uncertain' });
    assert.deepEqual(reconcile(r, [], 'email', NOW), { state: 'doubtful' });
  });
  it('email: any row means it left — a bounce is doubtful, never pending, never classified', () => {
    for (const error_codigo of ['hard_bounce', 'soft_bounce', 'blocked', 'spam', 'invalid_email', '21211', 'nunca_visto']) {
      assert.deepEqual(reconcile(r, [{ estado: 'error', error_codigo }], 'email', NOW), { state: 'doubtful' }, error_codigo);
    }
    assert.deepEqual(reconcile(r, [{ estado: 'registrado' }], 'email', NOW), { state: 'doubtful' });
    assert.deepEqual(reconcile(r, [{ estado: 'error' }, { estado: 'entregado' }], 'email', NOW), { sent: true });
  });
  it('registrado stays uncertain for 24 h, then doubtful; a sent row is sent', () => {
    assert.deepEqual(reconcile(r, [{ estado: 'registrado' }], 'whatsapp', NOW), { state: 'uncertain' });
    assert.deepEqual(reconcile({ ...r, at: hoursAgo(24) }, [{ estado: 'registrado' }], 'whatsapp', NOW), { state: 'doubtful' });
    assert.deepEqual(reconcile(r, [{ estado: 'error' }, { estado: 'enviado' }], 'email', NOW), { sent: true });
  });
  it('an error row is classified by its code; provider_unavailable is the one that proves nothing', () => {
    assert.equal(reconcile(r, [{ estado: 'error', error_codigo: '63016' }], 'whatsapp', NOW).verdict.bucket, 'run');
    assert.equal(reconcile(r, [{ estado: 'error', error_codigo: '21211' }], 'whatsapp', NOW).verdict.bucket, 'lead');
    assert.equal(reconcile(r, [{ estado: 'error', error_codigo: 'desconocido' }], 'whatsapp', NOW).verdict.bucket, 'infra');
    assert.deepEqual(reconcile(r, [{ estado: 'error', error_codigo: 'provider_unavailable' }], 'whatsapp', NOW), { state: 'doubtful' });
    assert.deepEqual(reconcile(r, [{ estado: 'simulado' }], 'whatsapp', NOW), { state: 'doubtful' });
  });
  it('a claimed recipient found at tick start is uncertain, never pending', () => {
    assert.equal(settleClaims(claim(freeze(['a']), 'a', NOW)).recipients.a.state, 'uncertain');
  });
  it('adoption: only enviado|entregado|abierto|click reach anyone, counted by distinct lead', () => {
    const all = ['registrado', 'enviado', 'entregado', 'abierto', 'click', 'error', 'simulado', ''];
    for (const estado of all) {
      assert.equal(reachedFromLedger([{ lead: 'a', estado }]), SENT_ESTADOS.includes(estado) ? 1 : 0, estado || 'empty');
    }
    for (const error_codigo of ['21211', 'provider_unavailable', 'unknown']) {
      assert.equal(reachedFromLedger([{ lead: 'a', estado: 'error', error_codigo }]), 0);
    }
    assert.equal(reachedFromLedger([{ lead: 'a', estado: 'enviado' }, { lead: 'a', estado: 'click' }, { lead: 'b', estado: 'error' }]), 1);
  });
});

describe('close', () => {
  it('open while anyone is owed; nothing_sent when all finished with no send; complete otherwise', () => {
    const inf = freeze(['a', 'b']);
    assert.equal(closeDecision(inf), 'open');
    inf.recipients.a.state = 'doubtful';
    inf.recipients.b.state = 'excluded';
    assert.equal(closeDecision(inf), 'nothing_sent');
    inf.recipients.b.state = 'sent';
    assert.equal(closeDecision(inf), 'complete');
  });
});

describe('variables', () => {
  it('nombre and links are the chassis\'s, agencia is negocio.razonSocial, anything else is missing', () => {
    const p = { variables: ['nombre', 'agencia', 'baja_url', 'si_url'] };
    assert.deepEqual(resolveVariables(p, {}), { values: {}, missing: ['agencia'] });
    assert.deepEqual(resolveVariables(p, { 'negocio.razonSocial': { v: 1, text: '  ' } }).missing, ['agencia']);
    assert.deepEqual(resolveVariables(p, { 'negocio.razonSocial': { v: 1, text: 'Agencia X' } }), { values: { agencia: 'Agencia X' }, missing: [] });
    assert.deepEqual(resolveVariables({ variables: ['nombre', 'url'] }, {}).missing, ['url']);
  });
});

describe('seed plan', () => {
  const cat = [{ nombre: 'Consentimiento CU-15' }, { nombre: 'Ensayo' }];
  it('creates what is missing, keeps what exists by nombre, never patches', () => {
    assert.deepEqual(seedPlan(cat, []).map((p) => p.action), ['create', 'create']);
    assert.deepEqual(seedPlan(cat, [{ nombre: 'Ensayo' }, { nombre: 'Consentimiento CU-15' }]).map((p) => p.action), ['keep', 'keep']);
  });
  it('refuses to create a CU-15 while ANY existing row carries the marker', () => {
    const plan = seedPlan(cat, [{ nombre: 'cu-15 renombrada a mano' }]);
    assert.deepEqual(plan.map((p) => p.action), ['refuse', 'create']);
  });
});

describe('seed catalog (pb/campanas.json)', () => {
  const rows = JSON.parse(readFileSync(new URL('../pb/campanas.json', import.meta.url), 'utf8'));
  it('passes catalogProblems: one CU-15 in borrador, the rehearsal is not CU-15 and only reaches test leads', () => {
    assert.deepEqual(catalogProblems(rows), []);
    assert.equal(rows.filter((r) => /cu-15/i.test(r.nombre)).length, 1);
    const rehearsal = rows.find((r) => !/cu-15/i.test(r.nombre));
    assert.deepEqual(rehearsal.segmento, { v: 1, ids: TEST_LEAD_IDS });
  });
  it('refuses a second CU-15, a real-recipient row and an invalid segment', () => {
    assert.ok(catalogProblems([...rows, { ...rows[0], nombre: 'Otra CU-15' }]).length);
    assert.ok(catalogProblems(rows.map((r) => ({ ...r, segmento: { v: 1, etapa: ['nuevo'] } }))).length);
    assert.ok(catalogProblems(rows.map((r) => ({ ...r, segmento: { v: 1 } }))).length);
  });
});
