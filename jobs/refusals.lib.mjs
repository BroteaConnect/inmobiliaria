// refusals.lib.mjs — what a refusal means, and the only door through which a
// refusal may cost a person their place in a campaign. Pure: no I/O, no
// PocketBase, no clock. Imported by jobs/campanas.lib.mjs and tested on its
// own in jobs/refusals.test.mjs. The `.lib.mjs` suffix is load-bearing: the
// scheduler runs every other `jobs/*.mjs` as a job, and a module with no run()
// would fail every hour.
//
// THE DEFAULT RULE, and the reason this module exists:
//   every refusal is an infrastructure fault — park it, retry it, report its
//   code verbatim — UNLESS its exact code appears in one of the four closed,
//   hand-written tables below; and only the LEAD table may move a lead.
//
// `status` is EVIDENCE, never a classifier. There is deliberately no
// `if (status >= 400 && status < 500)` in this file. A previous runner ended
// its classifier with exactly that line, so an unrecognised 4xx excluded a
// person for ever and an unrecognised 5xx became a never-retried unknown.
// Inverting it is the whole point: an unknown code is retried, never charged
// to a human being.
//
// The four buckets:
//   lead       exclude that lead from THIS campaign, with a recorded reason
//   run        pause the campaign; touch no lead's state
//   infra      park the send for retry; touch no lead's state
//   ambiguous  the message may already have left: do not retry, do not exclude
//
// Twilio error codes were read on 2026-09-23 from
// https://www.twilio.com/docs/api/errors/<code>; the chassis's own refusal
// codes come from requirements-api src/whatsapp.js (REFUSAL_STATUS), src/auth.js
// and src/consent.js on origin/main.
//
// The `reason` strings are Spanish because they are read by humans: they land
// in `campanas.informe` (which the CRM shows) and in the Telegram line. They
// are the only Spanish in this file.

const MAX_CODE = 60;

/**
 * The ONLY table that may exclude a person, and it excludes them from ONE
 * campaign — never from the agency.
 *
 * `scope` says how far the fact reaches:
 *   permanent  the person asked us to stop, or no longer exists
 *   campaign   they may not receive THIS campaign
 *   channel    WhatsApp cannot reach them; every other channel is untouched
 *
 * `guarded` marks the codes a provider emits in bulk when something on OUR
 * side is wrong (a bad sender, a paused number): the lead-flood breaker holds
 * a run made mostly of these as provisional instead of final.
 *
 * NOTHING here may ever write `leads.consentimiento`: a channel fact must not
 * silently kill the same person's email. Only the BAJA/STOP path touches
 * consent.
 */
export const LEAD_TABLE = {
  21610: { scope: 'permanent', reason: 'El contacto respondió STOP: no se le vuelve a escribir.' }, // lang-sweep: allow
  consent_revoked: { scope: 'permanent', reason: 'El lead pidió no recibir más mensajes.' }, // lang-sweep: allow
  lead_unknown: { scope: 'permanent', reason: 'El lead ya no existe en la base.' }, // lang-sweep: allow
  no_consent: { scope: 'campaign', reason: 'El lead no ha dado su consentimiento para mensajes comerciales.' }, // lang-sweep: allow
  no_phone: { scope: 'channel', reason: 'El lead no tiene un teléfono utilizable para WhatsApp.' }, // lang-sweep: allow
  no_email: { scope: 'channel', reason: 'El lead no tiene un email utilizable.' }, // lang-sweep: allow
  21211: { scope: 'channel', guarded: true, reason: 'Twilio no acepta ese número de destino.' }, // lang-sweep: allow
  21614: { scope: 'channel', guarded: true, reason: 'El número no es un móvil.' }, // lang-sweep: allow
  63003: { scope: 'channel', guarded: true, reason: 'WhatsApp no encuentra ese número como destino.' }, // lang-sweep: allow
  63024: { scope: 'channel', guarded: true, reason: 'El número no tiene WhatsApp o no puede recibir mensajes.' }, // lang-sweep: allow
  63032: { scope: 'campaign', guarded: true, reason: 'WhatsApp no permite enviar a este número ahora mismo.' }, // lang-sweep: allow
};

/**
 * Pause the campaign, exclude nobody. These say something about OUR request,
 * our credentials or our template — the same answer would come back for every
 * recipient, so spending the cartera on them is how a configuration mistake
 * turns into a permanently emptied campaign.
 *
 * `63016` is here and NOT in LEAD on purpose: it means the send SHAPE was
 * wrong for the window (outside 24 h a Content template is mandatory), or our
 * window inference disagreed with Meta's. Excluding on it would permanently
 * drop somebody merely for being outside a 24-hour window — the ordinary
 * state of every lead in this cartera.
 *
 * `variables_missing` is here and may NEVER exclude: an empty `nombre` is
 * data to fix, not a person to drop.
 */
export const RUN_TABLE = {
  lead_required: 'La petición fue sin lead: es un fallo nuestro, no del contacto.', // lang-sweep: allow
  template_unknown: 'La plantilla de la campaña no existe en el catálogo.', // lang-sweep: allow
  template_channel: 'La plantilla no es del canal por el que se intenta enviar.', // lang-sweep: allow
  template_retired: 'La plantilla está retirada: hay que elegir otra.', // lang-sweep: allow
  template_required: 'No se indicó plantilla y tampoco texto libre.', // lang-sweep: allow
  template_not_approved: 'Meta todavía no ha aprobado la plantilla para WhatsApp.', // lang-sweep: allow
  variables_missing: 'Faltan valores de la plantilla: es un dato que arreglar, no un contacto que descartar.', // lang-sweep: allow
  text_too_long: 'El mensaje supera el límite del proveedor.', // lang-sweep: allow
  outside_window: 'Fuera de la ventana de 24 h y sin plantilla aprobada que usar.', // lang-sweep: allow
  actividad_invalid: 'La actividad enlazada no es válida para ese lead.', // lang-sweep: allow
  forbidden: 'El chasis rechazó la credencial de la campaña.', // lang-sweep: allow
  invalid_token: 'La credencial del chasis no es válida.', // lang-sweep: allow
  not_staff: 'La credencial no tiene permiso para enviar.', // lang-sweep: allow
  secret_from_browser: 'El chasis vio el secreto llegar desde un navegador y lo rechazó.', // lang-sweep: allow
  auth_not_configured: 'El chasis no tiene configurada la autenticación de salida.', // lang-sweep: allow
  21408: 'La cuenta de Twilio no tiene permiso para enviar a esa región.', // lang-sweep: allow
  63005: 'El canal rechazó el mensaje por su contenido.', // lang-sweep: allow
  63007: 'El remitente de WhatsApp no está bien configurado.', // lang-sweep: allow
  63013: 'El contenido incumple la política de WhatsApp.', // lang-sweep: allow
  63015: 'WhatsApp no admite ese tipo de mensaje.', // lang-sweep: allow
  63016: 'Se intentó texto libre fuera de la ventana de 24 h: hay que enviar la plantilla aprobada.', // lang-sweep: allow
  63021: 'WhatsApp rechazó los parámetros de la plantilla.', // lang-sweep: allow
  63040: 'El remitente de WhatsApp no está registrado como tal.', // lang-sweep: allow
  63041: 'La plantilla no existe para ese remitente.', // lang-sweep: allow
  63042: 'La plantilla tiene un número de variables distinto del que se envió.', // lang-sweep: allow
  63051: 'El remitente de WhatsApp está inhabilitado.', // lang-sweep: allow
  20003: 'Twilio rechazó la autenticación de la cuenta.', // lang-sweep: allow
  20008: 'La cuenta está en modo de pruebas: no puede enviar de verdad.', // lang-sweep: allow
  campana_invalid: 'El chasis no reconoce la campaña que se le indicó.', // lang-sweep: allow
  // The chassis's own answers that carry a string `error` and no code: every
  // one of them is refused BEFORE any provider call (server.js 'pocketbase
  // not configured', 'smtp not configured', 'not configured', 'subject and
  // text required', 'invalid JSON', 'body too large'), so the same answer
  // would come back for every recipient.
  chassis_400: 'El chasis rechazó la petición tal como se la enviamos.', // lang-sweep: allow
  chassis_413: 'El chasis rechazó la petición por tamaño.', // lang-sweep: allow
  chassis_503: 'El chasis no tiene configurado el envío por ese canal.', // lang-sweep: allow
};

/**
 * Known infrastructure faults: park the send and retry it with backoff. The
 * lead is untouched and stays owed a message.
 *
 * `63049` is here and NOT in LEAD: internationally it is a throttle on
 * less-engaged recipients and Twilio prescribes retry-with-backoff, so
 * excluding on it would drop a reachable person for being quiet.
 *
 * `429` and `http_429` are both listed because a rate limit reaches us either
 * as a code or only as a status the classifier had to name itself.
 */
export const INFRA_TABLE = {
  63012: 'Error interno del canal de WhatsApp.', // lang-sweep: allow
  63018: 'Se superó el límite de mensajes por segundo de WhatsApp.', // lang-sweep: allow
  63038: 'Se agotó la cuota diaria de mensajes de la cuenta.', // lang-sweep: allow
  63049: 'WhatsApp está limitando los envíos a este destinatario: se reintenta más tarde.', // lang-sweep: allow
  20429: 'Demasiadas peticiones a Twilio: se reintenta más tarde.', // lang-sweep: allow
  ledger_unavailable: 'El chasis no pudo escribir su registro: el mensaje no llegó a salir.', // lang-sweep: allow
  auth_unavailable: 'No se pudo comprobar la credencial contra PocketBase.', // lang-sweep: allow
  429: 'Demasiadas peticiones: se reintenta más tarde.', // lang-sweep: allow
  http_429: 'Demasiadas peticiones: se reintenta más tarde.', // lang-sweep: allow
};

/**
 * The message may already have left. It is never retried (that is how one
 * person gets two copies) and never excluded (nobody did anything wrong): it
 * stays in flight until the ledger says what happened.
 */
export const AMBIGUOUS_TABLE = {
  provider_unavailable: 'El proveedor no confirmó el envío: puede haber salido.', // lang-sweep: allow
  chassis_timeout: 'El chasis no respondió a tiempo: el mensaje puede haber salido.', // lang-sweep: allow
  chassis_unreachable: 'No hubo respuesta del chasis: el mensaje puede haber salido.', // lang-sweep: allow
  // /send-email answers 502 'send failed' when something throws AFTER the
  // SMTP send resolved, and 500 'internal error' can follow a send too.
  chassis_502: 'El chasis falló después de intentar el envío: puede haber salido.', // lang-sweep: allow
  chassis_500: 'Error interno del chasis durante el envío: puede haber salido.', // lang-sweep: allow
  http_504: 'Una pasarela dejó de esperar al chasis: el mensaje puede haber salido.', // lang-sweep: allow
};

/** The reason given to a code no table knows. It is retried, never charged to anybody. */
export const UNKNOWN_REASON = 'Fallo no reconocido: se aparca y se reintenta, y el código se informa tal cual.'; // lang-sweep: allow
/** The reason given when the request got no HTTP answer at all. */
export const NO_ANSWER_REASON = 'La petición no obtuvo respuesta: el mensaje puede haber salido.'; // lang-sweep: allow

/**
 * The code a refusal will be filed under, never empty. Whitespace-trimmed,
 * newlines collapsed and truncated — but never "cleaned" into a different
 * string: rewriting `<21610>` into `21610` would let an HTML error page walk
 * into the LEAD table. Escaping for Telegram happens where the text is built.
 */
export const refusalCode = ({ code, status } = {}) => {
  const raw = String(code ?? '').replace(/\s+/g, ' ').trim();
  if (raw) return raw.slice(0, MAX_CODE);
  const s = Number(status);
  return Number.isInteger(s) && s >= 100 && s <= 599 ? `http_${s}` : 'sin_codigo';
};

/**
 * The code an HTTP answer from the chassis is filed under, following the
 * convention of whatsapp/src/chassis.js: the chassis's own `error.code` when
 * `error` is an OBJECT; `chassis_<status>` when the body is chassis JSON with
 * no code (`{error: 'smtp not configured'}` — a string is a sentence, never a
 * code); otherwise the classifier names it from the status (`http_<status>`),
 * which covers an HTML page from whatever sits in front of the chassis.
 */
export function answerCode(status, body) {
  const error = body && typeof body === 'object' ? body.error : undefined;
  if (error && typeof error === 'object' && !Array.isArray(error)) return error.code;
  if (body && typeof body === 'object' && !Array.isArray(body)) return `chassis_${status}`;
  return '';
}

/**
 * Classify one refusal.
 *
 * @param {{code?: unknown, status?: unknown, answered?: boolean}} refusal
 *   `answered: false` means the request got no HTTP answer at all (timeout,
 *   socket error) — which is ambiguous by definition, whatever else is passed.
 * @returns {{bucket: 'lead'|'run'|'infra'|'ambiguous', code: string,
 *            reason: string, known: boolean, scope?: string, guarded?: boolean}}
 */
export function classifyRefusal({ code, status, answered = true } = {}) {
  const key = refusalCode({ code, status });
  if (answered === false) {
    return { bucket: 'ambiguous', code: key, reason: NO_ANSWER_REASON, known: true };
  }
  if (Object.hasOwn(LEAD_TABLE, key)) {
    const entry = LEAD_TABLE[key];
    return {
      bucket: 'lead', code: key, reason: entry.reason, known: true,
      scope: entry.scope, guarded: entry.guarded === true,
    };
  }
  if (Object.hasOwn(RUN_TABLE, key)) return { bucket: 'run', code: key, reason: RUN_TABLE[key], known: true };
  if (Object.hasOwn(INFRA_TABLE, key)) return { bucket: 'infra', code: key, reason: INFRA_TABLE[key], known: true };
  if (Object.hasOwn(AMBIGUOUS_TABLE, key)) return { bucket: 'ambiguous', code: key, reason: AMBIGUOUS_TABLE[key], known: true };
  return { bucket: 'infra', code: key, reason: UNKNOWN_REASON, known: false };
}

/**
 * The single predicate that permits excluding a person: the code was
 * RECOGNISED and it was recognised as a fact about that lead. An unknown code
 * can never satisfy it, which is what makes an unfamiliar refusal cost a retry
 * instead of a cartera.
 */
export const mayExcludeLead = (verdict) => verdict?.known === true && verdict?.bucket === 'lead';
