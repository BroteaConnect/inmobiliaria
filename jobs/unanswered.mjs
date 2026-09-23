// unanswered.mjs — hourly: a lead who wrote (WhatsApp or email) and has had
// no outbound row for more than 2 h is announced to the team's Telegram topic,
// once per unanswered streak. I/O only; every rule lives in unanswered.lib.mjs.
//
// Safety: this job never writes to a lead and never sends anything to one. Its
// one PocketBase write is its own settings row `jobs.unanswered` (the anchors
// already alerted), skipped under --dry-run. Order: events → marker → notify,
// so a retry after a partial failure repeats a harmless row, not a Telegram
// message. Outside 09:00–21:00 Madrid the alerts are held (nothing is written)
// and go out at the first run after 09:00 — still unanswered, still unalerted.
import {
  FETCH_HOURS, MARKER_KEY, dueAlerts, insideAlertHours, markAlerted, pruneMarker, textUnanswered, unansweredStreaks,
} from './unanswered.lib.mjs';
import { RECORD_ID, onDutyName, readMarker, writeMarker } from './pb-helpers.lib.mjs';

export const when = { hourly: true };

// PocketBase filter literal: "YYYY-MM-DD HH:MM:SS.sssZ".
const pbDate = (d) => d.toISOString().replace('T', ' ');

export async function run({ pb, notify, event, log, now, dryRun, env }) {
  if (!pb) throw new Error('unanswered: this project has no PocketBase client');
  const since = pbDate(new Date(now - FETCH_HOURS * 3_600_000));
  const actividades = await pb.collection('actividades').getFullList({ filter: `created >= "${since}"`, sort: 'created' });
  const exclude = env?.CAMPAIGN_REPORT_LEAD_ID ? [String(env.CAMPAIGN_REPORT_LEAD_ID)] : [];
  // An id that is not a record id is not a lead we can name or filter on.
  const streaks = unansweredStreaks(actividades, now, { excludeLeadIds: exclude })
    .filter((s) => RECORD_ID.test(s.lead_id) && RECORD_ID.test(s.activity_id));
  // Always said, even when nothing is due: the E6 gate reads this line.
  log(`unanswered: ${streaks.length} lead(s) waiting over 2h`);

  const marker = pruneMarker(await readMarker(pb, MARKER_KEY), now);
  const due = dueAlerts(streaks, marker);
  if (!due.length) return `${streaks.length} waiting, none new`;
  if (!insideAlertHours(now)) {
    log(`unanswered: holding ${due.length} alert(s) until 09:00`);
    return `${due.length} held`;
  }

  const ids = [...new Set(due.map((s) => s.lead_id))];
  const leads = await pb.collection('leads').getFullList({
    filter: ids.map((id) => `id = "${id}"`).join(' || '),
    expand: 'asignado',
  });
  const leadsById = new Map(leads.map((l) => [l.id, l]));
  const onDuty = await onDutyName(pb, log, 'unanswered');

  for (const s of due) {
    await event('lead.unanswered_alert', { lead_id: s.lead_id, activity_id: s.activity_id, waited_min: s.waited_min });
  }
  await writeMarker(pb, MARKER_KEY, markAlerted(marker, due, now), dryRun, log);
  await notify(textUnanswered(due, leadsById, onDuty));
  return `${due.length} alerted`;
}
