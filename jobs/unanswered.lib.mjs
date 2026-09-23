// unanswered.lib.mjs — pure rules of the hourly "nobody answered in two hours"
// alert (jobs/unanswered.mjs). No I/O; unit-tested in unanswered.lib.test.mjs.
//
// A streak is what a lead wrote since the team last wrote to them: every
// actividades row on the lead, oldest first; an outbound row of ANY tipo (a
// note typed as saliente included — the agent says they replied) closes the
// streak, and the FIRST inbound whatsapp/email after it opens the next one.
// That first inbound is the anchor: one alert per unanswered streak, however
// many messages the lead sends while waiting.
import { MAX_LINES, PIE_CRM, esFecha, horaMadrid, parseFecha, recorta } from './lib.mjs';
import { madridParts } from './madrid.lib.mjs';
import { safeName } from './pb-helpers.lib.mjs';

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

// Business rules (product decisions — change them here, in a PR).
export const UNANSWERED_MIN = 120; // an inbound waiting this long is alerted
export const LOOKBACK_HOURS = 24; // an older anchor is the 09:00 agenda's job, not an alert
export const FETCH_HOURS = 48; // rows read: enough to see the reply before a 24 h-old anchor
export const INBOUND_TIPOS = ['whatsapp', 'email']; // a lead does not "call in" through the CRM
export const ALERT_FROM_HOUR = 9; // Madrid; alerts are held outside [09:00, 21:00)
export const ALERT_UNTIL_HOUR = 21;
export const MARKER_KEY = 'jobs.unanswered';
export const MARKER_DAYS = 7; // alerted anchors remembered this long

/**
 * Unanswered streaks at `now`, oldest wait first:
 * [{ lead_id, activity_id, tipo, created, waited_min }].
 * A row with an unusable date is ignored entirely; an anchor older than
 * LOOKBACK_HOURS or younger than UNANSWERED_MIN is not a streak to alert.
 */
export function unansweredStreaks(actividades, now, { excludeLeadIds = [] } = {}) {
  const byLead = new Map(); // lead id as key — a "__proto__" id stays inert
  const rows = actividades
    .map((a) => ({ a, t: parseFecha(a?.created) }))
    .filter(({ a, t }) => a?.lead && esFecha(t))
    .sort((x, y) => x.t - y.t);
  for (const { a, t } of rows) {
    const lead = String(a.lead);
    if (a.direccion === 'saliente') byLead.set(lead, null);
    else if (a.direccion === 'entrante' && INBOUND_TIPOS.includes(a.tipo) && !byLead.get(lead)) {
      byLead.set(lead, { a, t });
    }
  }
  const out = [];
  for (const [lead, anchor] of byLead) {
    if (!anchor || excludeLeadIds.includes(lead)) continue;
    const waited = Math.floor((now - anchor.t) / MS_MIN);
    if (waited < UNANSWERED_MIN || waited > LOOKBACK_HOURS * 60) continue;
    out.push({ lead_id: lead, activity_id: String(anchor.a.id), tipo: anchor.a.tipo, created: anchor.a.created, waited_min: waited });
  }
  return out.sort((x, y) => y.waited_min - x.waited_min);
}

/** A marker in any shape but { v: 1, alerted: {...} } counts as empty. */
const alertedOf = (marker) =>
  (marker?.v === 1 && marker.alerted && typeof marker.alerted === 'object' && !Array.isArray(marker.alerted) ? marker.alerted : {});

/** The streaks whose anchor has not been alerted yet. */
export const dueAlerts = (streaks, marker) => {
  const alerted = alertedOf(marker);
  return streaks.filter((s) => !Object.hasOwn(alerted, s.activity_id));
};

/** The marker without entries older than MARKER_DAYS (or with an unusable date). */
export function pruneMarker(marker, now) {
  const kept = Object.entries(alertedOf(marker)).filter(([, iso]) => {
    const d = parseFecha(iso);
    return esFecha(d) && now - d <= MARKER_DAYS * MS_DAY;
  });
  return { v: 1, alerted: Object.fromEntries(kept) };
}

/** A new marker with `alerts` stamped at `now`; the input is not modified. */
export const markAlerted = (marker, alerts, now) => ({
  v: 1,
  alerted: { ...alertedOf(marker), ...Object.fromEntries(alerts.map((s) => [s.activity_id, now.toISOString()])) },
});

/** True inside [09:00, 21:00) Madrid wall-clock time. */
export function insideAlertHours(now) {
  const p = madridParts(now);
  return Boolean(p) && p.hour >= ALERT_FROM_HOUR && p.hour < ALERT_UNTIL_HOUR;
}

/** "2 h 15 min" / "2 h" / "45 min". */
export function waitText(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const CANAL = { whatsapp: 'WhatsApp', email: 'email' };

/**
 * The alert (HTML), or null when there is nothing to say. `leadsById` is a
 * Map of lead id → lead (with `expand.asignado`); `onDuty` the on-duty
 * agent's name or null.
 */
export function textUnanswered(alerts, leadsById, onDuty) {
  if (!alerts.length) return null;
  const lines = alerts.slice(0, MAX_LINES).map((s) => {
    const lead = leadsById.get(s.lead_id);
    const nombre = recorta(safeName(lead?.nombre) || 'lead sin nombre');
    const asignado = safeName(lead?.expand?.asignado?.name);
    const agente = asignado ? recorta(asignado) : onDuty ? `${recorta(onDuty)} (guardia)` : 'sin asignar';
    const canal = CANAL[s.tipo] ?? recorta(s.tipo || 'canal desconocido');
    return `• <b>${nombre}</b> · ${canal} · ${waitText(s.waited_min)} (desde las ${horaMadrid(s.created)}) · ${agente}`;
  });
  if (alerts.length > MAX_LINES) lines.push(`… y ${alerts.length - MAX_LINES} más`);
  const n = alerts.length;
  return [
    `⏰ <b>Sin respuesta</b> — ${n} ${n === 1 ? 'lead lleva' : 'leads llevan'} más de 2 h esperando:`,
    '',
    ...lines,
    '',
    'Si ya contestaste fuera del CRM, regístralo allí.',
    PIE_CRM,
  ].join('\n');
}
