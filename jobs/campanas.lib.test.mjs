// campanas.lib.test.mjs — unit tests for the campaign rules. Run: node --test jobs/
// Everything here is pure: a fixed NOW, PocketBase-shaped rows, no I/O.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ENLACES_FALLIDOS, MAX_ENVIOS_POR_RUN, MAX_REINTENTOS_LEAD, SEGMENTO_VERSION, SegmentoInvalido, VARIABLES_DEL_CHASIS,
  aplicarEnvio, aplicarRechazo, cerrarInforme, cuotaDelRun, dentroDeHorario, enviadosHoy, esRechazoAmbiguo, esRechazoTerminal,
  evaluarSegmento, hhmmAMinutos, informeInicial, minutosMadrid, payloadCompletada, pendientes, plantillaLista,
  problemasSegmento, textoCampanaArmada, textoCampanaBloqueada, textoCampanaCompletada, textoCampanaPausada,
  variablesPara,
} from './campanas.lib.mjs';

// Fixed "now": 2026-09-23 12:00 Europe/Madrid (CEST, UTC+2) = 10:00Z.
const NOW = new Date('2026-09-23T10:00:00.000Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
// PocketBase serializes dates with a space instead of the T.
const pbDate = (iso) => iso.replace('T', ' ');

let seq = 0;
const lead = (over = {}) => ({
  id: `lead${String(++seq).padStart(3, '0')}`,
  nombre: `Lead ${seq}`,
  email: `lead${seq}@example.com`,
  telefono: '+34600000000',
  etapa: 'nuevo',
  origen: 'web',
  consentimiento: true,
  canal_preferido: 'email',
  idioma: 'es',
  ultimo_contacto: '',
  created: daysAgo(30),
  ...over,
});

const campana = (over = {}) => ({
  id: 'camp0000000000',
  nombre: 'Campaña de prueba',
  plantilla: 'plant000000000',
  segmento: { v: 1 },
  lote_diario: 30,
  intervalo_min: 10,
  hora_desde: '10:00',
  hora_hasta: '18:00',
  inicio: '',
  estado: 'programada',
  ultimo_envio_en: '',
  informe: null,
  ...over,
});

const envio = (over = {}) => ({ id: `env${++seq}`, lead: 'lead001', estado: 'enviado', enviado_en: minutesAgo(30), created: minutesAgo(30), ...over });

// -- the segment contract -----------------------------------------------------
describe('problemasSegmento', () => {
  it('accepts a minimal valid segment', () => {
    assert.deepEqual(problemasSegmento({ v: SEGMENTO_VERSION }), []);
  });

  it('refuses a missing or wrong version', () => {
    assert.ok(problemasSegmento({}).some((p) => p.startsWith('v must be')));
    assert.ok(problemasSegmento({ v: 2 }).some((p) => p.startsWith('v must be')));
  });

  it('refuses an unknown key instead of ignoring it', () => {
    const out = problemasSegmento({ v: 1, consentimento: false });
    assert.deepEqual(out, ['unknown key consentimento']);
  });

  it('refuses unknown enum values and wrong types', () => {
    assert.ok(problemasSegmento({ v: 1, etapa: ['comprado'] }).some((p) => p.includes('unknown value comprado')));
    assert.ok(problemasSegmento({ v: 1, idioma: 'es' }).some((p) => p.includes('idioma must be')));
    assert.ok(problemasSegmento({ v: 1, consentimiento: 'no' }).some((p) => p.includes('consentimiento must be')));
    assert.ok(problemasSegmento({ v: 1, max: 0 }).some((p) => p.includes('max must be')));
    assert.ok(problemasSegmento({ v: 1, sin_contacto_dias: -1 }).some((p) => p.includes('sin_contacto_dias must be')));
  });

  it('refuses an empty list, which would match nobody silently', () => {
    assert.ok(problemasSegmento({ v: 1, etapa: [] }).some((p) => p.includes('matches nobody')));
  });

  it('validates variables as literal strings, and refuses chassis-minted ones', () => {
    assert.deepEqual(problemasSegmento({ v: 1, variables: { url: 'https://x.dev' } }), []);
    assert.ok(problemasSegmento({ v: 1, variables: { n: 5 } }).some((p) => p.includes('variables.n must be')));
    assert.ok(problemasSegmento({ v: 1, variables: [] }).some((p) => p.includes('not a filter')));
    for (const v of VARIABLES_DEL_CHASIS) {
      assert.ok(problemasSegmento({ v: 1, variables: { [v]: 'x' } }).some((p) => p.includes('minted by the chassis')));
    }
  });
});

describe('evaluarSegmento', () => {
  it('throws SegmentoInvalido rather than treating a broken segment as everybody', () => {
    const leads = [lead(), lead()];
    assert.throws(() => evaluarSegmento({ segmento: { v: 1, ojo: 1 }, leads }), SegmentoInvalido);
    assert.throws(() => evaluarSegmento({ segmento: null, leads }), SegmentoInvalido);
  });

  it('compares origen normalised, so histórico with its accent matches', () => {
    const historico = lead({ origen: 'histórico' });
    const web = lead({ origen: 'web' });
    const out = evaluarSegmento({ segmento: { v: 1, origen: ['histórico'] }, leads: [historico, web], now: NOW });
    assert.deepEqual(out.destinatarios.map((l) => l.id), [historico.id]);
    const sinAcento = evaluarSegmento({ segmento: { v: 1, origen: ['historico'] }, leads: [historico, web], now: NOW });
    assert.deepEqual(sinAcento.destinatarios.map((l) => l.id), [historico.id]);
  });

  it('consentimiento:false matches a lead whose field was never written', () => {
    const nunca = lead({ consentimiento: undefined });
    const falso = lead({ consentimiento: false });
    const si = lead({ consentimiento: true });
    const out = evaluarSegmento({ segmento: { v: 1, consentimiento: false }, leads: [nunca, falso, si], now: NOW });
    assert.deepEqual(out.destinatarios.map((l) => l.id), [nunca.id, falso.id]);
  });

  it('incluye_ids restricts the candidates but never bypasses consentimiento', () => {
    const elegido = lead({ consentimiento: false });
    const otro = lead({ consentimiento: true });
    const out = evaluarSegmento({
      segmento: { v: 1, incluye_ids: [elegido.id, otro.id], consentimiento: true }, leads: [elegido, otro], now: NOW,
    });
    assert.deepEqual(out.destinatarios.map((l) => l.id), [otro.id]);
  });

  it('excluye_ids wins over incluye_ids', () => {
    const a = lead();
    const out = evaluarSegmento({ segmento: { v: 1, incluye_ids: [a.id], excluye_ids: [a.id] }, leads: [a], now: NOW });
    assert.equal(out.destinatarios.length, 0);
  });

  it('sin_contacto_dias treats an empty ultimo_contacto as never contacted, so eligible', () => {
    const nunca = lead({ ultimo_contacto: '' });
    const antiguo = lead({ ultimo_contacto: daysAgo(40) });
    const reciente = lead({ ultimo_contacto: pbDate(daysAgo(3)) });
    const out = evaluarSegmento({ segmento: { v: 1, sin_contacto_dias: 30 }, leads: [nunca, antiguo, reciente], now: NOW });
    assert.deepEqual(out.destinatarios.map((l) => l.id), [nunca.id, antiguo.id]);
  });

  it('max cuts deterministically: created ascending, then id', () => {
    const viejo = lead({ created: daysAgo(90) });
    const medio = lead({ created: daysAgo(60) });
    const nuevo = lead({ created: daysAgo(1) });
    const orden = (leads) => evaluarSegmento({ segmento: { v: 1, max: 2 }, leads, now: NOW }).destinatarios.map((l) => l.id);
    assert.deepEqual(orden([nuevo, medio, viejo]), [viejo.id, medio.id]);
    assert.deepEqual(orden([medio, viejo, nuevo]), [viejo.id, medio.id]);
  });

  it('excludes the unreachable by channel, counts them, and never sends to them', () => {
    const conEmail = lead();
    const sinEmail = lead({ email: '' });
    const email = evaluarSegmento({ segmento: { v: 1 }, leads: [conEmail, sinEmail], canal: 'email', now: NOW });
    assert.deepEqual(email.destinatarios.map((l) => l.id), [conEmail.id]);
    assert.deepEqual(email.excluidos, [{ lead: sinEmail.id, code: 'sin_email' }]);

    const sinTelefono = lead({ telefono: '' });
    const wa = evaluarSegmento({ segmento: { v: 1 }, leads: [conEmail, sinTelefono], canal: 'whatsapp', now: NOW });
    assert.deepEqual(wa.destinatarios.map((l) => l.id), [conEmail.id]);
    assert.deepEqual(wa.excluidos, [{ lead: sinTelefono.id, code: 'sin_telefono' }]);
  });

  it('reports reach: matched, reachable and unreachable, not one headline count', () => {
    const leads = [lead(), lead({ telefono: '' }), lead({ telefono: '' })];
    const out = evaluarSegmento({ segmento: { v: 1, max: 1 }, leads, canal: 'whatsapp', now: NOW });
    assert.equal(out.coincidentes, 3);
    assert.equal(out.alcanzables, 1);
    assert.equal(out.destinatarios.length, 1);
    assert.equal(out.excluidos.length, 2);
  });

  it('an empty segment list matches nobody — it is refused before it can', () => {
    assert.throws(() => evaluarSegmento({ segmento: { v: 1, canal_preferido: [] }, leads: [lead()] }), SegmentoInvalido);
  });
});

// -- the clock ----------------------------------------------------------------
describe('the Madrid clock', () => {
  it('hhmmAMinutos parses HH:MM and refuses anything else', () => {
    assert.equal(hhmmAMinutos('10:00'), 600);
    assert.equal(hhmmAMinutos('8:05'), 485);
    assert.equal(hhmmAMinutos('24:00'), null);
    assert.equal(hhmmAMinutos('10:60'), null);
    assert.equal(hhmmAMinutos(''), null);
    assert.equal(hhmmAMinutos('mañana'), null);
  });

  it('minutosMadrid follows the DST change instead of a fixed offset', () => {
    // Summer time (CEST, UTC+2): 08:00Z is 10:00 in Madrid.
    assert.equal(minutosMadrid(new Date('2026-10-24T08:00:00Z')), 600);
    // Winter time (CET, UTC+1), the Sunday after the change: 08:00Z is 09:00.
    assert.equal(minutosMadrid(new Date('2026-10-26T08:00:00Z')), 540);
    assert.equal(minutosMadrid('nunca'), null);
  });

  it('dentroDeHorario is null when the window is a configuration error', () => {
    assert.equal(dentroDeHorario({ hora_desde: '22:00', hora_hasta: '06:00' }, NOW), null);
    assert.equal(dentroDeHorario({ hora_desde: '10:00', hora_hasta: '10:00' }, NOW), null);
    assert.equal(dentroDeHorario({ hora_desde: '', hora_hasta: '18:00' }, NOW), null);
  });
});

describe('cuotaDelRun', () => {
  const at = (iso) => new Date(iso);

  it('opens at 10:00 and closes at 18:00 Madrid, to the minute', () => {
    const c = campana();
    const q = (iso) => cuotaDelRun({ campana: c, envios: [], now: at(iso) });
    assert.equal(q('2026-09-23T07:59:00Z').motivo, 'fuera_de_horario'); // 09:59 Madrid
    assert.equal(q('2026-09-23T08:00:00Z').motivo, 'ok');               // 10:00 Madrid
    assert.equal(q('2026-09-23T15:59:00Z').motivo, 'ok');               // 17:59 Madrid
    assert.equal(q('2026-09-23T16:00:00Z').motivo, 'fuera_de_horario'); // 18:00 Madrid
  });

  it('holds the same window across the DST change (Madrid local, not UTC)', () => {
    const c = campana();
    // 2026-10-25 is the last Sunday of October: Madrid goes back to UTC+1.
    // The SAME UTC instant falls on either side of the window depending on the
    // day, which is the whole reason the hour is computed in Madrid and never
    // by adding a fixed offset.
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: at('2026-10-24T08:30:00Z') }).motivo, 'ok'); // 10:30 CEST
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: at('2026-10-26T08:30:00Z') }).motivo, 'fuera_de_horario'); // 09:30 CET
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: at('2026-10-26T09:30:00Z') }).motivo, 'ok'); // 10:30 CET
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: at('2026-10-24T16:30:00Z') }).motivo, 'fuera_de_horario'); // 18:30 CEST
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: at('2026-10-26T16:30:00Z') }).motivo, 'ok'); // 17:30 CET
  });

  it('refuses to send before inicio', () => {
    const c = campana({ inicio: new Date(NOW.getTime() + 86_400_000).toISOString() });
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: NOW }).motivo, 'aun_no_empieza');
  });

  it('reports a broken window, batch or interval as configuration errors', () => {
    assert.equal(cuotaDelRun({ campana: campana({ hora_desde: '18:00', hora_hasta: '10:00' }), now: NOW }).motivo, 'horario_invalido');
    assert.equal(cuotaDelRun({ campana: campana({ lote_diario: 0 }), now: NOW }).motivo, 'lote_invalido');
    assert.equal(cuotaDelRun({ campana: campana({ intervalo_min: -5 }), now: NOW }).motivo, 'intervalo_invalido');
    assert.equal(cuotaDelRun({ campana: campana({ intervalo_min: 'diez' }), now: NOW }).motivo, 'intervalo_invalido');
    // An unset column still means "no pacing", which is a decision, not a typo.
    assert.equal(cuotaDelRun({ campana: campana({ intervalo_min: '' }), now: NOW }).motivo, 'ok');
  });

  it('spends the daily batch on today rows only, and errors do not spend it', () => {
    const c = campana({ lote_diario: 3, intervalo_min: 0 });
    const ayer = envio({ enviado_en: pbDate(daysAgo(1)) });
    const hoy = [envio(), envio()];
    const error = envio({ estado: 'error' });
    const out = cuotaDelRun({ campana: c, envios: [ayer, ...hoy, error], now: NOW });
    assert.equal(out.enviadosHoy, 2);
    assert.equal(out.permitidos, 1);
    const agotado = cuotaDelRun({ campana: campana({ lote_diario: 2, intervalo_min: 0 }), envios: hoy, now: NOW });
    assert.equal(agotado.motivo, 'lote_diario_agotado');
    assert.equal(agotado.permitidos, 0);
  });

  it('counts an envio with no enviado_en by its created day', () => {
    const c = campana({ lote_diario: 5, intervalo_min: 0 });
    const sinFecha = envio({ enviado_en: '', created: minutesAgo(5) });
    assert.equal(cuotaDelRun({ campana: c, envios: [sinFecha], now: NOW }).enviadosHoy, 1);
  });

  it('spends the interval as credits, because the job never sleeps', () => {
    const sinIntervalo = cuotaDelRun({ campana: campana({ intervalo_min: 0, lote_diario: 30 }), envios: [], now: NOW });
    assert.equal(sinIntervalo.permitidos, MAX_ENVIOS_POR_RUN);

    // 45 minutes since the last send, one every 10: four credits.
    const diez = cuotaDelRun({
      campana: campana({ intervalo_min: 10, ultimo_envio_en: pbDate(minutesAgo(45)) }), envios: [], now: NOW,
    });
    assert.equal(diez.permitidos, 4);

    // One every 60 minutes, 45 since the last one: nothing yet.
    const sesenta = cuotaDelRun({
      campana: campana({ intervalo_min: 60, ultimo_envio_en: pbDate(minutesAgo(45)) }), envios: [], now: NOW,
    });
    assert.equal(sesenta.permitidos, 0);
    assert.equal(sesenta.motivo, 'intervalo');

    // Never sent: the interval has nothing to measure from and holds nothing back.
    const primera = cuotaDelRun({ campana: campana({ intervalo_min: 60, ultimo_envio_en: '' }), envios: [], now: NOW });
    assert.ok(primera.permitidos > 0);
  });

  it('clamps an hourly run to MAX_ENVIOS_POR_RUN however generous the settings', () => {
    const c = campana({ lote_diario: 5000, intervalo_min: 0 });
    assert.equal(cuotaDelRun({ campana: c, envios: [], now: NOW }).permitidos, MAX_ENVIOS_POR_RUN);
  });
});

describe('enviadosHoy', () => {
  it('counts the Madrid day of the ledger rows, never a stored counter', () => {
    assert.equal(enviadosHoy([envio(), envio(), envio({ enviado_en: pbDate(daysAgo(1)) }), envio({ estado: 'error' })], NOW), 2);
  });
});

// -- refusals -----------------------------------------------------------------
describe('esRechazoTerminal', () => {
  it('is terminal for the reasons that will never change by retrying', () => {
    for (const code of ['no_email', 'no_phone', 'no_consent', 'consent_revoked', 'lead_unknown', 'template_not_approved', 'outside_window']) {
      assert.equal(esRechazoTerminal({ code, status: 422 }), true, code);
    }
  });

  it('is retryable for transport, provider and rate limits', () => {
    for (const code of ['chassis_timeout', 'chassis_unreachable', 'provider_unavailable', '63018']) {
      assert.equal(esRechazoTerminal({ code, status: 502 }), false, code);
      assert.equal(esRechazoAmbiguo({ code, status: 502 }), false, `${code} is a known "nothing left"`);
    }
    assert.equal(esRechazoTerminal({ code: 'slow_down', status: 429 }), false);
    assert.equal(esRechazoAmbiguo({ code: 'slow_down', status: 429 }), false);
  });

  it('treats an unknown 4xx as terminal — it is a refusal we caused', () => {
    assert.equal(esRechazoTerminal({ code: 'nunca_visto', status: 400 }), true);
  });
});

describe('esRechazoAmbiguo', () => {
  it('claims the answers that arrive after the message may already have left', () => {
    // /send-email answers this literal sentence — with a space, not an
    // underscore — from a catch that also covers writes made after nodemailer
    // accepted the mail.
    assert.equal(esRechazoAmbiguo({ code: 'send failed', status: 502 }), true);
    // Anything 5xx we have no name for is in the same class by default.
    assert.equal(esRechazoAmbiguo({ code: 'http_500', status: 500 }), true);
    assert.equal(esRechazoAmbiguo({ code: 'nunca_visto', status: 503 }), true);
  });

  it('never claims a refusal we understand', () => {
    for (const code of ['no_email', 'no_consent', 'template_not_approved']) {
      assert.equal(esRechazoAmbiguo({ code, status: 422 }), false, code);
    }
    assert.equal(esRechazoAmbiguo({ code: 'nunca_visto', status: 400 }), false, 'a 4xx never left');
  });
});

describe('aplicarRechazo', () => {
  it('tallies an unknown code under its own name, never as "otros"', () => {
    const out = aplicarRechazo(informeInicial(), { lead: 'l1', code: 'raro_nuevo', status: 400, now: NOW });
    assert.equal(out.rechazos.raro_nuevo, 1);
    assert.deepEqual(out.excluidos.map((e) => e.code), ['raro_nuevo']);
  });

  it('gives up on a lead after MAX_REINTENTOS_LEAD retryable failures', () => {
    let inf = informeInicial();
    for (let i = 0; i < MAX_REINTENTOS_LEAD; i++) inf = aplicarRechazo(inf, { lead: 'l1', code: 'chassis_timeout', status: 0, now: NOW });
    assert.equal(inf.reintentos.l1, MAX_REINTENTOS_LEAD);
    assert.deepEqual(inf.excluidos.map((e) => e.code), ['agotado']);
    assert.equal(inf.rechazos.chassis_timeout, MAX_REINTENTOS_LEAD);
  });

  it('takes the lead off the in-flight list', () => {
    const inf = aplicarRechazo({ ...informeInicial(), en_vuelo: [{ lead: 'l1', desde: minutesAgo(1) }] }, { lead: 'l1', code: 'no_email', status: 400, now: NOW });
    assert.deepEqual(inf.en_vuelo, []);
  });
});

describe('aplicarEnvio', () => {
  it('counts the send by Madrid day, clears the retries and the in-flight entry', () => {
    const before = { ...informeInicial(), en_vuelo: [{ lead: 'l1', desde: minutesAgo(1) }], reintentos: { l1: 2 } };
    const out = aplicarEnvio(before, { lead: 'l1', now: NOW });
    assert.equal(out.enviados, 1);
    assert.deepEqual(out.por_dia, { '2026-09-23': 1 });
    assert.deepEqual(out.en_vuelo, []);
    assert.deepEqual(out.reintentos, {});
    assert.equal(out.iniciada_en, NOW.toISOString());
  });
});

describe('who has already been written to', () => {
  it('records the lead in the informe, not only in the ledger', () => {
    const out = aplicarEnvio(informeInicial(), { lead: 'lead001', now: NOW });
    assert.deepEqual(out.enviados_ids, ['lead001']);
    // Twice is not two people.
    assert.deepEqual(aplicarEnvio(out, { lead: 'lead001', now: NOW }).enviados_ids, ['lead001']);
  });

  it('keeps a lead out of pendientes with NO envios row at all', () => {
    // This is the chassis answering ok with envio_id: null — the send left,
    // its ledger row did not. Without this the lead is written to every hour.
    const a = lead();
    const informe = aplicarEnvio(informeInicial(), { lead: a.id, now: NOW });
    assert.deepEqual(pendientes({ destinatarios: [a], envios: [], informe }), []);
  });

  it('never reports fewer sends than it knows happened', () => {
    const a = lead();
    const informe = cerrarInforme(aplicarEnvio(informeInicial(), { lead: a.id, now: NOW }), {
      destinatarios: [a], envios: [], enviadosEnRun: 1, now: NOW,
    });
    assert.equal(informe.enviados, 1);
  });

  it('caps the broken-link list: the informe is rewritten after every send', () => {
    const enlaces = Array.from({ length: MAX_ENLACES_FALLIDOS + 10 }, (_, i) => ({ envio_id: `e${i}`, lead: `l${i}`, error: 'x' }));
    const out = informeInicial({ enlaces_fallidos: enlaces });
    assert.equal(out.enlaces_fallidos.length, MAX_ENLACES_FALLIDOS);
    assert.equal(out.enlaces_fallidos.at(-1).envio_id, `e${enlaces.length - 1}`, 'the recent ones are the repairable ones');
  });
});

describe('pendientes', () => {
  it('is the ledger minus what is already resolved, in-flight or unresolved', () => {
    const a = lead(); const b = lead(); const c = lead(); const d = lead(); const e = lead();
    const inf = {
      ...informeInicial(),
      excluidos: [{ lead: c.id, code: 'no_email' }],
      en_vuelo: [{ lead: d.id, desde: minutesAgo(2) }],
      dudosos: [{ lead: e.id, desde: minutesAgo(90) }],
    };
    const out = pendientes({ destinatarios: [a, b, c, d, e], envios: [envio({ lead: b.id })], informe: inf });
    assert.deepEqual(out.map((l) => l.id), [a.id]);
  });

  it('counts a send that errored as already received: the ledger is the truth', () => {
    const a = lead();
    const out = pendientes({ destinatarios: [a], envios: [envio({ lead: a.id, estado: 'error' })], informe: informeInicial() });
    assert.deepEqual(out, []);
  });
});

describe('cerrarInforme', () => {
  it('re-reads the counters from the ledger and tracks quiet runs', () => {
    const envios = [envio({ estado: 'entregado' }), envio({ estado: 'enviado' }), envio({ estado: 'error' })];
    const inf = cerrarInforme(informeInicial(), { destinatarios: [lead(), lead()], envios, enviadosEnRun: 0, now: NOW });
    assert.equal(inf.destinatarios, 2);
    assert.equal(inf.enviados, 2);
    assert.deepEqual(inf.estados, { entregado: 1, enviado: 1, error: 1 });
    assert.equal(inf.runs, 1);
    assert.equal(inf.runs_sin_envio, 1);
    const otra = cerrarInforme(inf, { destinatarios: [], envios, enviadosEnRun: 1, now: NOW });
    assert.equal(otra.runs, 2);
    assert.equal(otra.runs_sin_envio, 0);
  });

  it('stamps completada_en once, and only when it completes', () => {
    const abierta = cerrarInforme(informeInicial(), { envios: [], now: NOW });
    assert.equal(abierta.completada_en, null);
    const cerrada = cerrarInforme(abierta, { envios: [], now: NOW, completada: true });
    assert.equal(cerrada.completada_en, NOW.toISOString());
    const otra = cerrarInforme(cerrada, { envios: [], now: new Date('2027-01-01T00:00:00Z'), completada: true });
    assert.equal(otra.completada_en, NOW.toISOString());
  });
});

// -- template variables -------------------------------------------------------
describe('variablesPara', () => {
  const plantilla = { clave: 'lead.reactivacion.email', canal: 'email', variables: ['nombre', 'n_propiedades', 'municipio', 'url', 'agente', 'baja_url'] };

  it('never builds the chassis-minted links, and never counts them as missing', () => {
    const { variables, faltan } = variablesPara({
      plantilla, lead: lead({ nombre: 'Ana' }), agente: 'intermediaria@brotea.dev',
      segmento: { v: 1, variables: { municipio: 'Madrid', n_propiedades: '5', url: 'https://inmobiliaria.brotea.dev' } },
    });
    assert.deepEqual(faltan, []);
    for (const v of VARIABLES_DEL_CHASIS) assert.equal(v in variables, false);
    assert.deepEqual(variables, {
      nombre: 'Ana', n_propiedades: '5', municipio: 'Madrid',
      url: 'https://inmobiliaria.brotea.dev', agente: 'intermediaria@brotea.dev',
    });
  });

  it('lets the per-lead value win over the campaign literal', () => {
    const { variables } = variablesPara({
      plantilla: { clave: 'x', variables: ['nombre'] }, lead: lead({ nombre: 'Ana' }), segmento: { v: 1, variables: { nombre: 'Quien sea' } },
    });
    assert.equal(variables.nombre, 'Ana');
  });

  it('names what is missing instead of inventing it', () => {
    const { faltan } = variablesPara({ plantilla, lead: lead({ nombre: 'Ana' }), segmento: { v: 1 } });
    assert.deepEqual(faltan, ['n_propiedades', 'municipio', 'url', 'agente']);
  });
});

// -- template readiness -------------------------------------------------------
describe('plantillaLista', () => {
  it('blocks a WhatsApp template Meta has not approved, and says so by name', () => {
    const out = plantillaLista({ clave: 'consentimiento.solicitud', canal: 'whatsapp', estado: 'borrador', content_estado: 'unsubmitted' });
    assert.equal(out.listo, false);
    assert.equal(out.code, 'template_not_approved');
    assert.match(out.motivo, /consentimiento\.solicitud/);
    assert.match(out.motivo, /unsubmitted/);
  });

  it('lets an approved WhatsApp template and any live email template through', () => {
    assert.equal(plantillaLista({ clave: 'a', canal: 'whatsapp', content_estado: 'approved' }).listo, true);
    assert.equal(plantillaLista({ clave: 'b', canal: 'email', estado: 'borrador' }).listo, true);
  });

  it('blocks a retired template and a campaign with none', () => {
    assert.equal(plantillaLista({ clave: 'c', canal: 'email', estado: 'retirada' }).code, 'template_retired');
    assert.equal(plantillaLista(null).code, 'sin_plantilla');
  });
});

// -- what the team reads ------------------------------------------------------
describe('the Telegram texts', () => {
  const inf = () => {
    let out = informeInicial({ alcance_estimado: { coincidentes: 3, alcanzables: 2, sin_contacto: 1 }, destinatarios_estimados: 2 });
    out = aplicarEnvio(out, { lead: 'lead001', now: NOW });
    out = aplicarRechazo(out, { lead: 'lead002', code: 'no_consent', status: 422, now: NOW });
    out = cerrarInforme(out, {
      destinatarios: [lead(), lead()],
      envios: [envio({ estado: 'entregado' })],
      enviadosEnRun: 1, now: NOW, completada: true,
    });
    out.excluidos = [...out.excluidos, { lead: 'lead003', code: 'sin_email', en: NOW.toISOString() }];
    out.informe_manager = { canal: 'whatsapp', estado: 'no_enviado', motivo: 'no hay settings campanas.gestor', comprobado_en: NOW.toISOString() };
    return out;
  };

  it('escapes and caps a campaign name someone typed HTML into', () => {
    const nombre = `<b>${'á'.repeat(200)}`;
    const texto = textoCampanaCompletada({ campana: campana({ nombre }), plantilla: { clave: 'x', canal: 'email' }, informe: inf() });
    assert.ok(!texto.includes('<b>&'), 'the injected tag must not survive as a tag');
    assert.ok(texto.includes('&lt;b&gt;'));
    // 80 chars of name (MAX_NOMBRE) at most, the rest of the line is ours.
    const primera = texto.split('\n')[0];
    assert.ok(primera.length < 140, primera.length);
  });

  it('reports the campaign in Spanish, with the manager report as a fact', () => {
    const texto = textoCampanaCompletada({ campana: campana(), plantilla: { clave: 'lead.reactivacion.email', canal: 'email' }, informe: inf() });
    assert.match(texto, /Campaña completada/);
    assert.match(texto, /Destinatarios: 2 · Enviados: 1/);
    assert.match(texto, /Entregados: 1 · Errores: 0 \(a fecha del cierre\)/);
    assert.match(texto, /Sin email: 1 · Sin consentimiento: 2/);
    assert.match(texto, /Del 23\/09 al 23\/09 \(1 día, 1 tanda\)/);
    assert.match(texto, /no enviado — no hay settings campanas.gestor/);
    assert.match(texto, /crm-inmobiliaria\.brotea\.dev/);
  });

  it('the arming preview shows reach and names the approval blocker', () => {
    const informe = informeInicial({ destinatarios_estimados: 191, alcance_estimado: { coincidentes: 216, alcanzables: 191, sin_contacto: 25 } });
    const texto = textoCampanaArmada({
      campana: campana({ nombre: 'CU-15' }),
      plantilla: { clave: 'consentimiento.solicitud', canal: 'whatsapp', content_estado: 'unsubmitted' },
      informe,
    });
    assert.match(texto, /Destinatarios estimados: 191/);
    assert.match(texto, /coincide con 216 · alcanzables 191 · sin teléfono 25/);
    assert.match(texto, /Bloqueada:.*no está aprobada por Meta/);
    assert.match(texto, /borrador/);
    // It must describe the credit model, not promise "1 cada 10 min" and then
    // send ten in five seconds on the first run.
    assert.match(texto, new RegExp(`tandas de hasta ${MAX_ENVIOS_POR_RUN} por pasada horaria`));
    assert.ok(!/1 cada \d+ min/.test(texto), texto);
  });

  it('says how to resume a paused campaign, and what blocked it', () => {
    const informe = { ...informeInicial(), runs_sin_envio: 3, bloqueo: { code: 'variables_missing', motivo: 'faltan variables: municipio' } };
    const texto = textoCampanaPausada({ campana: campana(), informe });
    assert.match(texto, /Campaña pausada/);
    assert.match(texto, /faltan variables: municipio/);
    assert.match(texto, /en_curso/);
  });

  it('a blocked campaign lists its problems and says nothing was sent', () => {
    const texto = textoCampanaBloqueada({
      campana: campana(),
      bloqueo: { code: 'segmento_invalido', motivo: 'el segmento no es válido', problemas: ['unknown key ojo'] },
    });
    assert.match(texto, /Campaña bloqueada/);
    assert.match(texto, /unknown key ojo/);
    assert.match(texto, /No se ha enviado nada/);
  });
});

describe('payloadCompletada', () => {
  it('carries campana_id, which is what the gate reads', () => {
    const informe = cerrarInforme(aplicarEnvio(informeInicial(), { lead: 'lead001', now: NOW }), {
      destinatarios: [lead()], envios: [envio({ estado: 'entregado' })], enviadosEnRun: 1, now: NOW, completada: true,
    });
    const payload = payloadCompletada({ campana: campana(), plantilla: { clave: 'lead.reactivacion.email', canal: 'email' }, informe });
    assert.equal(payload.campana_id, 'camp0000000000');
    assert.equal(payload.plantilla, 'lead.reactivacion.email');
    assert.equal(payload.canal, 'email');
    assert.equal(payload.destinatarios, 1);
    assert.equal(payload.enviados, 1);
    assert.equal(payload.errores, 0);
    assert.deepEqual(payload.dias, ['2026-09-23']);
  });
});
