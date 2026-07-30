// resumen.mjs — 20:00 Madrid: digest of the day (new leads, contacts by
// channel, email deliveries, properties published). Silent on empty days.
// The counting/formatting rules live in lib.mjs and are unit-tested.
// Data volume is small (one agent, one town), so we fetch full lists and
// let the pure code pick the Madrid-local day — no UTC boundary bugs.
import { resumenDelDia, textoResumen } from './lib.mjs';

export const when = { daily: '20:00' };

export async function run({ pb, notify, event, log, now }) {
  const [leads, actividades, propiedades] = await Promise.all([
    pb.collection('leads').getFullList(),
    pb.collection('actividades').getFullList(),
    pb.collection('propiedades').getFullList(),
  ]);
  const resumen = resumenDelDia({ leads, actividades, propiedades }, now);
  if (resumen.vacio) {
    log('resumen: empty day, staying silent');
    return;
  }
  // Event first, notify last (same rationale as agenda.mjs: duplicate rows
  // beat duplicate Telegram messages on retry).
  await event('project.daily_digest', resumen);
  await notify(textoResumen(resumen, now));
  log(`resumen: sent digest for ${resumen.dia}`);
}
