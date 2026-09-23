// agenda.mjs — 09:00 Madrid: one digest with today's visits (earliest first)
// and the leads waiting >48h for a contact, oldest first. Silent when there
// is nothing of either. All the rules (day boundary, threshold, exclusions,
// copy) live in lib.mjs and are unit-tested.
import { desatendidos, textoAgenda, visitasDeHoy, textoVisitas, ETAPAS_EXCLUIDAS } from './lib.mjs';

export const when = { daily: '09:00' };

const MS_DAY = 86_400_000;
// PocketBase filter literal: "YYYY-MM-DD HH:MM:SS.sssZ".
const pbDate = (d) => d.toISOString().replace('T', ' ');

// A UTC window wide enough to contain the whole Madrid-local day of `now`:
// from yesterday 00:00Z to tomorrow 23:59:59Z. Which of those visits are
// "today" is decided by visitasDeHoy(), in Madrid time — the window only
// keeps the query from paging through the entire history.
const ventanaVisitas = (now) => {
  const dia = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { desde: pbDate(new Date(dia - MS_DAY)), hasta: pbDate(new Date(dia + 2 * MS_DAY)) };
};

export async function run({ pb, notify, event, log, now }) {
  const filter = ETAPAS_EXCLUIDAS.map((e) => `etapa != "${e}"`).join(' && ');
  const leads = await pb.collection('leads').getFullList({ filter });
  const stale = desatendidos(leads, now);

  // The visits query must never take the stale-lead reminder down with it:
  // a failed fetch is logged and the morning goes on with no visits section,
  // instead of throwing out of run() and opening the circuit after 3 mornings.
  let visits = [];
  try {
    const { desde, hasta } = ventanaVisitas(now);
    const visitas = await pb.collection('visitas').getFullList({
      filter: `cuando >= "${desde}" && cuando < "${hasta}"`,
      expand: 'lead,propiedad,agente',
      sort: 'cuando',
    });
    visits = visitasDeHoy(visitas, now);
  } catch (e) {
    log(`agenda: visits unavailable: ${e?.message ?? e}`);
  }
  // Always said, even when silent or degraded: the E4 gate reads this line.
  log(`agenda: ${visits.length} visit(s) today`);

  if (!stale.length && !visits.length) {
    log('agenda: no unattended leads, staying silent');
    return;
  }
  // Events first, notify last: if a retry replays the job after a partial
  // failure, a duplicate event row is harmless — a duplicate Telegram blast
  // is not. lead.reminder_sent keeps meaning "there were stale leads" (its
  // `oldest` is never null); agenda.sent is the digest itself.
  if (stale.length) {
    await event('lead.reminder_sent', { count: stale.length, oldest: stale[0].id, visits: visits.length });
  }
  await event('agenda.sent', { visits: visits.length, unattended: stale.length });
  const digest = [textoVisitas(visits, now), textoAgenda(stale, now)].filter(Boolean).join('\n\n');
  await notify(digest);
  log(`agenda: notified ${stale.length} unattended lead(s) and ${visits.length} visit(s)`);
}
