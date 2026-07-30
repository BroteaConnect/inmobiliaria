// lib.mjs — pure selection/formatting logic for the scheduled jobs.
// No I/O, no PocketBase imports: everything here is unit-tested with
// `node --test jobs/`. The Telegram strings are Spanish (the team reads
// Spanish); everything else is English.
//
// Timezone rule: the "day" is always the Europe/Madrid local day, computed
// with Intl.DateTimeFormat — never by adding fixed offsets (DST would
// silently shift it twice a year).

const MS_HOUR = 3_600_000;
const MS_DAY = 24 * MS_HOUR;

// Business rules (product decisions — change them here, in a PR).
export const STALE_HOURS = 48; // a lead is unattended after this silence
export const ALERT_DAYS = 5; // ⚠️ escalation after this many days waiting
export const MAX_LINES = 10; // agenda cap; the rest becomes "… y N más"
export const MAX_NOMBRE = 80; // nombre comes from a public form — an unbounded
// name could push the message past Telegram's 4096-char limit and kill the job
// Same exclusions as the CRM's desatendido() (inmobiliaria-crm api.ts):
// 'nutriendo' is deliberately parked, 'vendido' needs no chasing.
export const ETAPAS_EXCLUIDAS = ['nutriendo', 'vendido'];

// PocketBase serializes dates as "YYYY-MM-DD HH:MM:SS.sssZ" (space, not T).
export const parseFecha = (s) => (s instanceof Date ? s : new Date(String(s).replace(' ', 'T')));

// The staleness clock: a brand-new lead nobody ever touched has no
// ultimo_contacto at all — falling back to created is what makes it appear.
export const relojLead = (lead) => parseFecha(lead.ultimo_contacto || lead.created);

// YYYY-MM-DD of the Europe/Madrid local day for a given instant.
const madridDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const diaMadrid = (date) => madridDay.format(parseFecha(date));

const madridHeader = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long',
});

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "hace 3 días" / "hace 1 día" / "hace 5 horas" / "hace menos de una hora"
export function haceCuanto(date, now) {
  const ms = now - parseFecha(date);
  const days = Math.floor(ms / MS_DAY);
  if (days >= 1) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  const hours = Math.floor(ms / MS_HOUR);
  if (hours >= 1) return `hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  return 'hace menos de una hora';
}

// Leads with no contact for > STALE_HOURS, excluding parked/won stages,
// sorted oldest-wait-first (the most abandoned lead leads the list).
export function desatendidos(leads, now) {
  return leads
    .filter((l) => !ETAPAS_EXCLUIDAS.includes(l.etapa))
    .filter((l) => now - relojLead(l) > STALE_HOURS * MS_HOUR)
    .sort((a, b) => relojLead(a) - relojLead(b));
}

// The 09:00 agenda message (HTML). Returns null when there is nothing to
// say — silence is a feature.
export function textoAgenda(stale, now) {
  if (!stale.length) return null;
  const lines = stale.slice(0, MAX_LINES).map((l) => {
    const since = relojLead(l);
    const warn = now - since > ALERT_DAYS * MS_DAY ? '⚠️ ' : '';
    const nombre = escapeHtml(String(l.nombre).slice(0, MAX_NOMBRE));
    return `• ${warn}<b>${nombre}</b> — ${escapeHtml(l.etapa || 'sin etapa')} · ${haceCuanto(since, now)}`;
  });
  if (stale.length > MAX_LINES) lines.push(`… y ${stale.length - MAX_LINES} más`);
  const n = stale.length;
  return [
    `📋 <b>Agenda</b> — ${n} ${n === 1 ? 'lead lleva' : 'leads llevan'} más de ${STALE_HOURS} h sin contacto:`,
    '',
    ...lines,
    '',
    'Abre el CRM y dales salida: https://crm-inmobiliaria.brotea.dev',
  ].join('\n');
}

// Counts for the Madrid-local day of `now`.
// - nuevos: leads created today
// - contactos: outbound actividades by channel (notes are not contacts)
// - entrantes: inbound actividades (any channel)
// - emailsEntregados: email actividades whose estado_envio reached delivery
//   (entregado/abierto/click — the webhook never degrades a state)
// - publicadas: propiedades in estado "publicada" last touched today (best
//   available proxy: there is no state-change log)
export function resumenDelDia({ leads = [], actividades = [], propiedades = [] }, now) {
  const hoy = diaMadrid(now);
  const deHoy = (r) => diaMadrid(r.created) === hoy;

  const nuevos = leads.filter(deHoy).length;

  const actsHoy = actividades.filter(deHoy);
  const contactos = Object.create(null); // a.tipo as key — keep __proto__ inert
  for (const a of actsHoy) {
    if (a.direccion !== 'saliente' || a.tipo === 'nota') continue;
    contactos[a.tipo] = (contactos[a.tipo] || 0) + 1;
  }
  const entrantes = actsHoy.filter((a) => a.direccion === 'entrante').length;
  const emailsEntregados = actsHoy.filter(
    (a) => a.tipo === 'email' && ['entregado', 'abierto', 'click'].includes(a.estado_envio),
  ).length;

  const publicadas = propiedades.filter(
    (p) => p.estado === 'publicada' && diaMadrid(p.updated || p.created) === hoy,
  ).length;

  const totalContactos = Object.values(contactos).reduce((s, n) => s + n, 0);
  const vacio = nuevos + totalContactos + entrantes + emailsEntregados + publicadas === 0;
  return { dia: hoy, nuevos, contactos, entrantes, emailsEntregados, publicadas, vacio };
}

// The 20:00 digest (HTML). Returns null when the day was empty.
export function textoResumen(resumen, now) {
  if (!resumen || resumen.vacio) return null;
  const lines = [];
  if (resumen.nuevos) lines.push(`• Leads nuevos: <b>${resumen.nuevos}</b>`);
  const canales = Object.entries(resumen.contactos)
    .map(([tipo, n]) => `${n} ${escapeHtml(tipo)}`)
    .join(', ');
  if (canales) lines.push(`• Contactos salientes: ${canales}`);
  if (resumen.entrantes) lines.push(`• Mensajes entrantes: ${resumen.entrantes}`);
  if (resumen.emailsEntregados) lines.push(`• Emails entregados: ${resumen.emailsEntregados}`);
  if (resumen.publicadas) lines.push(`• Propiedades publicadas: ${resumen.publicadas}`);
  return [`🌙 <b>Resumen del día</b> — ${madridHeader.format(now)}:`, '', ...lines].join('\n');
}
