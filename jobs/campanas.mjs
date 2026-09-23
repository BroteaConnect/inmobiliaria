// campanas.mjs — hourly: advances every campaign in `programada` or `en_curso`
// by at most one batch. I/O only; every rule lives in campanas.lib.mjs.
//
// Safety, in the order it is enforced:
//   · `borrador`, `pausada`, `completada`, `cancelada` are never touched: only a
//     human moves a campaign out of borrador or pausada.
//   · guards run before any write and a refused guard writes nothing and emits
//     no campana.* event (the E5 gate reads those): CU-15 needs the owner's yes
//     (CU15_OWNER_YES = its id) and CAMPAIGN_SENDER_READY=1; without that flag
//     only TEST_LEAD_IDS may be recipients — checked again at the send site.
//   · every PocketBase write goes through write(), which is a no-op under
//     ctx.dryRun (ctx.pb is a LIVE superuser client even then); the chassis is
//     never called in a dry run.
//   · a tick that pauses, refuses or stops on a fault ends in a throw: a job
//     that stopped working must never look like a job with nothing to do.
//   · OUTBOUND_SECRET never reaches a log, an event or an error (scrub()).
import {
  ACTIVE_ESTADOS, CHASSIS_TIMEOUT_MS, CONSENT_TEMPLATE, COPY, CU15, PROJECT_ID, SENT_ESTADOS, TEST_LEAD_IDS,
  applyOutcome, claim, closeDecision, escapeHtml, freeze, guard, insideHours, matches, parseSegment,
  pausedInforme, quota, reachedFromLedger, reconcile, render, resolveVariables, sendQueue, settleClaims, started,
} from './campanas.lib.mjs';
import { answerCode, classifyRefusal } from './refusals.lib.mjs';

export const when = { hourly: true };

const LEASE_MS = 10 * 60_000;
const RECORD_ID = /^[a-z0-9]+$/;

const scrubber = (secret) => (s) => (secret
  ? String(s).replaceAll(secret, '[secret]').replaceAll(encodeURIComponent(secret), '[secret]')
  : String(s));

/** One POST to the chassis. Server-side auth: the secret in the query, no Authorization, no Origin. */
async function callChassis(env, canal, payload, fetchImpl) {
  const scrub = scrubber(env.OUTBOUND_SECRET);
  const url = `${String(env.CHASSIS_URL).replace(/\/+$/, '')}/send-${canal}?secret=${encodeURIComponent(env.OUTBOUND_SECRET)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(CHASSIS_TIMEOUT_MS),
    });
  } catch (e) {
    // No connection at all proves nothing left: infra, retried. Anything else
    // (a timeout, a reset mid-request) may have followed a send.
    const refused = { ECONNREFUSED: 'chassis_refused_connection', ENOTFOUND: 'chassis_host_not_found' }[e?.cause?.code];
    if (refused) return { verdict: classifyRefusal({ code: refused }) };
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { verdict: classifyRefusal({ code: timedOut ? 'chassis_timeout' : 'chassis_unreachable', answered: false }) };
  }
  const raw = scrub(await res.text().catch(() => ''));
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  if (res.status === 200 && body?.ok === true) return { sent: true, envio_id: body.envio_id ?? null };
  return { verdict: classifyRefusal({ code: answerCode(res.status, body), status: res.status }) };
}

/** The only door to the chassis. */
async function send(ctx, canal, payload) {
  if (ctx.dryRun) throw new Error('a dry run must never reach the chassis');
  if (ctx.env.CAMPAIGN_SENDER_READY !== '1' && !TEST_LEAD_IDS.includes(payload.lead_id)) {
    throw new Error(`refusing to send to ${payload.lead_id}: not a test lead and CAMPAIGN_SENDER_READY is not set`);
  }
  return callChassis(ctx.env, canal, payload, ctx.fetch ?? globalThis.fetch);
}

export async function run(ctx) {
  const { pb, log } = ctx;
  if (!pb) throw new Error('campanas: this project has no PocketBase client');
  const scrub = scrubber(ctx.env?.OUTBOUND_SECRET);
  const rows = await pb.collection('campanas').getFullList();
  const cu15 = rows.filter((r) => CU15.test(String(r.nombre ?? '')));
  const active = rows.filter((r) => ACTIVE_ESTADOS.includes(r.estado));
  log(`campanas: ${rows.length} campaign(s), ${active.length} active`);
  const done = [];
  const failed = [];
  for (const row of active) {
    try {
      done.push(`${row.id} ${await tick(ctx, row, cu15.length === 1 ? cu15[0] : null)}`);
    } catch (e) {
      const why = scrub(e?.message ?? e);
      log(`campanas: ${row.id}: ${why}`);
      failed.push(`${row.id}: ${why}`);
    }
  }
  if (failed.length) throw new Error(failed.join('; '));
  return active.length ? done.join('; ') : 'no active campaign';
}

async function tick(ctx, row, cu15Row) {
  const { pb, env, now, dryRun } = ctx;
  const say = (m) => ctx.log(`campanas: ${row.id}: ${m}`);
  if (!RECORD_ID.test(String(row.id))) throw new Error('not a record id');
  const write = async (body) => {
    if (dryRun) return say(`dry-run: would update ${Object.keys(body).join(', ')}`);
    return pb.collection('campanas').update(row.id, body);
  };
  const refuse = (g) => { throw new Error(`guard ${g.code}: ${g.reason}`); };
  const pause = async (code, reason, inf) => {
    const informe = pausedInforme(inf, code, reason, now);
    await write({ estado: 'pausada', informe });
    await ctx.event('campana.pausada', { campana_id: row.id, code });
    await ctx.notify(COPY.paused(escapeHtml(row.nombre), escapeHtml(code), escapeHtml(reason)));
    throw new Error(`paused: ${code}`);
  };

  // 1. The CU-15 guard needs nothing but the row: it runs before anything is read.
  const early = guard(row, null, env, cu15Row);
  if (early) refuse(early);
  if (!started(row, now)) return 'before inicio';

  // 2. Recipients: frozen in the informe, or read from the segment now.
  let informe = row.informe?.v === 1 && row.informe.recipients ? row.informe : null;
  let ids;
  if (informe) {
    ids = Object.keys(informe.recipients);
  } else {
    const seg = parseSegment(row.segmento);
    if (seg.error) return pause('segment_invalid', `${COPY.segment_invalid} (${seg.error})`);
    const leads = await pb.collection('leads').getFullList();
    ids = leads.filter((l) => matches(seg.criteria, l)).map((l) => l.id);
    if (!ids.length) return pause('segment_empty', COPY.segment_empty);
  }
  const g = guard(row, ids, env, cu15Row);
  if (g) refuse(g);

  // 3. Preflight: what would make every send fail the same way.
  if (!env.CHASSIS_URL || !env.OUTBOUND_SECRET) return pause('chassis_not_configured', COPY.chassis_not_configured, informe);
  const template = row.plantilla ? await pb.collection('plantillas').getOne(row.plantilla) : null;
  if (!template || template.estado === 'retirada' || !['email', 'whatsapp'].includes(template.canal)) {
    return pause('template_missing', COPY.template_missing, informe);
  }
  const settings = await pb.collection('settings').getFullList({ filter: 'key ~ "negocio."' });
  const { values, missing } = resolveVariables(template, Object.fromEntries(settings.map((s) => [s.key, s.value])));
  if (missing.length) return pause('variables_missing', COPY.variables_missing + missing.join(', '), informe);
  const hours = insideHours(row, now);
  if (hours === null) return pause('hours_invalid', COPY.hours_invalid, informe);
  if (!(Number(row.lote_diario) >= 1)) return pause('lote_invalid', COPY.lote_invalid, informe);
  if (!hours) return 'outside sending hours';

  // 4. Freeze and lease: one run at a time works on one campaign.
  // The lease is wall-clock time (Date.now), never ctx.now: two runs started
  // at different moments must agree on when it expires.
  if (informe?.lease && new Date(informe.lease.until).getTime() > Date.now()) return `leased until ${informe.lease.until}`;
  const runId = `${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
  informe = { ...settleClaims(informe ?? freeze(ids)), lease: { run: runId, until: new Date(Date.now() + LEASE_MS).toISOString() } };
  await write({ estado: 'en_curso', informe });
  if (!dryRun && (await pb.collection('campanas').getOne(row.id)).informe?.lease?.run !== runId) return 'lost the lease';
  const release = async () => { delete informe.lease; await write({ informe }); };

  // 5. Settle the uncertain against the ledger.
  const uncertain = Object.entries(informe.recipients).filter(([, r]) => r.state === 'uncertain');
  if (uncertain.length) {
    const envios = await pb.collection('envios').getFullList({ filter: `campana = "${row.id}"` });
    for (const [id, r] of uncertain) {
      const res = applyOutcome(informe, id, reconcile(r, envios.filter((e) => e.lead === id), template.canal, now), now);
      informe = res.informe;
      if (res.action === 'pause') return pause(res.verdict.code, res.verdict.reason, informe);
    }
    await write({ informe });
  }

  // 6. The batch.
  const n = quota(row, informe, now);
  const queue = sendQueue(informe, n);
  let sent = 0;
  let halt = null;
  for (const id of queue) {
    if (dryRun) { say(`dry-run: would send ${template.clave} to ${id}`); continue; }
    informe = claim(informe, id, now);
    await write({ informe });
    const outcome = await send(ctx, template.canal, { lead_id: id, plantilla: template.clave, variables: values, campana_id: row.id });
    const res = applyOutcome(informe, id, outcome, now);
    informe = res.informe;
    informe.alcanzados = Object.values(informe.recipients).filter((r) => r.state === 'sent').length;
    await write({ informe, ...(outcome.sent ? { ultimo_envio_en: now.toISOString() } : {}) });
    if (outcome.sent) {
      sent++;
      if (template.clave === CONSENT_TEMPLATE) await consentRequested(ctx, row, template, values, id);
    }
    if (res.action !== 'continue') { halt = res; break; }
  }
  if (sent) await ctx.event('campana.lote', { campana_id: row.id, enviados: sent });
  if (halt?.action === 'pause') return pause(halt.verdict.code, halt.verdict.reason, informe);
  if (halt) {
    await release();
    throw new Error(`stopped on ${halt.verdict.bucket} ${halt.verdict.code}: ${halt.verdict.reason}`);
  }

  // 7. Close.
  const decision = closeDecision(informe);
  if (decision === 'nothing_sent') return pause('nothing_sent', COPY.nothing_sent, informe);
  if (decision === 'open') {
    await release();
    return `${sent} sent, ${queue.length - sent} not sent this tick${dryRun ? ' (dry-run)' : ''}`;
  }
  const envios = await pb.collection('envios').getFullList({ filter: `campana = "${row.id}"` });
  const alcanzados = reachedFromLedger(envios);
  if (!alcanzados) return pause('ledger_empty', COPY.ledger_empty, informe);
  const final = { ...informe, alcanzados, completada_en: now.toISOString() };
  delete final.lease;
  delete final.pausa;
  await ctx.event('campana.completada', { campana_id: row.id, informe: final });
  await write({ estado: 'completada', informe: final });
  const recs = Object.values(final.recipients);
  await ctx.notify(COPY.completed(escapeHtml(row.nombre), {
    alcanzados, excluidos: final.excluidos.length, dudosos: recs.filter((r) => r.state === 'doubtful').length,
  }));
  const whatsapp = await managerReport(ctx, row, final, envios);
  await ctx.event('campana.informe', { campana_id: row.id, telegram: 'sent', whatsapp });
  return `completada, ${alcanzados} reached`;
}

/** lead.consent_requested with the WhatsApp service's payload shape, so a later yes can be tied to it. */
async function consentRequested(ctx, row, template, values, leadId) {
  const lead = await ctx.pb.collection('leads').getOne(leadId);
  const body = lead.idioma === 'en' ? template.cuerpo_en : template.cuerpo_es;
  const text = render(body, { nombre: lead.nombre ?? '', ...values });
  await ctx.event('lead.consent_requested', { project_id: PROJECT_ID, via: 'campaign', lead_id: leadId, text, campana_id: row.id });
}

/** The manager's WhatsApp report. Never fails the campaign; says what happened. */
async function managerReport(ctx, row, final, envios) {
  const leadId = ctx.env.CAMPAIGN_REPORT_LEAD_ID;
  if (!leadId) return 'not_configured';
  const distinct = (pred) => new Set(envios.filter(pred).map((e) => e.lead)).size;
  try {
    const out = await send(ctx, 'whatsapp', {
      lead_id: leadId, plantilla: 'campana.informe',
      variables: {
        campana: String(row.nombre).slice(0, 60),
        enviados: String(final.alcanzados),
        entregados: String(distinct((e) => SENT_ESTADOS.slice(1).includes(e.estado))),
        respuestas: '-',
        bajas: String(final.excluidos.filter((x) => x.scope === 'permanent').length),
        errores: String(final.excluidos.length - final.excluidos.filter((x) => x.scope === 'permanent').length),
      },
    });
    return out.sent ? 'sent' : out.verdict.code;
  } catch (e) {
    ctx.log(`campanas: ${row.id}: manager report not sent: ${scrubber(ctx.env.OUTBOUND_SECRET)(e?.message ?? e)}`);
    return 'failed';
  }
}
