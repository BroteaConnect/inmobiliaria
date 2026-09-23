// reactivation.mjs — Mondays 10:00 Madrid: which dormant leads (no contact
// for 30+ days, no deal in progress, consent not revoked) fit the stock that
// is published today. A PROPOSAL to the team on Telegram, nothing more.
//
// Safety: this job never sends anything to a lead, never calls the chassis
// and never writes to PocketBase (decision 3: no message to real leads before
// CU-15 has run and the owner said yes). It never emits reactivation.sent.
// I/O only; every rule lives in reactivation.lib.mjs and lib.mjs.
import { normalizarLeads, vocabularioZonas } from './lib.mjs';
import { dormantLeads, reactivationProposals, textReactivation } from './reactivation.lib.mjs';
import { onDutyName } from './pb-helpers.lib.mjs';

export const when = { daily: '10:00', dow: [1] };

export async function run({ pb, notify, event, log, now }) {
  if (!pb) throw new Error('reactivation: this project has no PocketBase client');
  // Every property builds the zone vocabulary; only the published ones are offered.
  const [all, leads] = await Promise.all([
    pb.collection('propiedades').getFullList(),
    pb.collection('leads').getFullList({ expand: 'propiedad,asignado' }),
  ]);
  const published = all.filter((p) => p.estado === 'publicada');
  const dormant = dormantLeads(leads, now);
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
