// agenda.mjs — 09:00 Madrid: one digest with the leads waiting >48h for a
// contact, oldest first. Silent when nobody is waiting. All the rules
// (threshold, exclusions, copy) live in lib.mjs and are unit-tested.
import { desatendidos, textoAgenda, ETAPAS_EXCLUIDAS } from './lib.mjs';

export const when = { daily: '09:00' };

export async function run({ pb, notify, event, log, now }) {
  const filter = ETAPAS_EXCLUIDAS.map((e) => `etapa != "${e}"`).join(' && ');
  const leads = await pb.collection('leads').getFullList({ filter });
  const stale = desatendidos(leads, now);
  if (!stale.length) {
    log('agenda: no unattended leads, staying silent');
    return;
  }
  // Event first, notify last: if a retry replays the job after a partial
  // failure, a duplicate event row is harmless — a duplicate Telegram blast
  // is not.
  await event('lead.reminder_sent', { count: stale.length, oldest: stale[0].id });
  await notify(textoAgenda(stale, now));
  log(`agenda: notified ${stale.length} unattended lead(s)`);
}
