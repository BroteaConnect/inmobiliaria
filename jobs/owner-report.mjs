// owner-report.mjs — daily 10:00 Madrid, acting on the first weekday of the
// month (within its first 7 days): one DRAFT of the monthly report per owner
// and published property, for the previous month, shown to the team on
// Telegram for review. I/O only; every rule lives in owner-report.lib.mjs.
//
// Safety: nothing is ever sent to an owner — no chassis call, no WhatsApp,
// no email, no owner_report.sent event. Sending is blocked on Meta approving
// the `propietario.informe` template and on the jobs' chassis secret. The one
// PocketBase write is the job's own settings row `jobs.owner_report`
// ({ v: 1, last_month }), skipped under --dry-run. Under --dry-run the
// calendar and marker verdict is logged but bypassed, so a rehearsal always
// shows the drafts. Order: event → every message → marker.
import { MARKER_KEY, TEMPLATE_KEY, ownerReports, reportDue, textOwnerReports } from './owner-report.lib.mjs';
import { monthNameEs } from './madrid.lib.mjs';
import { onDutyName, readMarker, writeMarker } from './pb-helpers.lib.mjs';

export const when = { daily: '10:00' };

// PocketBase filter literal: "YYYY-MM-DD HH:MM:SS.sssZ".
const pbDate = (d) => d.toISOString().replace('T', ' ');
const MS_DAY = 86_400_000;

// A UTC window a day wider than the Madrid month on each side; which rows
// fall in the month is decided by inMonth(), in Madrid time.
const monthWindow = (month) => {
  const [y, m] = month.split('-').map(Number);
  return { desde: pbDate(new Date(Date.UTC(y, m - 1, 1) - MS_DAY)), hasta: pbDate(new Date(Date.UTC(y, m, 1) + MS_DAY)) };
};

export async function run({ pb, notify, event, log, now, dryRun }) {
  if (!pb) throw new Error('owner-report: this project has no PocketBase client');
  const marker = await readMarker(pb, MARKER_KEY);
  const lastMonth = marker?.v === 1 ? marker.last_month ?? null : null;
  const verdict = reportDue(now, lastMonth);
  if (!verdict.due) {
    if (!dryRun) {
      log(`owner-report: not due (${verdict.why})`);
      return `not due: ${verdict.why}`;
    }
    log(`owner-report: dry-run: not due (${verdict.why}), drafting ${verdict.month} anyway`);
  }
  const { month } = verdict;
  const { desde, hasta } = monthWindow(month);

  const [properties, leads, visitas, actividades] = await Promise.all([
    pb.collection('propiedades').getFullList({ filter: 'estado = "publicada"', expand: 'propietario' }),
    pb.collection('leads').getFullList({ filter: 'propiedad != ""' }),
    pb.collection('visitas').getFullList({ filter: `cuando >= "${desde}" && cuando < "${hasta}"` }),
    pb.collection('actividades').getFullList({ filter: `created >= "${desde}" && created < "${hasta}"` }),
  ]);
  // The template and the agent's name are presentation: missing, the drafts
  // still go out (the variables shown, "el equipo" signing).
  let template = null;
  try {
    const rows = await pb.collection('plantillas').getFullList({ filter: `clave = "${TEMPLATE_KEY}"` });
    template = rows[0] ?? null;
  } catch (e) {
    log(`owner-report: template unavailable: ${e?.message ?? e}`);
  }
  if (!template) log(`owner-report: no ${TEMPLATE_KEY} template, showing the variables`);
  const agent = await onDutyName(pb, log, 'owner-report');

  const drafts = ownerReports({ properties, leads, visitas, actividades }, month, { agent });
  // Always said, even with zero drafts.
  log(`owner-report: ${drafts.length} draft(s) for ${month}`);
  const newMarker = { v: 1, last_month: month };
  if (!drafts.length) {
    await writeMarker(pb, MARKER_KEY, newMarker, dryRun, log);
    return `no drafts for ${month}`;
  }
  await event('owner_report.drafted', {
    count: drafts.length,
    month,
    owners: new Set(drafts.map((d) => d.propietario_id)).size,
    not_sendable: drafts.filter((d) => d.no_enviable.length).length,
  });
  // Every chunk before the marker: a send that fails half-way leaves the
  // month unmarked, so the next run drafts it again instead of losing half.
  for (const chunk of textOwnerReports(drafts, template, monthNameEs(month))) await notify(chunk);
  await writeMarker(pb, MARKER_KEY, newMarker, dryRun, log);
  return `${drafts.length} draft(s) for ${month}`;
}
