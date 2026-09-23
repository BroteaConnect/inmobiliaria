// matcher.mjs — 09:30 Madrid: for every published property, which open leads
// fit it (town required; budget and rooms reorder). Every property gets its
// count in the log; only a property touched in the last 24 h with at least one
// candidate sends a shortlist to Telegram, naming the agent who should call
// (the lead's `asignado`, else the on-duty agent from settings
// `agentes.guardia`). All the rules — text normalisation, what counts as a
// town, an amount, a room count, the weights — live in lib.mjs with tests.
//
// The WhatsApp half ("¿te encaja? sí" → propiedad.encaja on the lead) is out
// of scope until E5 ships its outbound template: a business-initiated message
// needs a Twilio Content template or the lead's own 24-hour window.
import { candidatos, esReciente, normalizarLeads, textoShortlist, vocabularioMunicipios } from './lib.mjs';

export const when = { daily: '09:30' };

const SHORTLIST_IDS = 10; // lead ids kept in the event payload
const VENTANA_HORAS = 24; // a property "just published/updated" gets a shortlist

// Who is on duty: settings row `agentes.guardia` = { v: 1, text: <users id> }.
// Anything missing or broken degrades to null (the line then says
// "sin asignar"), never to a failed morning.
async function nombreDeGuardia(pb, log) {
  try {
    const rows = await pb.collection('settings').getFullList({ filter: 'key = "agentes.guardia"' });
    const id = rows[0]?.value?.text;
    if (!id) return null;
    const user = await pb.collection('users').getOne(id);
    return user?.name || null;
  } catch (e) {
    log(`matcher: on-duty agent unavailable: ${e?.message ?? e}`);
    return null;
  }
}

export async function run({ pb, notify, event, log, now }) {
  // Every property builds the town vocabulary; only the published ones are scored.
  const todas = await pb.collection('propiedades').getFullList({ sort: '-updated' });
  const municipios = vocabularioMunicipios(todas);
  const publicadas = todas.filter((p) => p.estado === 'publicada');
  const leads = await pb.collection('leads').getFullList({
    filter: 'etapa != "vendido"',
    expand: 'propiedad,asignado',
  });
  const guardia = await nombreDeGuardia(pb, log);
  const leadsNorm = normalizarLeads(leads, municipios);
  log(`matcher: ${publicadas.length} published of ${todas.length} properties, ${leads.length} open lead(s), ${municipios.length} town(s), on-duty agent ${guardia ? 'resolved' : 'unknown'}`);

  let notified = 0;
  for (const p of publicadas) {
    // One bad row must not take the other properties down with it.
    try {
      const cands = candidatos(p, leadsNorm);
      // Always said, for every published property: the E4 gate reads this line.
      log(`matcher: ${cands.length} candidate(s) for ${p.id}`);
      if (!cands.length || !esReciente(p.updated, now, VENTANA_HORAS)) continue;
      // Event first, notify last: a retry duplicates a harmless row, not a blast.
      await event('matcher.shortlist', {
        propiedad_id: p.id,
        candidates: cands.length,
        lead_ids: cands.slice(0, SHORTLIST_IDS).map((c) => c.lead.id),
      });
      await notify(textoShortlist(p, cands, guardia, now));
      notified++;
    } catch (e) {
      log(`matcher: property ${p.id} skipped: ${e?.message ?? e}`);
    }
  }
  return `${publicadas.length} properties scored, ${notified} shortlist(s)`;
}
