// lib.mjs — pure selection/formatting logic for the scheduled jobs.
// No I/O, no PocketBase imports: everything here is unit-tested with
// `node --test jobs/`. The Telegram strings are Spanish (the team reads
// Spanish); everything else is English.
//
// Timezone rule: the "day" is always the Europe/Madrid local day, computed
// with Intl.DateTimeFormat — never by adding fixed offsets (DST would
// silently shift it twice a year).

const MS_HOUR = 3_600_000;
const MS_DAY = 24 * MS_HOUR;

// Business rules (product decisions — change them here, in a PR).
export const STALE_HOURS = 48; // a lead is unattended after this silence
export const ALERT_DAYS = 5; // ⚠️ escalation after this many days waiting
export const MAX_LINES = 10; // agenda cap; the rest becomes "… y N más"
export const MAX_NOMBRE = 80; // nombre comes from a public form — an unbounded
// name could push the message past Telegram's 4096-char limit and kill the job
// Same exclusions as the CRM's desatendido() (inmobiliaria-crm api.ts):
// 'nutriendo' is deliberately parked, 'vendido' needs no chasing.
export const ETAPAS_EXCLUIDAS = ['nutriendo', 'vendido'];
// The CSV importer stamps this origen (inmobiliaria-crm Importar.tsx:129).
// A 216-row import is not 216 new leads: the digest must not claim it was.
export const ORIGEN_IMPORTADO = 'histórico';

// PocketBase serializes dates as "YYYY-MM-DD HH:MM:SS.sssZ" (space, not T).
export const parseFecha = (s) => (s instanceof Date ? s : new Date(String(s).replace(' ', 'T')));

// Records written BEFORE the autodate fields were declared in pb/schema.json
// keep created/updated = "" forever (autodate only stamps on write). Real data
// has them — 4 leads, 2 actividades, 14 propiedades on 2026-07-30 — so every
// date here must survive being unparseable instead of throwing.
export const esFecha = (d) => d instanceof Date && Number.isFinite(d.getTime());

// The staleness clock: a brand-new lead nobody ever touched has no
// ultimo_contacto at all — falling back to created is what makes it appear.
// May be an Invalid Date when the record predates the autodate fields.
export const relojLead = (lead) => parseFecha(lead.ultimo_contacto || lead.created);

// A lead with no usable timestamp is the *most* abandoned case, not one to
// skip: sorting it as infinitely old puts it at the top of the agenda.
const esperaDesde = (lead) => {
  const d = relojLead(lead);
  return esFecha(d) ? d.getTime() : -Infinity;
};

// YYYY-MM-DD of the Europe/Madrid local day, or null when the date is unusable.
const madridDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
});
export const diaMadrid = (date) => {
  const d = parseFecha(date);
  return esFecha(d) ? madridDay.format(d) : null;
};

const madridHeader = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long',
});

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The one call to action every digest ends with (agenda and shortlist alike).
export const PIE_CRM = 'Abre el CRM y dales salida: https://crm-inmobiliaria.brotea.dev';

// "hace 3 días" / "hace 1 día" / "hace 5 horas" / "hace menos de una hora"
export function haceCuanto(date, now) {
  const d = parseFecha(date);
  if (!esFecha(d)) return 'sin fecha registrada';
  const ms = now - d;
  const days = Math.floor(ms / MS_DAY);
  if (days >= 1) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  const hours = Math.floor(ms / MS_HOUR);
  if (hours >= 1) return `hace ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  return 'hace menos de una hora';
}

// Leads with no contact for > STALE_HOURS, excluding parked/won stages,
// sorted oldest-wait-first (the most abandoned lead leads the list).
export function desatendidos(leads, now) {
  return leads
    .filter((l) => !ETAPAS_EXCLUIDAS.includes(l.etapa))
    // esperaDesde() is -Infinity for a lead with no usable date, so it passes
    // the threshold instead of silently vanishing on a NaN comparison.
    .filter((l) => now - esperaDesde(l) > STALE_HOURS * MS_HOUR)
    .sort((a, b) => esperaDesde(a) - esperaDesde(b));
}

// The 09:00 agenda message (HTML). Returns null when there is nothing to
// say — silence is a feature.
export function textoAgenda(stale, now) {
  if (!stale.length) return null;
  const lines = stale.slice(0, MAX_LINES).map((l) => {
    const since = relojLead(l);
    // unknown wait = worst case, so it gets the warning too
    const warn = !esFecha(since) || now - since > ALERT_DAYS * MS_DAY ? '⚠️ ' : '';
    const nombre = escapeHtml(String(l.nombre).slice(0, MAX_NOMBRE));
    return `• ${warn}<b>${nombre}</b> — ${escapeHtml(l.etapa || 'sin etapa')} · ${haceCuanto(since, now)}`;
  });
  if (stale.length > MAX_LINES) lines.push(`… y ${stale.length - MAX_LINES} más`);
  const n = stale.length;
  return [
    `📋 <b>Agenda</b> — ${n} ${n === 1 ? 'lead lleva' : 'leads llevan'} más de ${STALE_HOURS} h sin contacto:`,
    '',
    ...lines,
    '',
    PIE_CRM,
  ].join('\n');
}

// Visits scheduled for the Madrid-local day of `now` — a 23:30Z visit on the
// 29th is a 01:30 visit on the 30th in Madrid, and diaMadrid() is what decides
// that, never a fixed offset. Cancelled visits are not visits; a visit with an
// unusable `cuando` is on no day at all. Earliest first: the agent reads it
// top to bottom before leaving the office.
export function visitasDeHoy(visitas, now) {
  const hoy = diaMadrid(now);
  return visitas
    .filter((v) => v.resultado !== 'cancelada')
    .filter((v) => diaMadrid(v.cuando) === hoy)
    .sort((a, b) => parseFecha(a.cuando) - parseFecha(b.cuando));
}

const madridHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export const horaMadrid = (date) => {
  const d = parseFecha(date);
  return esFecha(d) ? madridHour.format(d) : '--:--';
};

// The visits section of the 09:00 agenda (HTML): one line per visit,
// `HH:MM · <b>lead</b> · property · agent`, read from the expanded relations
// (`expand=lead,propiedad,agente`). A relation that did not expand — a lead
// deleted since, a visit saved without a property — degrades to a Spanish
// placeholder, never to "undefined". Every name is cut to MAX_NOMBRE before
// escaping: propiedades.titulo has no max, and ten long titles would push the
// digest past Telegram's 4096 chars after the event row is already written.
// Returns null when there are no visits.
const recorta = (s) => escapeHtml(String(s).slice(0, MAX_NOMBRE));
export function textoVisitas(visitas, now) {
  if (!visitas.length) return null;
  const lines = visitas.slice(0, MAX_LINES).map((v) => {
    const lead = recorta(v.expand?.lead?.nombre || 'lead sin nombre');
    const propiedad = recorta(v.expand?.propiedad?.titulo || 'sin propiedad');
    const agente = recorta(v.expand?.agente?.name || 'sin agente');
    return `• ${horaMadrid(v.cuando)} · <b>${lead}</b> · ${propiedad} · ${agente}`;
  });
  if (visitas.length > MAX_LINES) lines.push(`… y ${visitas.length - MAX_LINES} más`);
  const n = visitas.length;
  return [
    `🗓 <b>Visitas de hoy</b> — ${madridHeader.format(now)} · ${n} ${n === 1 ? 'visita' : 'visitas'}:`,
    '',
    ...lines,
  ].join('\n');
}

// Counts for the Madrid-local day of `now`.
// - nuevos: leads created today
// - contactos: outbound actividades by channel (notes are not contacts)
// - entrantes: inbound actividades (any channel)
// - emailsEntregados: email actividades whose estado_envio reached delivery
//   (entregado/abierto/click — the webhook never degrades a state)
// - publicadas: propiedades in estado "publicada" last touched today (best
//   available proxy: there is no state-change log)
export function resumenDelDia({ leads = [], actividades = [], propiedades = [] }, now) {
  const hoy = diaMadrid(now);
  // diaMadrid() is null for records with an empty autodate: "unknown" is not
  // "today", and it must never crash the whole digest.
  const deHoy = (r) => diaMadrid(r.created) === hoy;

  const leadsHoy = leads.filter(deHoy);
  const nuevos = leadsHoy.filter((l) => l.origen !== ORIGEN_IMPORTADO).length;
  const importados = leadsHoy.length - nuevos;

  const actsHoy = actividades.filter(deHoy);
  const contactos = Object.create(null); // a.tipo as key — keep __proto__ inert
  for (const a of actsHoy) {
    if (a.direccion !== 'saliente' || a.tipo === 'nota') continue;
    contactos[a.tipo] = (contactos[a.tipo] || 0) + 1;
  }
  const entrantes = actsHoy.filter((a) => a.direccion === 'entrante').length;
  const emailsEntregados = actsHoy.filter(
    (a) => a.tipo === 'email' && ['entregado', 'abierto', 'click'].includes(a.estado_envio),
  ).length;

  const publicadas = propiedades.filter(
    (p) => p.estado === 'publicada' && diaMadrid(p.updated || p.created) === hoy,
  ).length;

  const totalContactos = Object.values(contactos).reduce((s, n) => s + n, 0);
  const vacio = nuevos + importados + totalContactos + entrantes + emailsEntregados + publicadas === 0;
  return { dia: hoy, nuevos, importados, contactos, entrantes, emailsEntregados, publicadas, vacio };
}

// The 20:00 digest (HTML). Returns null when the day was empty.
export function textoResumen(resumen, now) {
  if (!resumen || resumen.vacio) return null;
  const lines = [];
  if (resumen.nuevos) lines.push(`• Leads nuevos: <b>${resumen.nuevos}</b>`);
  if (resumen.importados) lines.push(`• Importados a la cartera: ${resumen.importados}`);
  const canales = Object.entries(resumen.contactos)
    .map(([tipo, n]) => `${n} ${escapeHtml(tipo)}`)
    .join(', ');
  if (canales) lines.push(`• Contactos salientes: ${canales}`);
  if (resumen.entrantes) lines.push(`• Mensajes entrantes: ${resumen.entrantes}`);
  if (resumen.emailsEntregados) lines.push(`• Emails entregados: ${resumen.emailsEntregados}`);
  if (resumen.publicadas) lines.push(`• Propiedades publicadas: ${resumen.publicadas}`);
  return [`🌙 <b>Resumen del día</b> — ${madridHeader.format(now)}:`, '', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Matcher (09:30): which leads fit a published property.
//
// The CRM has no structured "what the lead wants" — `criterios` is free text
// (the CSV importer writes "Compró en <master project> · <edificio> · unidad N
// · ~<precio> · …", the web form writes whatever the visitor typed) and the
// `mensaje` is prose. So the wish is DERIVED here, per lead, and never stored:
//   zona          the towns named in the text — matched against the vocabulary
//                 of real `municipio` values (every property, published or
//                 not), plus the town of the property the lead asked about
//   precio_max    the first amount in the text (~1200000, 550k, 1.2m,
//                 1,200,000, "hasta 300.000") — null when none
//   habitaciones  "4 habitaciones" / "3 hab" / "2 bedrooms" — null when none
// The town is the only hard rule: a lead who never named the town, nor asked
// about a property there, is not a candidate no matter the price. Price and
// rooms only reorder (and an unknown is not a mismatch).

// Lowercase, accents stripped (NFD, then the combining marks), spaces collapsed:
// "Chamberí" and "  CHAMBERI " are the same town.
export const normalizarTexto = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Distinct normalised `municipio` values of a set of properties — the town
// vocabulary. Built from ALL properties: an unpublished listing still tells us
// that "las rozas" is a town this agency works.
export const vocabularioMunicipios = (propiedades) =>
  [...new Set(propiedades.map((p) => normalizarTexto(p.municipio)).filter(Boolean))];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A town counts only as a whole token: "madrid" is not in "madridejos", and
// "lakes towers" is not "jumeirah lakes towers".
const contieneEntero = (texto, termino) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(termino)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(texto);

// An amount is a number with a money marker: a prefix (~ € $ or a budget
// word), a suffix (k, m, mil, millones, €), or thousands separators. A bare
// number is NOT an amount — "unidad 1413" is a flat, "29/12/2022" a date,
// "120 m2" a surface (the m may not be followed by a digit or ²) — and a
// budget word before a small bare number ("hasta 4 habitaciones") is not one
// either: without suffix or separators the number needs 4+ digits.
const RE_IMPORTE = /(?:(hasta|presupuesto|max|maximo|budget|precio|tope|~|€|\$)\s*(?:de\s+|of\s+)?:?\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|m|mil|millones|millon|€|eur|euros)?(?![\p{L}\p{N}²])/gu;
const FACTOR = { k: 1e3, mil: 1e3, m: 1e6, millon: 1e6, millones: 1e6 };
export function extraerPrecioMax(texto) {
  for (const m of texto.matchAll(RE_IMPORTE)) {
    const [, prefijo, numero, sufijo] = m;
    const separado = /^\d{1,3}(?:[.,]\d{3})+$/.test(numero);
    const soloDigitos = numero.replace(/\D/g, '');
    if (!prefijo && !sufijo && !separado) continue;
    if (prefijo && !sufijo && !separado && soloDigitos.length < 4) continue;
    const base = separado ? Number(soloDigitos) : Number(numero.replace(',', '.'));
    const valor = Math.round(base * (FACTOR[sufijo] || 1));
    if (Number.isFinite(valor) && valor > 0) return valor;
  }
  return null;
}

const RE_HABITACIONES = /(\d+)\s*(hab|habitaci|dormitor|bed|br\b)/;
export function extraerHabitaciones(texto) {
  const m = RE_HABITACIONES.exec(texto);
  return m ? Number(m[1]) : null;
}

// The derived wish of one lead. `zona` is every vocabulary town found in the
// text plus the town of the linked property (`expand.propiedad`); `zona_texto`
// is the subset that came from the text — the scorer pays a town the lead
// wrote more than a town we only infer from the listing they clicked.
export function normalizarCriterios(lead, municipios) {
  const texto = normalizarTexto(`${lead.criterios ?? ''} ${lead.mensaje ?? ''}`);
  const zona_texto = municipios.filter((m) => m && contieneEntero(texto, m));
  const pista = normalizarTexto(lead.expand?.propiedad?.municipio);
  const zona = pista && !zona_texto.includes(pista) ? [...zona_texto, pista] : [...zona_texto];
  return { zona, zona_texto, precio_max: extraerPrecioMax(texto), habitaciones: extraerHabitaciones(texto) };
}

export const normalizarLeads = (leads, municipios) =>
  leads.map((lead) => ({ lead, norm: normalizarCriterios(lead, municipios) }));

// Business rule: how much each signal weighs.
export const PESO_ZONA_TEXTO = 3; // the lead named the town
export const PESO_ZONA_PISTA = 2; // we only know the town from the listing they asked about
export const PESO_PRECIO = 1; // unknown budget, or the price within 15 % of it
export const PESO_HABITACIONES = 1; // unknown, or the property has at least that many
export const MARGEN_PRECIO = 1.15;

// Candidates for one property, best first: [{ lead, score, motivos }].
// The town match is required; `vendido` leads are out (a buyer who already
// bought is not shopping) — every other stage, `nutriendo` included, stays:
// a parked lead is exactly who a new listing might wake up.
export function candidatos(propiedad, leadsNorm) {
  const municipio = normalizarTexto(propiedad.municipio);
  if (!municipio) return [];
  const out = [];
  for (const { lead, norm } of leadsNorm) {
    if (lead.etapa === 'vendido') continue;
    if (!norm.zona.includes(municipio)) continue;
    const motivos = [];
    let score = 0;
    if (norm.zona_texto.includes(municipio)) {
      score += PESO_ZONA_TEXTO;
      motivos.push(`zona ${municipio}`);
    } else {
      score += PESO_ZONA_PISTA;
      motivos.push(`zona ${municipio} (por la propiedad que consultó)`);
    }
    if (norm.precio_max == null) {
      score += PESO_PRECIO;
      motivos.push('presupuesto sin indicar');
    } else if (Number(propiedad.precio) <= norm.precio_max * MARGEN_PRECIO) {
      score += PESO_PRECIO;
      motivos.push('encaja en presupuesto');
    }
    if (norm.habitaciones == null) {
      score += PESO_HABITACIONES;
      motivos.push('habitaciones sin indicar');
    } else if (Number(propiedad.habitaciones) >= norm.habitaciones) {
      score += PESO_HABITACIONES;
      motivos.push(`≥ ${norm.habitaciones} hab`);
    }
    out.push({ lead, score, motivos });
  }
  // Array.prototype.sort is stable: equal scores keep the input order.
  return out.sort((a, b) => b.score - a.score);
}

// True when `date` is within the last `horas` hours of `now`. An unparseable
// date is not recent (the pre-autodate rows have updated = "").
export function esReciente(date, now, horas = 24) {
  const d = parseFecha(date);
  return esFecha(d) && now - d >= 0 && now - d <= horas * MS_HOUR;
}

// The shortlist message for one property (HTML). One line per candidate:
// `• <b>lead</b> · agent · reasons`, the agent being the lead's `asignado`,
// else the on-duty agent (`agentes.guardia`), else "sin asignar". Capped at
// MAX_LINES; every name cut to MAX_NOMBRE and escaped. Null without candidates.
export function textoShortlist(propiedad, cands, guardiaNombre, now) {
  if (!cands.length) return null;
  const lines = cands.slice(0, MAX_LINES).map(({ lead, motivos }) => {
    const nombre = recorta(lead.nombre || 'lead sin nombre');
    const asignado = lead.expand?.asignado?.name;
    const agente = asignado ? recorta(asignado) : guardiaNombre ? `${recorta(guardiaNombre)} (guardia)` : 'sin asignar';
    return `• <b>${nombre}</b> · ${agente} · ${motivos.map(escapeHtml).join(', ')}`;
  });
  if (cands.length > MAX_LINES) lines.push(`… y ${cands.length - MAX_LINES} más`);
  const n = cands.length;
  const titulo = recorta(propiedad.titulo || 'propiedad sin título');
  const municipio = propiedad.municipio ? ` (${recorta(propiedad.municipio)})` : '';
  return [
    `🎯 <b>Encaje</b> — ${madridHeader.format(now)} · ${titulo}${municipio} · ${n} ${n === 1 ? 'candidato' : 'candidatos'}:`,
    '',
    ...lines,
    '',
    PIE_CRM,
  ].join('\n');
}
