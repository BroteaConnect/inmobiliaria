// campanas.lib.mjs — every rule the campaign runner needs, with no I/O:
// who a campaign is for, how many messages this run may send, what a refusal
// means, what the report says and how the Telegram line reads. The job itself
// (jobs/campanas.mjs) only talks to PocketBase and to the chassis.
//
// Naming: the domain nouns are the ones the database uses (campana, segmento,
// envios, informe, rechazos) exactly like jobs/lib.mjs does — a `rule` and a
// `regla` in one module is how two different things get the same meaning.
// Comments and docs are English; the Telegram strings are Spanish, because
// Telegram is where the team reads.
//
// Two contracts are fixed here as data, versioned, and validated before
// anything is sent:
//   · `campanas.segmento` — who the campaign is for (see SEGMENTO_VERSION)
//   · `campanas.informe`  — what happened (see INFORME_VERSION)
// A segment that does not parse NEVER means "everybody": evaluarSegmento()
// throws and the job sends nothing for that campaign.
import { PIE_CRM, diaMadrid, escapeHtml, esFecha, normalizarTexto, parseFecha, recorta } from './lib.mjs';

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

// -- product constants --------------------------------------------------------
// A campaign is a slow drip, not a blast: even if the batch and the interval
// allowed more, one run of an hourly job never sends more than this. It is the
// blast radius of any mistake made in PocketBase Admin.
export const MAX_ENVIOS_POR_RUN = 10;
// A lead whose send failed for a retryable reason this many times is given up
// on, recorded as `agotado`, and stops holding the campaign open.
export const MAX_REINTENTOS_LEAD = 3;
// Runs in a row that sent nothing pause the campaign instead of retrying for
// ever — three quiet runs are a configuration problem, not bad luck.
export const RUNS_SIN_ENVIO_PARA_PAUSAR = 3;
// `informe` is a column rewritten after every single send, so no list inside
// it may grow without a bound. The oldest broken links are dropped first: the
// recent ones are the ones a repair can still act on.
export const MAX_ENLACES_FALLIDOS = 50;

// The runner only ever picks these up, and never writes any other state.
export const ESTADOS_ACTIVOS = ['programada', 'en_curso'];
// `borrador` is armed (a preview, no send) but never sent; the other three are
// a human's decision and the job does not argue with them.
export const ESTADOS_INTOCABLES = ['pausada', 'completada', 'cancelada'];

// -- the segment contract -----------------------------------------------------
export const SEGMENTO_VERSION = 1;
// Every key the contract knows. Anything else is a loud refusal: a typo
// (`consentimento`) that is silently ignored sends the campaign to people it
// was never meant for.
export const CLAVES_SEGMENTO = [
  'v', 'etapa', 'origen', 'consentimiento', 'canal_preferido', 'idioma',
  'incluye_ids', 'excluye_ids', 'sin_contacto_dias', 'max', 'variables',
];
// pb/schema.json, leads.etapa / leads.canal_preferido / leads.idioma.
export const ETAPAS = ['nuevo', 'contactado', 'visita', 'oferta', 'reservado', 'vendido', 'nutriendo'];
export const CANALES = ['email', 'whatsapp'];
export const IDIOMAS = ['es', 'en'];

// `variables` is the one key that is NOT a filter: it carries the campaign's
// fixed template values (`url`, `municipio`, `n_propiedades`…), because
// `campanas` has no column for them and a schema change is not worth one
// object. Literal strings only — a number here would reach a body as
// "[object Object]" or as nothing at all.
export const CLAVE_VARIABLES = 'variables';

// Variables the chassis mints itself and a caller may never supply: the
// unsubscribe and the opt-in links are signed with a secret only the chassis
// holds. Sending our own would either be rejected or, worse, accepted — and a
// campaign that ships an unsigned opt-out link is a campaign nobody can leave.
// They are not built here, not sent, and never counted as missing.
export const VARIABLES_DEL_CHASIS = ['baja_url', 'si_url'];

export class SegmentoInvalido extends Error {
  constructor(problemas) {
    super(`segmento invalido: ${problemas.join('; ')}`); // lang-sweep: allow
    this.name = 'SegmentoInvalido';
    this.problemas = problemas;
  }
}

const esObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const listaDeTextos = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
const esEnteroDesde = (v, min) => typeof v === 'number' && Number.isInteger(v) && v >= min;

/**
 * Every problem of a segment, one readable line each. [] when it is valid.
 * The job prints these into `informe.bloqueo` and sends nothing.
 */
export function problemasSegmento(segmento) {
  const out = [];
  if (!esObjeto(segmento)) return ['segmento is not an object'];
  if (segmento.v !== SEGMENTO_VERSION) out.push(`v must be ${SEGMENTO_VERSION} (got ${JSON.stringify(segmento.v)})`);
  for (const k of Object.keys(segmento)) {
    if (!CLAVES_SEGMENTO.includes(k)) out.push(`unknown key ${k}`);
  }
  const lista = (k, values) => {
    if (!(k in segmento)) return;
    if (!listaDeTextos(segmento[k])) { out.push(`${k} must be a non-empty array of strings`); return; }
    if (!segmento[k].length) out.push(`${k} is an empty list, which matches nobody`);
    if (values) for (const v of segmento[k]) if (!values.includes(v)) out.push(`${k} has unknown value ${v}`);
  };
  lista('etapa', ETAPAS);
  lista('origen', null); // free text on the leads row; compared normalised
  lista('canal_preferido', CANALES);
  lista('idioma', IDIOMAS);
  lista('incluye_ids', null);
  lista('excluye_ids', null);
  if ('consentimiento' in segmento && typeof segmento.consentimiento !== 'boolean') out.push('consentimiento must be true or false');
  if ('sin_contacto_dias' in segmento && !esEnteroDesde(segmento.sin_contacto_dias, 0)) out.push('sin_contacto_dias must be an integer >= 0');
  if ('max' in segmento && !esEnteroDesde(segmento.max, 1)) out.push('max must be an integer >= 1');
  if (CLAVE_VARIABLES in segmento) {
    const vars = segmento[CLAVE_VARIABLES];
    // Said out loud because it is the one key that reads like a filter and is
    // not one: it is what the template's placeholders are filled with.
    if (!esObjeto(vars)) out.push('variables must be an object of literal template values (it is not a filter)');
    else {
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v !== 'string' || v.trim() === '') out.push(`variables.${k} must be a non-empty string`);
        if (VARIABLES_DEL_CHASIS.includes(k)) out.push(`variables.${k} is minted by the chassis and must not be set here`);
      }
    }
  }
  return out;
}

// Reachability is implicit in the template's channel and cannot be expressed
// in the JSON: an email campaign needs an address, a WhatsApp one a phone.
export const CODIGO_SIN_CONTACTO = { email: 'sin_email', whatsapp: 'sin_telefono' };

const alcanzable = (lead, canal) =>
  canal === 'email' ? String(lead.email ?? '').trim() !== '' : String(lead.telefono ?? '').trim() !== '';

// created ascending, then id: two runs over the same data pick the same
// people in the same order, so `max` is a decision and not a coin toss.
const ordenEstable = (a, b) => {
  const ta = parseFecha(a.created);
  const tb = parseFecha(b.created);
  const va = esFecha(ta) ? ta.getTime() : Infinity; // a row with no usable date goes last
  const vb = esFecha(tb) ? tb.getTime() : Infinity;
  if (va !== vb) return va - vb;
  return String(a.id).localeCompare(String(b.id));
};

/**
 * Who this campaign is for.
 * Returns { destinatarios, excluidos, coincidentes, alcanzables }: the leads
 * to write to (after `max`), the ones that match the segment but cannot be
 * reached on the template's channel (reported, counted, never sent to), and
 * the two counts behind them — how many the segment matched at all, and how
 * many of those are reachable. The arming preview reports all three, because
 * "216 destinatarios" when 25 of them have no phone is a number that gets
 * approved and then disappoints.
 * Throws SegmentoInvalido when the JSON does not parse — an unparseable
 * segment must never mean "everybody".
 */
export function evaluarSegmento({ segmento, leads = [], canal = 'email', now = new Date() }) {
  const problemas = problemasSegmento(segmento);
  if (problemas.length) throw new SegmentoInvalido(problemas);

  const incluye = Array.isArray(segmento.incluye_ids) ? new Set(segmento.incluye_ids) : null;
  const excluye = new Set(Array.isArray(segmento.excluye_ids) ? segmento.excluye_ids : []);
  const origenes = Array.isArray(segmento.origen) ? segmento.origen.map(normalizarTexto) : null;
  const corte = esEnteroDesde(segmento.sin_contacto_dias, 0) ? now - segmento.sin_contacto_dias * MS_DAY : null;

  const candidatos = leads.filter((lead) => {
    // An allow-list restricts the candidates; it never bypasses a rule. A
    // named lead who never consented is still not written to.
    if (incluye && !incluye.has(lead.id)) return false;
    if (Array.isArray(segmento.etapa) && !segmento.etapa.includes(lead.etapa)) return false;
    // 'histórico' carries an accent; comparing it raw matches nobody and the
    // campaign completes as "0 destinatarios" — green, and having done nothing.
    if (origenes && !origenes.includes(normalizarTexto(lead.origen))) return false;
    if (typeof segmento.consentimiento === 'boolean') {
      const tiene = lead.consentimiento === true;
      if (segmento.consentimiento !== tiene) return false;
    }
    if (Array.isArray(segmento.canal_preferido) && !segmento.canal_preferido.includes(lead.canal_preferido)) return false;
    if (Array.isArray(segmento.idioma) && !segmento.idioma.includes(lead.idioma)) return false;
    if (corte != null) {
      const ultimo = parseFecha(lead.ultimo_contacto);
      // Never contacted (empty, or a date written before the autodate fields
      // existed) is the opposite of "contacted recently": eligible.
      if (esFecha(ultimo) && ultimo.getTime() > corte) return false;
    }
    // Last, and it always wins.
    if (excluye.has(lead.id)) return false;
    return true;
  }).sort(ordenEstable);

  const excluidos = [];
  const alcanzables = [];
  for (const lead of candidatos) {
    if (alcanzable(lead, canal)) alcanzables.push(lead);
    else excluidos.push({ lead: lead.id, code: CODIGO_SIN_CONTACTO[canal] ?? 'sin_contacto' });
  }
  // `max` caps the people actually written to, after the unreachable ones are
  // out: a cap of 30 means 30 messages, not 30 minus whoever has no address.
  const tope = esEnteroDesde(segmento.max, 1) ? segmento.max : alcanzables.length;
  return {
    destinatarios: alcanzables.slice(0, tope),
    excluidos,
    coincidentes: candidatos.length,
    alcanzables: alcanzables.length,
  };
}

/**
 * Can this template be sent at all, today, on its own channel?
 * A WhatsApp campaign writes to people whose 24-hour window closed long ago,
 * and Meta only allows an APPROVED Content template there. Asking per lead
 * would burn the whole batch on `template_not_approved` one refusal at a
 * time, so it is asked once, before anything is sent — and said by name in
 * the arming preview, where the owner can still act on it.
 * Returns { listo: true } or { listo: false, code, motivo }.
 */
export function plantillaLista(plantilla) {
  if (!plantilla || !plantilla.clave) {
    return { listo: false, code: 'sin_plantilla', motivo: 'la campaña no tiene plantilla' }; // lang-sweep: allow
  }
  if (plantilla.estado === 'retirada') {
    return { listo: false, code: 'template_retired', motivo: `la plantilla ${plantilla.clave} está retirada` }; // lang-sweep: allow
  }
  if (plantilla.canal === 'whatsapp' && plantilla.content_estado !== 'approved') {
    const estado = plantilla.content_estado || 'sin enviar a Twilio Content'; // lang-sweep: allow
    return {
      listo: false,
      code: 'template_not_approved',
      motivo: `la plantilla ${plantilla.clave} no está aprobada por Meta (Twilio Content: ${estado}); hasta que lo esté, cada envío se rechazaría`, // lang-sweep: allow
    };
  }
  return { listo: true, code: null, motivo: null };
}

// -- the clock: Madrid, always through Intl -----------------------------------
const madridHm = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
/** Minutes since midnight in Madrid, or null when the date is unusable. */
export const minutosMadrid = (date) => {
  const d = parseFecha(date);
  if (!esFecha(d)) return null;
  const [h, m] = madridHm.format(d).split(':');
  return Number(h) * 60 + Number(m);
};

/** "HH:MM" as minutes since midnight, or null when it is not a time. */
export const hhmmAMinutos = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

/**
 * Is `now` inside the campaign's sending window? No wrap-around on purpose:
 * `22:00 → 06:00` is a configuration error, not a night shift, and it is
 * reported as one instead of quietly sending at four in the morning.
 */
export function dentroDeHorario({ hora_desde, hora_hasta }, now) {
  const desde = hhmmAMinutos(hora_desde);
  const hasta = hhmmAMinutos(hora_hasta);
  if (desde == null || hasta == null || desde >= hasta) return null; // config error
  const ahora = minutosMadrid(now);
  return ahora != null && ahora >= desde && ahora < hasta;
}

/**
 * How many messages this campaign already sent today, counted from the ledger
 * (`envios` rows of this campaign) and never from a state file: the job may
 * crash between two sends, and `informe.por_dia` is a report, not the truth.
 * A row in `error` was not delivered to anyone and does not spend the batch.
 */
export function enviadosHoy(envios = [], now = new Date()) {
  const hoy = diaMadrid(now);
  return envios.filter((e) => e.estado !== 'error' && diaMadrid(e.enviado_en || e.created) === hoy).length;
}

/**
 * How many messages this run may send: { permitidos, motivo }.
 * The job never sleeps — an hourly runner cannot hold a process for eight
 * hours — so the interval is spent as CREDITS accumulated since the last send.
 */
export function cuotaDelRun({ campana, envios = [], now = new Date() }) {
  const nada = (motivo) => ({ permitidos: 0, motivo, enviadosHoy: 0 });
  if (dentroDeHorario(campana, now) === null) return nada('horario_invalido');
  if (!esEnteroDesde(Number(campana.lote_diario), 1)) return nada('lote_invalido');
  // 0 and an unset column both mean "no pacing"; -5 or "diez" means somebody
  // meant something and it did not arrive. Silently disabling the drip is the
  // one reading that is never what they meant.
  const intervalo = campana.intervalo_min == null || campana.intervalo_min === '' ? 0 : Number(campana.intervalo_min);
  if (!esEnteroDesde(intervalo, 0)) return nada('intervalo_invalido');
  if (campana.inicio) {
    const inicio = parseFecha(campana.inicio);
    if (esFecha(inicio) && now < inicio) return nada('aun_no_empieza');
  }
  if (!dentroDeHorario(campana, now)) return nada('fuera_de_horario');

  const hoy = enviadosHoy(envios, now);
  const restante = Number(campana.lote_diario) - hoy;
  if (restante <= 0) return { permitidos: 0, motivo: 'lote_diario_agotado', enviadosHoy: hoy };

  let creditos = restante;
  if (intervalo > 0) {
    const ultimo = parseFecha(campana.ultimo_envio_en);
    // No last send recorded: the interval has nothing to measure from, so it
    // does not hold the first message of the campaign back.
    creditos = esFecha(ultimo) ? Math.floor((now - ultimo) / (intervalo * MS_MIN)) : restante;
  }
  if (creditos <= 0) return { permitidos: 0, motivo: 'intervalo', enviadosHoy: hoy };
  const permitidos = Math.min(restante, creditos, MAX_ENVIOS_POR_RUN);
  return { permitidos, motivo: permitidos > 0 ? 'ok' : 'intervalo', enviadosHoy: hoy };
}

// -- refusals -----------------------------------------------------------------
// Terminal for that lead: nothing about this campaign will change the answer,
// so the lead is resolved (it stops holding the campaign open) and recorded.
export const RECHAZOS_TERMINALES = [
  'no_email', 'no_phone', 'no_consent', 'consent_revoked', 'lead_unknown', 'lead_not_found', 'lead_required',
  'template_unknown', 'template_channel', 'template_retired', 'template_not_approved', 'template_required',
  'outside_window', 'text_too_long', 'actividad_invalid', 'agotado',
];
// Retryable: the chassis said, in so many words, that nothing left. The same
// message may well go out on the next run. The `… not configured` sentences
// are literal answers from the chassis (`src/server.js`) and they are a 503
// that sent nothing at all — a redeploy with a half-loaded environment answers
// exactly that, and filing those leads as "maybe sent" would lose them for good.
export const RECHAZOS_REINTENTABLES = [
  'chassis_timeout', 'chassis_unreachable', 'provider_unavailable', 'ledger_unavailable', '63018',
  ...['not configured', 'smtp not configured', 'pocketbase not configured', 'outbound email not configured'],
];
// …and those four are a property of the RUN, not of a lead, for the same
// reason a rotated secret is: the chassis raises them for every recipient
// alike, before anything is handed to a provider (they are guard clauses at
// the top of both handlers). Spent per lead they would burn the cartera's
// three retries and file everybody as `agotado` — terminal, never retried —
// over a container that booted with half an environment.
export const RECHAZOS_DE_CONFIGURACION = [
  'not configured', 'smtp not configured', 'pocketbase not configured', 'outbound email not configured',
];
export const esRechazoDeConfiguracion = ({ code } = {}) => RECHAZOS_DE_CONFIGURACION.includes(String(code ?? ''));
// AMBIGUOUS: the chassis answered "no" AFTER the message may already have
// gone. `/send-email` returns 502 `send failed` whenever sendTrackedEmail
// throws — and it can throw on the `actividades` POST or the `leads` PATCH,
// both of which run once nodemailer has accepted the message. Retrying that is
// how one lead gets three copies, so an ambiguous refusal is treated like no
// answer at all: the recipient stays in `en_vuelo` and the next run adopts it
// or files it as `dudoso`. Note the space: the chassis sends the sentence, not
// an identifier, and a whitelist with an underscore never matched it.
// (A send whose ledger row failed is NOT here: the chassis returns that as
// 200 `{ok: true, recorded: false}`, a success, and enviados_ids records it.)
export const RECHAZOS_AMBIGUOS = ['send failed'];
// Authentication is a property of the RUN, never of a lead. The shared secret
// travels in the query string and a rotated one answers 403 `forbidden` for
// every single recipient — filing 216 people as terminally excluded, with the
// campaign then "completing" having written to nobody and no way back short of
// editing the informe by hand. A wrong credential is the same class of problem
// as a missing one: it blocks the campaign and changes no lead's state.
export const ESTADOS_DE_CREDENCIAL = [401, 403];
// Terminal for the whole RUN: the variables are built the same way for
// everybody, so one missing value would burn ten leads on one bug.
export const RECHAZOS_DE_RUN = ['variables_missing'];

/**
 * True when the answer is about US and not about this lead: a rotated or
 * missing shared secret.
 *
 * It requires the BARE shape the secret gate answers with — `{error: '…'}`, a
 * sentence and no `error.code` — rather than any 401/403. Two reasons, and the
 * second is why `estructurado` exists at all: a Traefik or WAF 403 is not our
 * secret and should not claim to be, and the chassis's auth contract is
 * changing this week, so a *new* per-lead refusal shipped as 403 with a proper
 * code must refuse one lead and not block the whole campaign.
 */
export function esRechazoDeCredencial({ code, status, estructurado = false } = {}) {
  if (!ESTADOS_DE_CREDENCIAL.includes(Number(status))) return false;
  // Only a code we RECOGNISE as a per-lead refusal means "this person, not our
  // secret". An unrecognised one must NOT disqualify the credential reading:
  // it would fall through to `esRechazoTerminal`, whose last rule is "any
  // other 4xx is terminal", and a gate answering 403 `auth_token_required`
  // would write off every recipient in the run as permanently excluded — then
  // the campaign completes, announces itself, and reports to the manager,
  // having written to nobody. The chassis's auth contract changes this week,
  // so an unfamiliar auth code is the expected case, not the exotic one.
  // Blocking the run is recoverable; excluding the cartera is not.
  return !(estructurado && RECHAZOS_TERMINALES.includes(String(code ?? '')));
}

/**
 * True when we cannot tell whether the message left — the one case where a
 * retry is worse than giving up.
 *
 * `json` says whether the answer was the chassis's own JSON (`{ok}`/`{error}`).
 * It matters: an infrastructure 5xx — Traefik or Coolify while the app
 * restarts — is an HTML page, and nothing ever reached the mailer. Treating
 * that as "maybe sent" files every recipient as `dudoso`, permanently, for a
 * redeploy. Only a 5xx the chassis itself produced, with no code we recognise,
 * is genuinely ambiguous. Unknown shape defaults to ambiguous: never send
 * twice is the safer of the two mistakes.
 */
export function esRechazoAmbiguo({ code, status, json = true, estructurado = false } = {}) {
  const c = String(code ?? '');
  if (RECHAZOS_AMBIGUOS.includes(c)) return true;
  if (RECHAZOS_TERMINALES.includes(c) || RECHAZOS_REINTENTABLES.includes(c)) return false;
  if (esRechazoDeCredencial({ code, status, estructurado })) return false;
  return json && (Number(status) || 0) >= 500;
}

// A note left on purpose, because it is a decision and not an oversight:
// the chassis's catch-all `500 {error:'internal error'}` is, today, a provable
// non-send — every uncaught throw on both routes happens before the provider
// call, since the provider call has its own catch that answers 502. It is
// still classified ambiguous. The proof for 401/403 and for `not configured`
// is structural (a guard clause that cannot be reached after a send); the
// proof for 500 is an audit of every throw site, which is exactly the kind of
// proof one `await` added after the provider call would silently invalidate.
// A lost lead is visible in `informe.dudosos`, reported to Telegram, and a
// human can act on it; a second message to a real person cannot be undone.

/** True when this refusal will never resolve by trying again. */
export function esRechazoTerminal({ code, status } = {}) {
  const c = String(code ?? '');
  if (RECHAZOS_TERMINALES.includes(c)) return true;
  if (RECHAZOS_REINTENTABLES.includes(c)) return false;
  const s = Number(status) || 0;
  if (s === 429) return false;          // rate limited: exactly what retrying is for
  if (s >= 400 && s < 500) return true; // any other refusal we caused
  return false;                          // 5xx, 0, unknown: the chassis may recover
}

// -- the report ---------------------------------------------------------------
export const INFORME_VERSION = 1;

/** A report with every key present, keeping whatever a previous run wrote. */
export function informeInicial(previo = {}) {
  const p = esObjeto(previo) ? previo : {};
  return {
    v: INFORME_VERSION,
    armada_en: p.armada_en ?? null,
    // What the owner is asked to approve: how many the segment matches, how
    // many of those can actually be reached on this channel, and how many
    // would be dropped for having no address/phone. One number would hide the
    // other two.
    destinatarios_estimados: p.destinatarios_estimados ?? null,
    alcance_estimado: esObjeto(p.alcance_estimado) ? { ...p.alcance_estimado } : null,
    iniciada_en: p.iniciada_en ?? null,
    completada_en: p.completada_en ?? null,
    destinatarios: Number(p.destinatarios) || 0,
    enviados: Number(p.enviados) || 0,
    // WHO has already been written to, recorded by the job itself. The ledger
    // is the truth about counts, but it cannot be the truth about "did this
    // person already get it": the chassis answers `ok` with `envio_id: null`
    // whenever its own `envios` POST failed (it deliberately never fails a
    // send that already left), and the `campana` patch can fail too. Depending
    // on a foreign-key write landing means the next run sees the lead as
    // pending and writes to them again, every hour, for ever.
    // Unlike enlaces_fallidos this needs no cap: its bound IS the recipient
    // list — one id per person, added once, and `max` bounds that.
    enviados_ids: Array.isArray(p.enviados_ids) ? [...p.enviados_ids] : [],
    por_dia: esObjeto(p.por_dia) ? { ...p.por_dia } : {},
    estados: esObjeto(p.estados) ? { ...p.estados } : {},
    rechazos: esObjeto(p.rechazos) ? { ...p.rechazos } : {},
    excluidos: Array.isArray(p.excluidos) ? [...p.excluidos] : [],
    reintentos: esObjeto(p.reintentos) ? { ...p.reintentos } : {},
    dudosos: Array.isArray(p.dudosos) ? [...p.dudosos] : [],
    en_vuelo: Array.isArray(p.en_vuelo) ? [...p.en_vuelo] : [],
    enlaces_fallidos: Array.isArray(p.enlaces_fallidos) ? p.enlaces_fallidos.slice(-MAX_ENLACES_FALLIDOS) : [],
    bloqueo: p.bloqueo ?? null,
    runs: Number(p.runs) || 0,
    ultimo_run_en: p.ultimo_run_en ?? null,
    runs_sin_envio: Number(p.runs_sin_envio) || 0,
    informe_manager: p.informe_manager ?? null,
    telegram: p.telegram ?? null,
  };
}

/** One more message out: counted, dated, and off the in-flight list. */
export function aplicarEnvio(informe, { lead, now = new Date() }) {
  const out = informeInicial(informe);
  const dia = diaMadrid(now) ?? 'sin-fecha';
  out.enviados += 1;
  if (!out.enviados_ids.includes(lead)) out.enviados_ids = [...out.enviados_ids, lead];
  out.por_dia = { ...out.por_dia, [dia]: (out.por_dia[dia] ?? 0) + 1 };
  out.en_vuelo = out.en_vuelo.filter((e) => e.lead !== lead);
  const { [lead]: _fuera, ...resto } = out.reintentos;
  out.reintentos = resto;
  if (!out.iniciada_en) out.iniciada_en = new Date(now).toISOString();
  return out;
}

/**
 * One refusal, tallied by its own code — never bucketed as "otros", because a
 * code we have never seen is exactly the one worth reading. Terminal refusals
 * resolve the lead; retryable ones count against MAX_REINTENTOS_LEAD.
 */
export function aplicarRechazo(informe, { lead, code, status, now = new Date() }) {
  const out = informeInicial(informe);
  const c = String(code ?? `http_${status ?? 0}`);
  out.rechazos = { ...out.rechazos, [c]: (out.rechazos[c] ?? 0) + 1 };
  out.en_vuelo = out.en_vuelo.filter((e) => e.lead !== lead);
  const en = new Date(now).toISOString();
  if (esRechazoTerminal({ code: c, status })) {
    out.excluidos = [...out.excluidos, { lead, code: c, en }];
    return out;
  }
  const intentos = (out.reintentos[lead] ?? 0) + 1;
  out.reintentos = { ...out.reintentos, [lead]: intentos };
  if (intentos >= MAX_REINTENTOS_LEAD) out.excluidos = [...out.excluidos, { lead, code: 'agotado', en, ultimo: c }];
  return out;
}

/** Lead ids this campaign has already resolved, one way or another. */
const resueltos = (informe, envios) => new Set([
  ...informe.enviados_ids,
  ...envios.map((e) => e.lead),
  ...informe.excluidos.map((e) => e.lead),
  ...informe.dudosos.map((e) => e.lead),
  ...informe.en_vuelo.map((e) => e.lead),
]);

/**
 * Who is still owed a message. "Already received" is the set of leads with an
 * `envios` row for this campaign in ANY state — the ledger, not a counter —
 * plus the ones excluded, given up on, or whose send is unresolved
 * (`en_vuelo`, `dudosos`): a message that may have left is never sent twice.
 */
export function pendientes({ destinatarios = [], envios = [], informe = {} }) {
  const inf = informeInicial(informe);
  const ya = resueltos(inf, envios);
  return destinatarios.filter((l) => !ya.has(l.id));
}

/**
 * Close the run: the counters are re-read from the ledger, so a report is
 * never a number we kept adding to in memory.
 * Delivery states are a SNAPSHOT — `entregado` arrives by webhook minutes
 * later, so a campaign that completes in the same run truthfully says 0.
 */
export function cerrarInforme(informe, { destinatarios = [], envios = [], enviadosEnRun = 0, pudoEnviar = true, now = new Date(), completada = false }) {
  const out = informeInicial(informe);
  out.destinatarios = destinatarios.length;
  // The ledger is the truth, EXCEPT that it cannot see a send whose `envios`
  // row the chassis failed to write (it answers ok with envio_id: null). The
  // union of both by LEAD — not the larger of two lengths, which would let a
  // lead missing from the ledger hide behind a lead missing from the informe.
  out.enviados = new Set([
    ...envios.filter((e) => e.estado !== 'error').map((e) => e.lead),
    ...out.enviados_ids,
  ]).size;
  out.estados = envios.reduce((a, e) => ({ ...a, [e.estado || 'sin_estado']: (a[e.estado || 'sin_estado'] ?? 0) + 1 }), {});
  out.runs += 1;
  out.ultimo_run_en = new Date(now).toISOString();
  // `runs_sin_envio` is what pauses a campaign after three strikes, so it may
  // only count runs that COULD have sent and did not. Counting every quiet run
  // made `lote_diario` and the sending hours cancel each other out: a campaign
  // with a batch of 1 sent its message and paused three hours later, and an
  // 08:00–22:00 campaign paused overnight — both needing a human in
  // PocketBase Admin to resume. Outside the window, before `inicio`, with the
  // day's batch spent or with nobody pending, there was nothing to fail at.
  if (enviadosEnRun > 0) out.runs_sin_envio = 0;
  else if (pudoEnviar) out.runs_sin_envio += 1;
  if (completada && !out.completada_en) out.completada_en = new Date(now).toISOString();
  return out;
}

const cuenta = (obj, key) => Number(obj?.[key]) || 0;
const cuentaExcluidos = (informe, code) => informe.excluidos.filter((e) => e.code === code).length;

/** The `campana.completada` event payload. The E5 gate reads `campana_id`. */
export function payloadCompletada({ campana, plantilla = {}, informe }) {
  const inf = informeInicial(informe);
  const dias = Object.keys(inf.por_dia).sort();
  return {
    campana_id: campana.id,
    nombre: campana.nombre,
    plantilla: plantilla.clave ?? null,
    canal: plantilla.canal ?? null,
    destinatarios: inf.destinatarios,
    enviados: inf.enviados,
    errores: cuenta(inf.estados, 'error'),
    rechazos: inf.rechazos,
    dias,
    informe: inf,
  };
}

// -- Telegram (Spanish, HTML, every value escaped and capped) ------------------
const DD_MM = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ''));
  return m ? `${m[3]}/${m[2]}` : '??/??';
};

const lineaFechas = (inf) => {
  const dias = Object.keys(inf.por_dia).sort();
  if (!dias.length) return null;
  const tandas = inf.runs;
  const nd = dias.length;
  return `• Del ${DD_MM(dias[0])} al ${DD_MM(dias[nd - 1])} (${nd} ${nd === 1 ? 'día' : 'días'}, ${tandas} ${tandas === 1 ? 'tanda' : 'tandas'})`; // lang-sweep: allow
};

const lineaGestor = (inf) => {
  const m = inf.informe_manager;
  if (!m) return null;
  if (m.estado === 'enviado') return 'Informe al gestor por WhatsApp: enviado'; // lang-sweep: allow
  return `Informe al gestor por WhatsApp: no enviado — ${recorta(m.motivo || 'sin motivo')}`; // lang-sweep: allow
};

/** The message when a campaign finishes. */
export function textoCampanaCompletada({ campana, plantilla = {}, informe }) {
  const inf = informeInicial(informe);
  const nombre = recorta(campana.nombre || 'campaña sin nombre'); // lang-sweep: allow
  const canal = plantilla.canal === 'whatsapp' ? 'Sin teléfono' : 'Sin email'; // lang-sweep: allow
  const sinContacto = cuentaExcluidos(inf, 'sin_telefono') + cuentaExcluidos(inf, 'sin_email');
  const lineas = [
    `📣 <b>Campaña completada</b> — ${nombre}`, // lang-sweep: allow
    '',
    `• Destinatarios: ${inf.destinatarios} · Enviados: ${inf.enviados}`, // lang-sweep: allow
    `• Entregados: ${cuenta(inf.estados, 'entregado')} · Errores: ${cuenta(inf.estados, 'error')} (a fecha del cierre)`, // lang-sweep: allow
    `• ${canal}: ${sinContacto} · Sin consentimiento: ${cuenta(inf.rechazos, 'no_consent') + cuentaExcluidos(inf, 'no_consent')}`, // lang-sweep: allow
  ];
  const fechas = lineaFechas(inf);
  if (fechas) lineas.push(fechas);
  if (inf.dudosos.length) lineas.push(`• Sin confirmar: ${inf.dudosos.length} (pudieron salir o no; no se reintentan)`); // lang-sweep: allow
  const gestor = lineaGestor(inf);
  if (gestor) lineas.push('', gestor);
  lineas.push('', PIE_CRM);
  return lineas.join('\n');
}

/**
 * The message when a draft campaign is armed: a preview, nothing sent. It
 * reports reach, not a headline count, and names the blocker — being told
 * "blocked on Meta's approval" now beats discovering it thirty refusals in.
 */
export function textoCampanaArmada({ campana, plantilla = {}, informe }) {
  const inf = informeInicial(informe);
  const nombre = recorta(campana.nombre || 'campaña sin nombre'); // lang-sweep: allow
  const alcance = inf.alcance_estimado ?? {};
  const sinContacto = Number(alcance.sin_contacto) || 0;
  const etiqueta = plantilla.canal === 'whatsapp' ? 'sin teléfono' : 'sin email'; // lang-sweep: allow
  const lineas = [
    `🧮 <b>Campaña preparada</b> — ${nombre}`, // lang-sweep: allow
    '',
    `• Destinatarios estimados: ${inf.destinatarios_estimados ?? 0}`, // lang-sweep: allow
    `• El segmento coincide con ${Number(alcance.coincidentes) || 0} · alcanzables ${Number(alcance.alcanzables) || 0} · ${etiqueta} ${sinContacto}`, // lang-sweep: allow
    `• Plantilla: ${recorta(plantilla.clave || 'sin plantilla')} (${escapeHtml(plantilla.canal || 'sin canal')})`, // lang-sweep: allow
    // The honest sentence, not the flattering one: the job runs once an hour
    // and spends the interval as credits, so it sends in batches of up to
    // MAX_ENVIOS_POR_RUN — saying "1 cada 10 min" would promise a pace the
    // owner would then watch it break on the very first run.
    `• Ritmo: hasta ${Number(campana.lote_diario) || 0}/día, en tandas de hasta ${MAX_ENVIOS_POR_RUN} por pasada horaria (el intervalo de ${Number(campana.intervalo_min) || 0} min se acumula entre pasadas)`, // lang-sweep: allow
    `• Horario: de ${recorta(campana.hora_desde || '--:--')} a ${recorta(campana.hora_hasta || '--:--')}`, // lang-sweep: allow
  ];
  const lista = plantillaLista(plantilla);
  if (!lista.listo) lineas.push(`• ⛔ Bloqueada: ${recorta(lista.motivo)}`); // lang-sweep: allow
  lineas.push('', 'No se ha enviado nada: está en borrador. Ponla en <b>programada</b> desde PocketBase Admin para que empiece.'); // lang-sweep: allow
  return lineas.join('\n');
}

/** The message when a campaign is paused, with how to resume it. */
export function textoCampanaPausada({ campana, informe }) {
  const inf = informeInicial(informe);
  const nombre = recorta(campana.nombre || 'campaña sin nombre'); // lang-sweep: allow
  const motivo = recorta(inf.bloqueo?.motivo || `${inf.runs_sin_envio} pasadas sin enviar nada`); // lang-sweep: allow
  return [
    `⏸ <b>Campaña pausada</b> — ${nombre}`, // lang-sweep: allow
    '',
    `• Motivo: ${motivo}`, // lang-sweep: allow
    `• Enviados hasta ahora: ${inf.enviados} de ${inf.destinatarios}`, // lang-sweep: allow
    '',
    'Para reanudarla, ponla en <b>en_curso</b> desde PocketBase Admin cuando esté resuelto.', // lang-sweep: allow
  ].join('\n');
}

/** The message when a campaign cannot run at all. Sent once per Madrid day. */
export function textoCampanaBloqueada({ campana, bloqueo }) {
  const nombre = recorta(campana.nombre || 'campaña sin nombre'); // lang-sweep: allow
  const detalle = Array.isArray(bloqueo?.problemas) && bloqueo.problemas.length
    ? bloqueo.problemas.slice(0, 5).map((p) => `• ${recorta(p)}`) // lang-sweep: allow
    : [];
  return [
    `⛔ <b>Campaña bloqueada</b> — ${nombre}`, // lang-sweep: allow
    '',
    `• Motivo: ${recorta(bloqueo?.motivo || bloqueo?.code || 'sin motivo')}`, // lang-sweep: allow
    ...detalle,
    '',
    'No se ha enviado nada y la campaña no cambia de estado. Corrige la configuración y volverá a intentarlo.', // lang-sweep: allow
  ].join('\n');
}

// -- template variables -------------------------------------------------------
/**
 * The values this template needs for this lead: { variables, faltan }.
 * Resolution order, and it matters:
 *   1. computed per lead (`nombre`, `agente`) — the truth about this person
 *   2. `segmento.variables` — the campaign's own literals (`url`, `municipio`…)
 *   3. nothing. A name we do not know goes to `faltan` and blocks the
 *      campaign: a body with a literal {{municipio}} in it is worse than a
 *      body that never left.
 * VARIABLES_DEL_CHASIS are skipped entirely — see the constant.
 */
export function variablesPara({ plantilla = {}, lead = {}, segmento = {}, agente = null }) {
  const nombres = Array.isArray(plantilla.variables) ? plantilla.variables : [];
  const fijas = esObjeto(segmento[CLAVE_VARIABLES]) ? segmento[CLAVE_VARIABLES] : {};
  const calculadas = {
    nombre: String(lead.nombre ?? '').trim(),
    agente: String(agente ?? '').trim(),
  };
  const variables = {};
  const faltan = [];
  for (const nombre of nombres) {
    if (VARIABLES_DEL_CHASIS.includes(nombre)) continue;
    const valor = calculadas[nombre] || String(fijas[nombre] ?? '').trim();
    if (valor) variables[nombre] = valor;
    else faltan.push(nombre);
  }
  return { variables, faltan };
}
