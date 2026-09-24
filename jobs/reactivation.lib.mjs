// reactivation.lib.mjs — pure rules of the Monday reactivation proposal
// (jobs/reactivation.mjs). No I/O; unit-tested in reactivation.lib.test.mjs.
//
// A PROPOSAL only: the job tells the team which dormant leads fit the stock
// that is published today, so an agent can call them. Nothing is sent to a
// lead — decision 3 of the estate build-out: no message to real leads before
// CU-15 has run and the owner said yes.
//
// The fit is the matcher's (lib.mjs candidatos: zone required; budget and
// rooms reorder), scored against the dormant leads only.
import { MAX_LINES, PIE_CRM, candidatos, esFecha, escapeHtml, firstName, fitTelegram, haceCuanto, recorta, relojLead } from './lib.mjs';
import { safeName } from './pb-helpers.lib.mjs';

const MS_DAY = 86_400_000;

// Business rules (product decisions — change them here, in a PR).
export const DORMANT_DAYS = 30; // no contact for longer than this
export const ACTIVE_STAGES = ['oferta', 'reservado', 'vendido']; // a deal in progress, or done, is not dormant

/** A lead that once consented and then withdrew it. */
export const consentRevoked = (lead) => !lead.consentimiento && Boolean(lead.consentimiento_en);

/**
 * Dormant leads, longest silence first: not in ACTIVE_STAGES, silent for more
 * than DORMANT_DAYS (an unknown date counts as dormant — the most abandoned
 * case), and not revoked. A lead that never consented stays in (a phone call
 * needs no marketing consent); the message marks it.
 * `activeLeadIds`: leads with ANY actividades row (inbound included) in the
 * last DORMANT_DAYS — they are not dormant, whatever ultimo_contacto says
 * (it is not stamped on an inbound message).
 */
export function dormantLeads(leads, now, { activeLeadIds = new Set() } = {}) {
  const since = (l) => {
    const d = relojLead(l);
    return esFecha(d) ? d.getTime() : -Infinity;
  };
  return leads
    .filter((l) => !ACTIVE_STAGES.includes(l.etapa))
    .filter((l) => !consentRevoked(l))
    .filter((l) => !activeLeadIds.has(l.id))
    .filter((l) => now - since(l) > DORMANT_DAYS * MS_DAY)
    .sort((a, b) => since(a) - since(b));
}

/**
 * One proposal per dormant lead that fits at least one published property:
 * [{ lead, property, score, motivos, fits }], `property` the best-scoring one
 * (the first published on a tie), `fits` how many published properties fit.
 * Best score first; on a tie the input order (longest silence) holds.
 */
export function reactivationProposals(published, dormantNorm) {
  const byLead = new Map();
  const order = [];
  for (const p of published) {
    for (const c of candidatos(p, dormantNorm)) {
      const cur = byLead.get(c.lead.id);
      if (!cur) {
        byLead.set(c.lead.id, { lead: c.lead, property: p, score: c.score, motivos: c.motivos, fits: 1 });
        order.push(c.lead.id);
      } else {
        cur.fits += 1;
        if (c.score > cur.score) Object.assign(cur, { property: p, score: c.score, motivos: c.motivos });
      }
    }
  }
  const rank = new Map(dormantNorm.map(({ lead }, i) => [lead.id, i]));
  return order.map((id) => byLead.get(id))
    .sort((a, b) => b.score - a.score || rank.get(a.lead.id) - rank.get(b.lead.id));
}

/** The Monday message (HTML), or null when no dormant lead fits. */
export function textReactivation(proposals, onDuty, now) {
  if (!proposals.length) return null;
  const lines = proposals.slice(0, MAX_LINES).map(({ lead, property, motivos, fits }) => {
    const nombre = recorta(firstName(safeName(lead.nombre)) || 'lead sin nombre');
    const titulo = recorta(property.titulo || 'propiedad sin título');
    const more = fits > 1 ? ` (+${fits - 1})` : '';
    const asignado = safeName(lead.expand?.asignado?.name);
    const agente = asignado ? recorta(asignado) : onDuty ? `${recorta(onDuty)} (guardia)` : 'sin asignar';
    const consent = lead.consentimiento ? '✅ consentimiento' : '🚫 sin consentimiento';
    return `• <b>${nombre}</b> · ${titulo}${more} · ${motivos.map(escapeHtml).join(', ')} · ${agente} · último contacto ${haceCuanto(relojLead(lead), now)} · ${consent}`;
  });
  if (proposals.length > MAX_LINES) lines.push(`… y ${proposals.length - MAX_LINES} más`);
  const n = proposals.length;
  return fitTelegram([
    `💤 <b>Reactivación</b> — ${n} ${n === 1 ? 'lead dormido encaja' : 'leads dormidos encajan'} con el stock publicado:`,
    '',
    ...lines,
    '',
    'Propuesta para llamar: no se ha enviado nada a los leads.',
    PIE_CRM,
  ].join('\n'));
}
