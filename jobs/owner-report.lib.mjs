// owner-report.lib.mjs — pure rules of the monthly owner report DRAFTS
// (jobs/owner-report.mjs). No I/O; unit-tested in owner-report.lib.test.mjs.
//
// DRAFTS only: one per (owner, published property), rendered from the live
// `propietario.informe` template and shown to the team on Telegram for
// review. Nothing is sent to an owner — that is blocked on Meta approving the
// template and on the jobs' chassis secret.
import { ORIGEN_IMPORTADO, diaMadrid, escapeHtml, firstName, fitTelegram } from './lib.mjs';
import { madridParts, monthNameEs, previousMonth } from './madrid.lib.mjs';
import { render } from './campanas.lib.mjs';
import { safeName } from './pb-helpers.lib.mjs';

// Business rules (product decisions — change them here, in a PR).
export const TEMPLATE_KEY = 'propietario.informe';
export const MARKER_KEY = 'jobs.owner_report';
export const DUE_UNTIL_DAY = 7; // drafts are proposed in the first week of the month
export const MAX_TITLE = 60;
export const MAX_MESSAGE = 3900; // under Telegram's 4096 with room for the HTML
export const DEFAULT_AGENT = 'el equipo';
const MAX_DRAFT = 3000; // one draft block is cut here, so a chunk always fits it

/**
 * Whether the report is due at `now` for the previous Madrid month:
 * { due, month, why }. Due on a Madrid weekday (Mon–Fri) within the first
 * DUE_UNTIL_DAY days, when `lastMonth` (the marker) is not that month yet.
 */
export function reportDue(now, lastMonth) {
  const p = madridParts(now);
  const month = previousMonth(p.ymd.slice(0, 7));
  if (p.day > DUE_UNTIL_DAY) return { due: false, month, why: `day ${p.day} is past the first ${DUE_UNTIL_DAY}` };
  if (p.dow === 0 || p.dow === 6) return { due: false, month, why: 'weekend' };
  if (lastMonth === month) return { due: false, month, why: `${month} already drafted` };
  return { due: true, month, why: `first weekday run for ${month}` };
}

/** True when `date` falls in Madrid month 'YYYY-MM'. An unusable date is in no month. */
export const inMonth = (date, month) => (diaMadrid(date) ?? '').slice(0, 7) === month;

/**
 * One draft per published property with an owner (expanded as
 * `expand.propietario`): the template variables plus what the agent sees.
 *   contactos   leads asking about the property, created in the month, imports excluded
 *   visitas     visits held in the month (resultado realizada)
 *   visitas_agendadas / visitas_no_show   the month's visits not cancelled / no-shows
 *   actividad   actividades in the month on the property's leads
 *   no_enviable why it could not be sent anyway: sin teléfono, sin consentimiento
 */
export function ownerReports({ properties = [], leads = [], visitas = [], actividades = [] }, month, { agent = null } = {}) {
  const leadProperty = new Map(leads.map((l) => [l.id, l.propiedad]));
  const drafts = [];
  for (const p of properties) {
    const owner = p.expand?.propietario;
    if (p.estado !== 'publicada' || !owner) continue;
    const vis = visitas.filter((v) => v.propiedad === p.id && inMonth(v.cuando, month));
    const no_enviable = [];
    if (!String(owner.telefono ?? '').trim()) no_enviable.push('sin teléfono');
    if (!owner.consentimiento) no_enviable.push('sin consentimiento');
    drafts.push({
      propietario_id: owner.id,
      propiedad_id: p.id,
      nombre: firstName(safeName(owner.nombre)) || 'propietario',
      propiedad: String(p.titulo || 'su propiedad').slice(0, MAX_TITLE),
      mes: monthNameEs(month),
      agente: agent || DEFAULT_AGENT,
      contactos: leads.filter((l) => l.propiedad === p.id && l.origen !== ORIGEN_IMPORTADO && inMonth(l.created, month)).length,
      visitas: vis.filter((v) => v.resultado === 'realizada').length,
      visitas_agendadas: vis.filter((v) => v.resultado !== 'cancelada').length,
      visitas_no_show: vis.filter((v) => v.resultado === 'no_show').length,
      actividad: actividades.filter((a) => leadProperty.get(a.lead) === p.id && inMonth(a.created, month)).length,
      no_enviable,
    });
  }
  return drafts;
}

const VARIABLES = ['nombre', 'mes', 'propiedad', 'visitas', 'contactos', 'agente', 'actividad'];

/** The text an owner would receive, or null without a template body. */
const body = (d, template) => (template?.cuerpo_es ? render(template.cuerpo_es, d) : null);

function draftBlock(d, template) {
  const text = body(d, template);
  const shown = text ?? VARIABLES.map((k) => `${k}=${d[k]}`).join(' · ');
  const lines = [
    `🏠 <b>${escapeHtml(d.propiedad)}</b> → ${escapeHtml(d.nombre)}`,
    `Contactos ${d.contactos} · visitas realizadas ${d.visitas} (agendadas ${d.visitas_agendadas}, no se presentaron ${d.visitas_no_show}) · actividad ${d.actividad}`,
    `<i>${escapeHtml(shown)}</i>`,
  ];
  if (d.no_enviable.length) lines.push(`⚠️ no enviable: ${d.no_enviable.join(', ')}`);
  const block = lines.join('\n');
  return block.length > MAX_DRAFT ? `${lines.slice(0, 2).join('\n')}\n<i>(borrador demasiado largo para mostrarlo)</i>` : block;
}

/**
 * The Telegram messages for the drafts: an array of strings, each under
 * MAX_MESSAGE chars, never splitting a draft. Header on the first, footer on
 * the last. [] when there are no drafts.
 */
export function textOwnerReports(drafts, template, label) {
  if (!drafts.length) return [];
  const n = drafts.length;
  const header = `📨 <b>Informes a propietarios</b> — ${escapeHtml(label)} · ${n} ${n === 1 ? 'borrador' : 'borradores'} para revisar`
    + (template?.cuerpo_es ? '' : '\n(no hay plantilla propietario.informe: se muestran las variables)');
  const footer = 'Nada se ha enviado: falta la aprobación de Meta de la plantilla propietario.informe.';
  const chunks = [];
  let cur = header;
  for (const d of drafts) {
    const block = draftBlock(d, template);
    if (cur.length + 2 + block.length > MAX_MESSAGE) {
      chunks.push(cur);
      cur = block;
    } else {
      cur += `\n\n${block}`;
    }
  }
  if (cur.length + 2 + footer.length > MAX_MESSAGE) {
    chunks.push(cur);
    cur = footer;
  } else {
    cur += `\n\n${footer}`;
  }
  chunks.push(cur);
  // Already under MAX_MESSAGE by construction; the guard is the same last
  // line of defence every E6 message has.
  return chunks.map(fitTelegram);
}
