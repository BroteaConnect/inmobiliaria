// weekly-summary.mjs — Fridays 18:00 Madrid: the business summary of the week
// (Friday 18:00 → Friday 18:00): new leads by origin, contacts by channel,
// visits, publications, campaign sends, who is waiting for an answer right
// now, and today's funnel. Never silent: a week without movement is said.
// I/O only; every rule lives in weekly-summary.lib.mjs. Writes nothing to
// PocketBase: its only outputs are the event and the Telegram message.
import { textWeeklySummary, weeklySummary } from './weekly-summary.lib.mjs';

export const when = { daily: '18:00', dow: [5] };

// PocketBase filter literal: "YYYY-MM-DD HH:MM:SS.sssZ".
const pbDate = (d) => d.toISOString().replace('T', ' ');

export async function run({ pb, notify, event, log, now, env }) {
  if (!pb) throw new Error('weekly-summary: this project has no PocketBase client');
  // Eight days back covers the seven-day window whatever hour the run starts.
  const since = pbDate(new Date(now - 8 * 86_400_000));
  const [allLeads, actividades, visitas, propiedades] = await Promise.all([
    pb.collection('leads').getFullList(),
    pb.collection('actividades').getFullList({ filter: `created >= "${since}"` }),
    pb.collection('visitas').getFullList({ filter: `cuando >= "${since}" || created >= "${since}"` }),
    pb.collection('propiedades').getFullList(),
  ]);
  // The campaign ledger is a nice-to-have: unreadable, its line is left out.
  let envios = null;
  try {
    envios = await pb.collection('envios').getFullList({ filter: `created >= "${since}"` });
  } catch (e) {
    log(`weekly-summary: envios unavailable: ${e?.message ?? e}`);
  }
  const exclude = env?.CAMPAIGN_REPORT_LEAD_ID ? [String(env.CAMPAIGN_REPORT_LEAD_ID)] : [];
  const s = weeklySummary({ leads: allLeads, actividades, visitas, propiedades, envios, allLeads }, now, { excludeLeadIds: exclude });
  // Always said: the E6 gate reads this line.
  log(`weekly-summary: ${s.leads_nuevos} new lead(s) this week`);
  // Event first, notify last: a retry duplicates a harmless row, not a message.
  await event('project.weekly_summary', s);
  await notify(textWeeklySummary(s));
  return `summary for ${s.semana}`;
}
