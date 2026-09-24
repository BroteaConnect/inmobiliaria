// reactivation.mjs — Mondays 10:00 Madrid: which dormant leads (no contact
// for 30+ days, no deal in progress, consent not revoked) fit the stock that
// is published today. A PROPOSAL to the team on Telegram, nothing more.
//
// Safety: this job never sends anything to a lead, never calls the chassis
// and never writes to PocketBase (decision 3: no message to real leads before
// CU-15 has run and the owner said yes). It never emits reactivation.sent.
// I/O only; every rule lives in reactivation.lib.mjs and lib.mjs.
import { normalizarLeads, vocabularioZonas } from './lib.mjs';
import { DORMANT_DAYS, dormantLeads, reactivationProposals, textReactivation } from './reactivation.lib.mjs';
import { onDutyName } from './pb-helpers.lib.mjs';

export const when = { daily: '10:00', dow: [1] };

// PocketBase filter literal: "YYYY-MM-DD HH:MM:SS.sssZ".
const pbDate = (d) => d.toISOString().replace('T', ' ');

export async function run({ pb, notify, event, log, now }) {
  if (!pb) throw new Error('reactivation: this project has no PocketBase client');
  // Every property builds the zone vocabulary; only the published ones are offered.
  // The recent activity is essential, not decoration: unreadable, the job
  // fails rather than propose a lead who wrote yesterday.
  const since = pbDate(new Date(now - DORMANT_DAYS * 86_400_000));
  const [all, leads, recent] = await Promise.all([
    pb.collection('propiedades').getFullList(),
    pb.collection('leads').getFullList({ expand: 'propiedad,asignado' }),
    pb.collection('actividades').getFullList({ filter: `created >= "${since}"` }),
  ]);
  const published = all.filter((p) => p.estado === 'publicada');
  const activeLeadIds = new Set(recent.map((a) => a.lead).filter(Boolean));
  const dormant = dormantLeads(leads, now, { activeLeadIds });
  const proposals = reactivationProposals(published, normalizarLeads(dormant, vocabularioZonas(all)));
  // Always said: the E6 gate reads this line.
  log(`reactivation: ${proposals.length} dormant lead(s) fit published stock`);
  if (!proposals.length) return `${dormant.length} dormant, none fit ${published.length} published`;

  const onDuty = await onDutyName(pb, log, 'reactivation');
  // Event first, notify last: a retry duplicates a harmless row, not a message.
  await event('reactivation.proposed', {
    leads: proposals.length,
    properties: new Set(proposals.map((p) => p.property.id)).size,
    with_consent: proposals.filter((p) => p.lead.consentimiento).length,
  });
  await notify(textReactivation(proposals, onDuty, now));
  return `${proposals.length} of ${dormant.length} dormant proposed`;
}
