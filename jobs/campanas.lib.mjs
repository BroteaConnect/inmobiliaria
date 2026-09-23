// campanas.lib.mjs — the rules of the campaign runner (jobs/campanas.mjs).
// Pure: no I/O, no PocketBase, no clock of its own (`now` is passed in).
// Tested in jobs/campanas.lib.test.mjs; the refusal taxonomy lives in
// refusals.lib.mjs and is only ever consulted, never extended, from here.
//
// One campaign's state is its `campanas.informe` (v1). Each recipient moves
//   pending → claimed (written BEFORE the chassis call) → sent | excluded |
//   pending (run/infra fault) | uncertain (the message may have left)
// and an uncertain one is settled against the `envios` ledger on a later tick:
// sent, back to pending, or doubtful (never retried, never excluded).
// Terminal: sent, excluded, doubtful. `deferred` (a provider number code
// before anything was sent) is retried after every pending recipient.
import { classifyRefusal, mayExcludeLead } from './refusals.lib.mjs';
import { diaMadrid, horaMadrid, parseFecha } from './lib.mjs';

// The owner's own test lead (consent true, reachable by email). The ONLY
// recipient a campaign may have until an operator sets CAMPAIGN_SENDER_READY.
// Changing this list needs a PR with green CI — that is the guard.
export const TEST_LEAD_IDS = ['1dlh5ldb9rlwpra'];
export const CU15 = /cu-15/i;
export const INFORME_VERSION = 1;
export const MAX_PER_TICK = 10;
export const INFRA_STREAK_PAUSE = 3;
export const GUARDED_STREAK_PAUSE = 3;
export const CHASSIS_TIMEOUT_MS = 30_000;
export const DOUBTFUL_AFTER_MS = 24 * 3_600_000;
export const CONSENT_TEMPLATE = 'consentimiento.solicitud';
export const PROJECT_ID = 14; // projects.id of inmobiliaria, for lead.consent_requested
// A message provably left. Never rank-compare envios.estado: in the chassis
// RANK `error` is the highest value, so `>= enviado` would count refusals.
export const SENT_ESTADOS = ['enviado', 'entregado', 'abierto', 'click'];
export const ACTIVE_ESTADOS = ['programada', 'en_curso'];
const TERMINAL = ['sent', 'excluded', 'doubtful'];
const LINK_VARIABLES = ['baja_url', 'si_url']; // minted by the chassis, never by us

// The human-facing copy (Spanish: it lands in Telegram and in the CRM).
export const COPY = {
  segment_invalid: 'El segmento guardado no es válido: nunca se interpreta como «todos».', // lang-sweep: allow
  segment_empty: 'El segmento no selecciona a nadie.', // lang-sweep: allow
  hours_invalid: 'El horario de envío (hora_desde/hora_hasta) falta o no es válido.', // lang-sweep: allow
  lote_invalid: 'La campaña no tiene lote_diario: nunca enviaría nada.', // lang-sweep: allow
  chassis_not_configured: 'Faltan CHASSIS_URL u OUTBOUND_SECRET en los secretos del job.', // lang-sweep: allow
  template_missing: 'La campaña no tiene una plantilla válida.', // lang-sweep: allow
  variables_missing: 'Faltan valores para la plantilla: ', // lang-sweep: allow
  nothing_sent: 'Todos los destinatarios terminaron y no se envió nada.', // lang-sweep: allow
  ledger_empty: 'El registro de envíos no muestra ningún envío de esta campaña.', // lang-sweep: allow
  infra_streak: 'Tres pasadas seguidas con fallo de infraestructura.', // lang-sweep: allow
  guarded_flood: 'Tres rechazos de número seguidos sin ningún envío: se trata como fallo nuestro.', // lang-sweep: allow
  paused: (name, code, reason) => `⏸ <b>Campaña en pausa</b> — ${name}\nMotivo: <code>${code}</code> ${reason}\nSe reanuda a mano (estado en_curso) cuando esté resuelto.`, // lang-sweep: allow
  completed: (name, s) => `✅ <b>Campaña completada</b> — ${name}\nAlcanzados: ${s.alcanzados} · excluidos: ${s.excluidos} · dudosos: ${s.dudosos}`, // lang-sweep: allow
};

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// -- segment v1: declarative data evaluated here, never a PocketBase filter --
const SEGMENT_KEYS = {
  ids: (x) => Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string' && /^[a-z0-9]{15}$/.test(s)),
  etapa: (x) => Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string'),
  origen: (x) => Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string'),
  consentimiento: (x) => typeof x === 'boolean',
  idioma: (x) => x === 'es' || x === 'en',
  canal_preferido: (x) => x === 'email' || x === 'whatsapp',
  asignado: (x) => typeof x === 'string' && x.length > 0,
};

/** {criteria} or {error}. An unknown key, a wrong type, a missing v or no criterion at all is invalid — never "everybody". */
export function parseSegment(seg) {
  if (!seg || typeof seg !== 'object' || Array.isArray(seg)) return { error: 'not an object' };
  if (seg.v !== 1) return { error: `v must be 1, got ${JSON.stringify(seg.v)}` };
  const criteria = {};
  for (const [k, x] of Object.entries(seg)) {
    if (k === 'v') continue;
    if (!Object.hasOwn(SEGMENT_KEYS, k)) return { error: `unknown key ${k}` };
    if (!SEGMENT_KEYS[k](x)) return { error: `bad value for ${k}` };
    criteria[k] = x;
  }
  if (!Object.keys(criteria).length) return { error: 'no criterion' };
  return { criteria };
}

export function matches(criteria, lead) {
  return Object.entries(criteria).every(([k, x]) => {
    if (k === 'ids') return x.includes(lead.id);
    if (Array.isArray(x)) return x.includes(lead[k]);
    if (k === 'consentimiento') return Boolean(lead.consentimiento) === x;
    return lead[k] === x;
  });
}

// -- guards: before any write, in this order ---------------------------------
/** null when allowed, else {code, reason}. A refused guard writes nothing and emits no campana.* event. */
export function guard(row, recipientIds, env, cu15Row) {
  const ready = env?.CAMPAIGN_SENDER_READY === '1';
  if (CU15.test(String(row.nombre ?? ''))) {
    if (env?.CU15_OWNER_YES !== row.id || !ready) {
      return { code: 'cu15_not_authorised', reason: 'CU-15 needs CU15_OWNER_YES = its id and CAMPAIGN_SENDER_READY=1' };
    }
    return null;
  }
  if (recipientIds === null) return null; // the name check alone, before the segment is read
  const real = recipientIds.filter((id) => !TEST_LEAD_IDS.includes(id));
  if (real.length && !ready) return { code: 'sender_not_ready', reason: `${real.length} recipient(s) outside TEST_LEAD_IDS without CAMPAIGN_SENDER_READY` };
  if (real.length && cu15Row?.estado !== 'completada') return { code: 'cu15_not_completed', reason: 'real recipients need CU-15 completada first' };
  return null;
}

// -- cadence --------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** true/false inside [hora_desde, hora_hasta) Madrid time; null when the window is missing or empty. */
export function insideHours(row, now) {
  const { hora_desde: from, hora_hasta: to } = row;
  if (!HHMM.test(from ?? '') || !HHMM.test(to ?? '') || from >= to) return null;
  const hm = horaMadrid(now);
  return hm >= from && hm < to;
}

export const started = (row, now) => !row.inicio || parseFecha(row.inicio) <= now;

/** How many sends this tick may make: MAX_PER_TICK, what is left of lote_diario today, and interval credits. */
export function quota(row, informe, now) {
  const today = diaMadrid(now);
  const usedToday = Object.values(informe.recipients ?? {})
    .filter((r) => ['sent', 'uncertain', 'doubtful', 'claimed'].includes(r.state) && diaMadrid(r.at) === today).length;
  const left = Math.max(0, (Number(row.lote_diario) || 0) - usedToday);
  const every = Number(row.intervalo_min) || 0;
  const last = row.ultimo_envio_en ? parseFecha(row.ultimo_envio_en) : null;
  const credits = every === 0 || !last || !Number.isFinite(last.getTime())
    ? MAX_PER_TICK
    : Math.floor((now - last) / 60_000 / every);
  return Math.max(0, Math.min(MAX_PER_TICK, left, credits));
}

// -- informe ------------------------------------------------------------------
/** An informe with no recipients yet: what a campaign paused before its segment was frozen carries. */
export const emptyInforme = () => ({ v: INFORME_VERSION, alcanzados: 0, intentados_ids: [], excluidos: [], revision_humana: [], infra_streak: 0, guarded_streak: 0 });

/** The informe a pause writes: the reason, no lease, and fresh streaks so a human resume gets three new chances. */
export function pausedInforme(informe, code, reason, now) {
  const next = { ...clone(informe ?? emptyInforme()), pausa: { code, reason, at: now.toISOString() }, infra_streak: 0, guarded_streak: 0 };
  delete next.lease;
  return next;
}

/** Who this tick may send to, in order: every pending recipient, then the deferred ones. */
export const sendQueue = (informe, n) => {
  const inState = (s) => Object.entries(informe.recipients).filter(([, r]) => r.state === s).map(([id]) => id);
  return [...inState('pending'), ...inState('deferred')].slice(0, n);
};

export function freeze(ids) {
  return { ...emptyInforme(), recipients: Object.fromEntries(ids.map((id) => [id, { state: 'pending' }])) };
}

const clone = (x) => structuredClone(x);
const sentCount = (informe) => Object.values(informe.recipients).filter((r) => r.state === 'sent').length;

export function claim(informe, leadId, now) {
  const next = clone(informe);
  next.recipients[leadId] = { state: 'claimed', at: now.toISOString() };
  if (!next.intentados_ids.includes(leadId)) next.intentados_ids.push(leadId);
  return next;
}

/** A claimed recipient found at the start of a tick never got its answer written: it may have been sent. */
export function settleClaims(informe) {
  const next = clone(informe);
  for (const r of Object.values(next.recipients)) if (r.state === 'claimed') r.state = 'uncertain';
  return next;
}

/** The ONLY exclusion writer. Asks mayExcludeLead() before anything else. */
export function excludeLead(informe, leadId, verdict) {
  if (!mayExcludeLead(verdict)) throw new Error(`refusing to exclude ${leadId} on ${verdict?.code}`);
  const next = clone(informe);
  next.recipients[leadId] = { ...next.recipients[leadId], state: 'excluded', code: verdict.code, scope: verdict.scope };
  return { ...next, excluidos: [...next.excluidos, { lead: leadId, code: verdict.code, reason: verdict.reason, scope: verdict.scope }] };
}

/**
 * Apply one outcome to one recipient. `outcome` is {sent, envio_id?} or
 * {verdict} (from classifyRefusal) or {state: 'uncertain'|'doubtful'|'pending'}.
 * Returns {informe, action, verdict?}: action 'continue' | 'stop' (end the
 * tick and throw) | 'pause' (pause the campaign, code verbatim, throw).
 */
export function applyOutcome(informe, leadId, outcome, now) {
  let next = clone(informe);
  const r = next.recipients[leadId];
  if (outcome.sent) {
    next.recipients[leadId] = { state: 'sent', at: r.at ?? now.toISOString(), ...(outcome.envio_id ? { envio_id: outcome.envio_id } : {}) };
    next.infra_streak = 0;
    next.guarded_streak = 0;
    return { informe: next, action: 'continue' };
  }
  if (outcome.state) {
    next.recipients[leadId] = { ...r, state: outcome.state };
    if (outcome.state === 'doubtful' && !next.revision_humana.includes(leadId)) next.revision_humana.push(leadId);
    return { informe: next, action: 'continue' };
  }
  const v = outcome.verdict;
  if (v.bucket === 'lead' && mayExcludeLead(v) && (!v.guarded || sentCount(next) > 0)) {
    return { informe: excludeLead(next, leadId, v), action: 'continue', verdict: v };
  }
  if (v.bucket === 'ambiguous') {
    next.recipients[leadId] = { ...r, state: 'uncertain', code: v.code };
    return { informe: next, action: 'stop', verdict: v };
  }
  next.ultimo_fallo = { code: v.code, reason: v.reason, at: now.toISOString() };
  if (v.bucket === 'lead') {
    // A provider number code before anything was sent may be OUR sender's
    // fault: the lead is deferred behind every pending one, and only a run of
    // them with nothing sent pauses the campaign.
    next.recipients[leadId] = { state: 'deferred', code: v.code };
    next.guarded_streak = (next.guarded_streak ?? 0) + 1;
    return next.guarded_streak >= GUARDED_STREAK_PAUSE
      ? { informe: next, action: 'pause', verdict: { ...v, reason: COPY.guarded_flood } }
      : { informe: next, action: 'continue', verdict: v };
  }
  next.recipients[leadId] = { state: 'pending' };
  if (v.bucket === 'run') return { informe: next, action: 'pause', verdict: v };
  next.infra_streak = (next.infra_streak ?? 0) + 1;
  const action = next.infra_streak >= INFRA_STREAK_PAUSE ? 'pause' : 'stop';
  return { informe: next, action, verdict: action === 'pause' ? { ...v, reason: `${COPY.infra_streak} ${v.reason}` } : v };
}

/**
 * What the ledger says about one uncertain recipient. `rows` are the envios of
 * this campaign for this lead.
 *   email     the row is written only AFTER sendMail resolved, and Brevo later
 *             turns it into `error` (hard_bounce, blocked…): any row means it
 *             left, and no row proves nothing — doubtful either way unless sent.
 *   whatsapp  the row is written BEFORE the provider call: no row, once the
 *             chassis cannot still be mid-request, is a proven non-send.
 */
export function reconcile(recipient, rows, canal, now) {
  if (rows.some((e) => SENT_ESTADOS.includes(e.estado))) return { sent: true };
  if (canal !== 'whatsapp') return { state: 'doubtful' };
  if (!rows.length) {
    const age = now - new Date(recipient.at ?? 0);
    return { state: age > 2 * CHASSIS_TIMEOUT_MS ? 'pending' : 'uncertain' };
  }
  if (rows.some((e) => e.estado === 'registrado')) {
    const age = now - new Date(recipient.at ?? 0);
    return { state: age >= DOUBTFUL_AFTER_MS ? 'doubtful' : 'uncertain' };
  }
  const errors = rows.filter((e) => e.estado === 'error');
  if (!errors.length) return { state: 'doubtful' }; // simulado or an estado nobody knows: never a send
  const last = [...errors].sort((a, b) => String(a.updated).localeCompare(String(b.updated))).pop();
  const verdict = classifyRefusal({ code: last.error_codigo });
  // provider_unavailable arrives WITH an error row and is the one error row
  // that does not prove a non-send.
  if (verdict.bucket === 'ambiguous') return { state: 'doubtful' };
  return { verdict };
}

/** 'open' while anyone is owed an answer; 'complete' when all finished and ≥1 sent; 'nothing_sent' otherwise. */
export function closeDecision(informe) {
  const all = Object.values(informe.recipients);
  if (!all.every((r) => TERMINAL.includes(r.state))) return 'open';
  return all.some((r) => r.state === 'sent') ? 'complete' : 'nothing_sent';
}

/** Distinct leads with a sent-state envios row — the number the E5 gate recomputes. */
export const reachedFromLedger = (envios) =>
  new Set(envios.filter((e) => SENT_ESTADOS.includes(e.estado)).map((e) => e.lead)).size;

// -- template variables -------------------------------------------------------
/** {values, missing}: `nombre` is the chassis's, links are the chassis's, `agencia` is settings negocio.razonSocial. */
export function resolveVariables(template, settings) {
  const names = Array.isArray(template?.variables) ? template.variables : [];
  const values = {};
  const missing = [];
  for (const name of names) {
    if (name === 'nombre' || LINK_VARIABLES.includes(name)) continue;
    if (name === 'agencia') {
      const text = String(settings?.['negocio.razonSocial']?.text ?? '').trim();
      if (text) { values.agencia = text; continue; }
    }
    missing.push(name);
  }
  return { values, missing };
}

export const render = (body, values) =>
  String(body ?? '').replace(/\{\{([a-z0-9_]+)\}\}/g, (m, k) => (values[k] == null ? m : String(values[k])));

// -- the seed catalog (pb/campanas.json), checked before the seed does any I/O --
/** Every reason the catalog must not be seeded; [] when it may. */
export function catalogProblems(rows) {
  const out = [];
  if (!Array.isArray(rows)) return ['catalog is not an array'];
  const names = rows.map((r) => String(r?.nombre ?? '').trim());
  if (new Set(names).size !== names.length) out.push('duplicate nombre');
  const cu = rows.filter((r) => CU15.test(String(r?.nombre ?? '')));
  if (cu.length !== 1) out.push(`${cu.length} CU-15 rows, expected exactly 1`);
  for (const r of rows) {
    const who = r?.nombre || '(unnamed row)';
    const seg = parseSegment(r?.segmento);
    if (!String(r?.nombre ?? '').trim()) out.push('a row without a name');
    if (!/^[a-z0-9_.]+$/.test(String(r?.plantilla ?? ''))) out.push(`${who}: plantilla must be a clave`);
    if (seg.error) out.push(`${who}: segmento ${seg.error}`);
    if (!Number.isInteger(r?.lote_diario) || r.lote_diario < 1) out.push(`${who}: lote_diario`);
    if (!Number.isInteger(r?.intervalo_min) || r.intervalo_min < 0) out.push(`${who}: intervalo_min`);
    if (insideHours(r ?? {}, new Date()) === null) out.push(`${who}: hora_desde/hora_hasta`);
    if (CU15.test(who)) {
      if (r.estado !== 'borrador') out.push(`${who}: CU-15 is seeded in borrador, never armed`);
    } else {
      if (!['borrador', 'programada'].includes(r?.estado)) out.push(`${who}: estado ${r?.estado}`);
      if (!seg.criteria?.ids || Object.keys(seg.criteria).length !== 1 || seg.criteria.ids.some((id) => !TEST_LEAD_IDS.includes(id))) {
        out.push(`${who}: a seeded rehearsal may only name TEST_LEAD_IDS`);
      }
    }
  }
  return out;
}

/**
 * What the seed does with each catalog row, given every row on the instance:
 * `keep` when that nombre exists (never patched), `refuse` for a CU-15 row
 * while ANY existing row carries the marker (a second CU-15 would make the
 * gate's identifier ambiguous), `create` otherwise.
 */
export function seedPlan(rows, existing) {
  const names = new Set(existing.map((c) => c.nombre));
  const cu15Exists = existing.some((c) => CU15.test(String(c.nombre ?? '')));
  return rows.map((row) => ({
    row,
    action: names.has(row.nombre) ? 'keep' : CU15.test(row.nombre) && cu15Exists ? 'refuse' : 'create',
  }));
}
