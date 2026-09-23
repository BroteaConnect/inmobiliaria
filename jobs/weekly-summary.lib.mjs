// weekly-summary.lib.mjs — pure rules of the Friday 18:00 business summary
// (jobs/weekly-summary.mjs). No I/O; unit-tested in weekly-summary.lib.test.mjs.
//
// The week is Friday 18:00 → Friday 18:00 on the Madrid wall clock: seven
// local days, which is 167 or 169 hours on the weeks DST changes. Counting
// rules are the daily digest's (lib.mjs resumenDelDia) stretched to a week:
// an import is not lead generation, a note is not a contact. There is no
// stage history in the CRM, so the funnel is today's snapshot, never "moved
// from visita to oferta this week".
import { ORIGEN_IMPORTADO, PIE_CRM, escapeHtml, esFecha, parseFecha } from './lib.mjs';
import { addDays, madridParts, madridWallTime } from './madrid.lib.mjs';
import { unansweredStreaks } from './unanswered.lib.mjs';

export const CLOSE_DOW = 5; // Friday
export const CLOSE_HOUR = 18;
export const MAX_KEY = 40; // an origen comes from a form or an import: cut before it becomes a key
export const ETAPAS = ['nuevo', 'contactado', 'visita', 'oferta', 'reservado', 'vendido', 'nutriendo'];

const atClose = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return madridWallTime(y, m, d, CLOSE_HOUR, 0);
};

/** The last complete week at `now`: { desde, hasta } Dates, desde inclusive, hasta exclusive. */
export function weekWindow(now) {
  const p = madridParts(now);
  let ymd = addDays(p.ymd, -((p.dow - CLOSE_DOW + 7) % 7)); // this or the last Friday
  if (atClose(ymd) > now) ymd = addDays(ymd, -7);
  return { desde: atClose(addDays(ymd, -7)), hasta: atClose(ymd) };
}

/** True when `date` falls in [desde, hasta). An unusable date is in no week. */
export function inWeek(date, win) {
  const d = parseFecha(date);
  return esFecha(d) && d >= win.desde && d < win.hasta;
}

/** ISO-8601 week of a 'YYYY-MM-DD' day: '2026-01-01' → '2026-W01'. */
export function isoWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // the Thursday of that week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const tally = (items, keyOf) => {
  const m = new Map(); // user data as keys — a "__proto__" origen stays inert
  for (const it of items) {
    const k = keyOf(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
};
const bucket = (s, empty) => String(s ?? '').trim().slice(0, MAX_KEY) || empty;

/**
 * The week's counts. `envios` null means the ledger could not be read (the
 * section is then left out, not reported as zero). `allLeads` feeds the
 * funnel snapshot; `excludeLeadIds` is passed to the unanswered rule.
 */
export function weeklySummary({ leads = [], actividades = [], visitas = [], propiedades = [], envios = null, allLeads = leads }, now, { excludeLeadIds = [] } = {}) {
  const win = weekWindow(now);
  const hastaDay = madridParts(new Date(win.hasta - 1)).ymd;
  const inW = (d) => inWeek(d, win);

  const leadsW = leads.filter((l) => inW(l.created));
  const nuevos = leadsW.filter((l) => l.origen !== ORIGEN_IMPORTADO);
  const actsW = actividades.filter((a) => inW(a.created));
  const salientes = actsW.filter((a) => a.direccion === 'saliente' && a.tipo !== 'nota');
  const contactos_por_canal = tally(salientes, (a) => bucket(a.tipo, 'sin canal'));
  const envios_w = envios ? envios.filter((e) => inW(e.created)) : null;
  const embudoAll = tally(allLeads, (l) => bucket(l.etapa, 'sin etapa'));
  const embudo = Object.fromEntries([
    ...ETAPAS.filter((e) => embudoAll[e]).map((e) => [e, embudoAll[e]]),
    ...Object.entries(embudoAll).filter(([e]) => !ETAPAS.includes(e)),
  ]);

  return {
    semana: isoWeek(hastaDay),
    desde: madridParts(win.desde).ymd,
    hasta: hastaDay,
    leads_nuevos: nuevos.length,
    importados: leadsW.length - nuevos.length,
    por_origen: tally(nuevos, (l) => bucket(l.origen, 'sin origen')),
    contactos: salientes.length,
    contactos_por_canal,
    entrantes: actsW.filter((a) => a.direccion === 'entrante').length,
    visitas: visitas.filter((v) => inW(v.cuando) && v.resultado === 'realizada').length,
    visitas_agendadas: visitas.filter((v) => inW(v.created) && v.resultado !== 'cancelada').length,
    visitas_no_show: visitas.filter((v) => inW(v.cuando) && v.resultado === 'no_show').length,
    publicadas: propiedades.filter((p) => p.estado === 'publicada' && inW(p.updated || p.created)).length,
    envios: envios_w ? { total: envios_w.length, por_estado: tally(envios_w, (e) => bucket(e.estado, 'sin estado')) } : null,
    sin_respuesta: unansweredStreaks(actividades, now, { excludeLeadIds }).length,
    embudo,
  };
}

const dayFmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const shortDay = (ymd) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));
const list = (o) => Object.entries(o).map(([k, n]) => `${n} ${escapeHtml(k)}`).join(', ');

/** The Friday message (HTML). Never null: a quiet week is news too. */
export function textWeeklySummary(s) {
  const lines = [];
  const quiet = s.leads_nuevos + s.importados + s.contactos + s.entrantes + s.visitas + s.visitas_agendadas
    + s.visitas_no_show + s.publicadas + (s.envios?.total ?? 0) === 0;
  if (quiet) {
    lines.push('Semana sin movimiento: ni leads nuevos, ni contactos, ni visitas.');
  } else {
    lines.push(`• Leads nuevos: <b>${s.leads_nuevos}</b>${s.leads_nuevos ? ` (${list(s.por_origen)})` : ''}`);
    if (s.importados) lines.push(`• Importados a la cartera: ${s.importados}`);
    lines.push(`• Contactos salientes: <b>${s.contactos}</b>${s.contactos ? ` (${list(s.contactos_por_canal)})` : ''}`);
    if (s.entrantes) lines.push(`• Mensajes entrantes: ${s.entrantes}`);
    lines.push(`• Visitas realizadas: <b>${s.visitas}</b>`
      + (s.visitas_agendadas ? ` · agendadas esta semana: ${s.visitas_agendadas}` : '')
      + (s.visitas_no_show ? ` · no se presentaron: ${s.visitas_no_show}` : ''));
    if (s.publicadas) lines.push(`• Propiedades publicadas o actualizadas: ${s.publicadas}`);
    if (s.envios?.total) lines.push(`• Envíos de campañas: ${s.envios.total} (${list(s.envios.por_estado)})`);
  }
  if (s.sin_respuesta) lines.push(`• ⏰ Ahora mismo, ${s.sin_respuesta} ${s.sin_respuesta === 1 ? 'lead espera' : 'leads esperan'} respuesta desde hace más de 2 h`);
  const embudo = Object.entries(s.embudo).map(([e, n]) => `${escapeHtml(e)} ${n}`).join(' · ');
  if (embudo) lines.push('', `Embudo hoy: ${embudo}`);
  return [
    `📊 <b>Resumen de la semana</b> — ${s.semana.replace(/^\d{4}-W0?/, 'semana ')} · ${shortDay(s.desde)} → ${shortDay(s.hasta)}:`,
    '',
    ...lines,
    '',
    PIE_CRM,
  ].join('\n');
}

