// campanas.mjs — hourly: the campaign runner. It picks up the campaigns a
// human put in `programada` or `en_curso`, works out who is still owed a
// message, and hands the ones this hour allows to the chassis — one at a
// time, inside the campaign's window, never more than MAX_ENVIOS_POR_RUN.
//
// Every rule lives in campanas.lib.mjs and is unit-tested; this file is the
// I/O: PocketBase, the chassis, the events and the Telegram line.
//
// THIS JOB WRITES TO POCKETBASE, which the other three do not. ctx.dryRun only
// neutralises event() and notify() — ctx.pb is a live superuser client — so
// every write goes through escribir(), and the chassis is never called in a
// dry run at all. A rehearsal prints what it would send and changes nothing.
//
// What it will never do:
//   · send twice. Before each call the recipient is written to
//     `informe.en_vuelo`; the next run resolves a survivor by ADOPTION (is
//     there an `envios` row for that lead and template since then?) and, when
//     there is not, files it as `dudoso` and never retries it. A message that
//     may have left is not sent again; the ambiguity is reported.
//   · invent a value. A template variable we cannot resolve blocks the whole
//     campaign — the same variables are built for everyone, so one missing
//     name would otherwise burn ten leads on one bug.
//   · fall back to anything. No chassis credentials, no approved template, no
//     parseable segment: `informe.bloqueo`, one Telegram line a day, and the
//     campaign's `estado` is left exactly as it was.
import {
  ESTADOS_ACTIVOS, MAX_ENLACES_FALLIDOS, RECHAZOS_DE_RUN, RUNS_SIN_ENVIO_PARA_PAUSAR, SegmentoInvalido,
  aplicarEnvio, aplicarRechazo, cerrarInforme, cuotaDelRun, esRechazoAmbiguo, evaluarSegmento, informeInicial,
  payloadCompletada, pendientes, plantillaLista, textoCampanaArmada, textoCampanaBloqueada,
  textoCampanaCompletada, textoCampanaPausada, variablesPara,
} from './campanas.lib.mjs';
import { diaMadrid, esFecha, parseFecha } from './lib.mjs';

export const when = { hourly: true };

const TIMEOUT_CHASIS_MS = 20_000;
const CLAVE_GESTOR = 'campanas.gestor';   // settings row naming the lead to report to
const CLAVE_GUARDIA = 'agentes.guardia';  // settings row naming the on-duty user
const PLANTILLA_INFORME = 'campana.informe';
const PB_ID = /^[a-z0-9]+$/i;

export async function run({ pb, notify, event, log, now, dryRun = false, env = {} }) {
  if (!pb) throw new Error('campanas: no PocketBase client for this project');
  // The ONE gate between this job and the database. Everything that writes
  // goes through it, so a dry run is a dry run.
  const escribir = async (fn) => (dryRun ? null : fn());
  const hoy = diaMadrid(now);

  const chasis = {
    url: String(env.CHASSIS_URL ?? '').trim().replace(/\/+$/, ''),
    secret: String(env.OUTBOUND_SECRET ?? '').trim(),
  };
  const hayChasis = Boolean(chasis.url && chasis.secret);

  /**
   * One chassis call. Returns:
   *   { ok: true, status, envio_id, actividad_id }        the message left
   *   { ok: false, status, code }                          it answered "no"
   *   { ambiguo: true, code }                              it never answered
   * The URL carries the secret and is therefore NEVER logged: the route and
   * the status are what a diagnostic needs.
   */
  const llamarChasis = async (ruta, cuerpo) => {
    let res;
    try {
      res = await fetch(`${chasis.url}${ruta}?secret=${encodeURIComponent(chasis.secret)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(TIMEOUT_CHASIS_MS),
      });
    } catch (e) {
      // No answer at all: whether the message left is unknowable from here.
      return { ambiguo: true, status: 0, code: e?.name === 'TimeoutError' ? 'chassis_timeout' : 'chassis_unreachable' };
    }
    const texto = await res.text();
    let body = null;
    try { body = texto ? JSON.parse(texto) : null; } catch { body = null; }
    if (res.ok && body?.ok !== false) {
      return {
        ok: true, status: res.status,
        envio_id: body?.envio_id ?? null,
        // The two routes disagree on the name; read both rather than lose the link.
        actividad_id: body?.activity_id ?? body?.actividad_id ?? null,
      };
    }
    const code = body?.error?.code
      || (typeof body?.error === 'string' ? body.error : null)
      || `http_${res.status}`;
    return { ok: false, status: res.status, code: String(code).slice(0, 60) };
  };

  // -- the data, read once ----------------------------------------------------
  const campanas = await pb.collection('campanas').getFullList({ expand: 'plantilla' });
  const activas = campanas.filter((c) => ESTADOS_ACTIVOS.includes(c.estado));
  const borradores = campanas.filter((c) => c.estado === 'borrador');
  if (!activas.length && !borradores.length) {
    log('campanas: nothing to arm and nothing running');
    return;
  }
  const leads = await pb.collection('leads').getFullList({ expand: 'asignado' });

  // Who signs the message: the lead's own agent, else the on-duty one. The
  // name is whatever the `users` row says — including, on this instance, an
  // email address. That is the truth in the data and it is not prettified here.
  let guardia = null;
  try {
    const rows = await pb.collection('settings').getFullList({ filter: `key = "${CLAVE_GUARDIA}"` });
    const id = rows[0]?.value?.text;
    if (id) guardia = (await pb.collection('users').getOne(id))?.name || null;
  } catch (e) {
    log(`campanas: on-duty agent unavailable: ${e?.message ?? e}`);
  }
  const agenteDe = (lead) => lead.expand?.asignado?.name || guardia || '';

  const enviosDe = (id) => pb.collection('envios').getFullList({ filter: `campana = "${id}"` });

  /** Write the blockage, tell Telegram at most once a Madrid day, change no state. */
  const bloquear = async (campana, informe, bloqueo) => {
    const previo = informe.bloqueo;
    const avisar = !previo || previo.code !== bloqueo.code || previo.avisado_dia !== hoy;
    const nuevo = { ...bloqueo, en: now.toISOString(), avisado_dia: avisar ? hoy : previo.avisado_dia };
    const out = { ...informeInicial(informe), bloqueo: nuevo };
    await escribir(() => pb.collection('campanas').update(campana.id, { informe: out }));
    log(`campanas: ${campana.nombre}: blocked (${bloqueo.code})`);
    if (avisar) {
      await event('campana.error', { campana_id: campana.id, nombre: campana.nombre, code: bloqueo.code, motivo: bloqueo.motivo });
      await notify(textoCampanaBloqueada({ campana, bloqueo: nuevo }));
    }
    return out;
  };

  // -- drafts: a preview, never a send ---------------------------------------
  const armar = async (campana) => {
    let informe = informeInicial(campana.informe);
    if (informe.armada_en) return;
    const plantilla = campana.expand?.plantilla ?? null;
    let alcance;
    try {
      alcance = evaluarSegmento({ segmento: campana.segmento, leads, canal: plantilla?.canal ?? 'email', now });
    } catch (e) {
      if (!(e instanceof SegmentoInvalido)) throw e;
      await bloquear(campana, informe, { code: 'segmento_invalido', motivo: 'el segmento no es válido', problemas: e.problemas }); // lang-sweep: allow
      return;
    }
    const lista = plantillaLista(plantilla);
    informe = {
      ...informe,
      armada_en: now.toISOString(),
      destinatarios_estimados: alcance.destinatarios.length,
      alcance_estimado: {
        coincidentes: alcance.coincidentes,
        alcanzables: alcance.alcanzables,
        sin_contacto: alcance.excluidos.length,
      },
      bloqueo: lista.listo ? null : { code: lista.code, motivo: lista.motivo, en: now.toISOString(), avisado_dia: hoy },
    };
    await escribir(() => pb.collection('campanas').update(campana.id, { informe }));
    await event('campana.armada', {
      campana_id: campana.id, nombre: campana.nombre, plantilla: plantilla?.clave ?? null,
      canal: plantilla?.canal ?? null, destinatarios_estimados: informe.destinatarios_estimados,
      ...informe.alcance_estimado, bloqueo: informe.bloqueo?.code ?? null,
    });
    await notify(textoCampanaArmada({ campana, plantilla: plantilla ?? {}, informe }));
    log(`campanas: ${campana.nombre}: armed, ${informe.destinatarios_estimados} recipient(s) estimated${informe.bloqueo ? ` (blocked: ${informe.bloqueo.code})` : ''}`);
  };

  // -- the manager's report: checked as data, never faked ---------------------
  const informeDelGestor = async (campana, informe, envios, destinatarios) => {
    const comprobado_en = now.toISOString();
    const no = (motivo) => ({ canal: 'whatsapp', estado: 'no_enviado', motivo, comprobado_en });
    let gestorId = null;
    try {
      const rows = await pb.collection('settings').getFullList({ filter: `key = "${CLAVE_GESTOR}"` });
      gestorId = rows[0]?.value?.text ?? null;
    } catch (e) {
      return no(`no se pudo leer settings ${CLAVE_GESTOR}: ${String(e?.message ?? e).slice(0, 80)}`); // lang-sweep: allow
    }
    if (!gestorId) return no(`no hay una fila settings ${CLAVE_GESTOR} que diga a quién informar`); // lang-sweep: allow
    let gestor = null;
    try { gestor = await pb.collection('leads').getOne(gestorId); } catch { gestor = null; }
    if (!gestor) return no(`el lead del gestor (${gestorId}) no existe`); // lang-sweep: allow
    if (!String(gestor.telefono ?? '').trim()) return no('el lead del gestor no tiene teléfono'); // lang-sweep: allow
    // The only read left on this path that could throw. It runs AFTER the
    // sends, so letting it escape would throw away the run's whole bookkeeping
    // — the dudosos, the enviados_ids, the in-flight list — over a report.
    let plantilla = null;
    try {
      const plantillas = await pb.collection('plantillas').getFullList({ filter: `clave = "${PLANTILLA_INFORME}"` });
      plantilla = plantillas[0] ?? null;
    } catch (e) {
      return no(`no se pudo leer la plantilla ${PLANTILLA_INFORME}: ${String(e?.message ?? e).slice(0, 80)}`); // lang-sweep: allow
    }
    if (!plantilla) return no(`no existe la plantilla ${PLANTILLA_INFORME}`); // lang-sweep: allow
    if (plantilla.content_estado !== 'approved') {
      return no(`la plantilla ${PLANTILLA_INFORME} no está aprobada por Meta (Twilio Content: ${plantilla.content_estado || 'sin enviar'})`); // lang-sweep: allow
    }
    if (!hayChasis) return no('no hay credenciales del chasis en jobs-<slug>.env'); // lang-sweep: allow
    if (dryRun) return no('dry-run: no se llama al chasis'); // lang-sweep: allow

    // Every number here is counted, not guessed: replies are the inbound
    // activities linked to this campaign, opt-outs are recipients who revoked
    // consent after it started.
    let respuestas = 0;
    try {
      const actividades = await pb.collection('actividades').getFullList({ filter: `campana = "${campana.id}"` });
      respuestas = actividades.filter((a) => a.direccion === 'entrante').length;
    } catch { respuestas = 0; }
    const desde = parseFecha(informe.iniciada_en || informe.armada_en || campana.created);
    const bajas = destinatarios.filter((l) => {
      if (l.consentimiento === true) return false;
      const en = parseFecha(l.consentimiento_en);
      return esFecha(en) && esFecha(desde) && en >= desde;
    }).length;
    const variables = {
      campana: String(campana.nombre ?? '').slice(0, 120),
      // The reconciled count, the same one the Telegram line reports: the
      // ledger alone would undercount a send whose envios row the chassis
      // never managed to write, and two reports of one campaign disagreeing
      // is worse than either number.
      enviados: String(Math.max(envios.filter((e) => e.estado !== 'error').length, informe.enviados_ids?.length ?? 0)),
      entregados: String(envios.filter((e) => ['entregado', 'abierto', 'click'].includes(e.estado)).length),
      respuestas: String(respuestas),
      bajas: String(bajas),
      errores: String(envios.filter((e) => e.estado === 'error').length),
    };
    const r = await llamarChasis('/send-whatsapp', { lead_id: gestor.id, plantilla: PLANTILLA_INFORME, variables, campana_id: campana.id });
    if (r.ok) return { canal: 'whatsapp', estado: 'enviado', motivo: null, comprobado_en };
    return no(`el chasis no lo envió (${r.code})`); // lang-sweep: allow
  };

  // -- one running campaign ---------------------------------------------------
  const procesar = async (campana) => {
    const plantilla = campana.expand?.plantilla ?? null;
    let informe = informeInicial(campana.informe);
    let envios = await enviosDe(campana.id);
    const fallosTransporte = [];

    // 1. Repair the links a previous run could not write. The message left
    //    long ago; only the join is missing, and it is the join the CRM reads.
    if (informe.enlaces_fallidos.length) {
      const pendientesEnlace = [];
      for (const fallo of informe.enlaces_fallidos) {
        try {
          if (fallo.envio_id) await escribir(() => pb.collection('envios').update(fallo.envio_id, { campana: campana.id }));
          if (fallo.actividad_id) await escribir(() => pb.collection('actividades').update(fallo.actividad_id, { campana: campana.id }));
        } catch (e) {
          pendientesEnlace.push({ ...fallo, error: String(e?.message ?? e).slice(0, 120) });
        }
      }
      informe = { ...informe, enlaces_fallidos: pendientesEnlace };
      if (!dryRun) envios = await enviosDe(campana.id);
      log(`campanas: ${campana.nombre}: repaired ${informe.enlaces_fallidos.length ? 'some' : 'all'} broken link(s)`);
    }

    // 2. Resolve what was in flight when a previous run died, by adoption.
    if (informe.en_vuelo.length) {
      const siguen = [];
      const dudosos = [...informe.dudosos];
      for (const entrada of informe.en_vuelo) {
        let adoptado = null;
        // `informe` is editable in PocketBase Admin, so an id out of it is
        // untrusted input on its way into a filter string.
        if (!PB_ID.test(String(entrada.lead ?? ''))) {
          log(`campanas: ${campana.nombre}: discarding an in-flight entry with an impossible lead id`);
          continue;
        }
        try {
          const suyos = await pb.collection('envios').getFullList({ filter: `lead = "${entrada.lead}"` });
          const desde = parseFecha(entrada.desde);
          adoptado = suyos.find((e) => {
            // Adoption RE-STAMPS the row as ours, so it has to be ours: the
            // same template, and not already claimed by another campaign. A
            // row with no template at all is somebody else's free-text send.
            if (!plantilla?.id || e.plantilla !== plantilla.id) return false;
            if (e.campana && e.campana !== campana.id) return false;
            const creado = parseFecha(e.enviado_en || e.created);
            return esFecha(creado) && esFecha(desde) && creado >= new Date(desde.getTime() - 60_000);
          }) ?? null;
        } catch (e) {
          log(`campanas: ${campana.nombre}: could not resolve an in-flight send: ${String(e?.message ?? e).slice(0, 120)}`);
          siguen.push(entrada);
          continue;
        }
        if (adoptado) {
          try { await escribir(() => pb.collection('envios').update(adoptado.id, { campana: campana.id })); } catch { /* repaired next run */ }
          informe = aplicarEnvio(informe, { lead: entrada.lead, now });
          log(`campanas: ${campana.nombre}: adopted an in-flight send for lead ${entrada.lead}`);
        } else {
          // It may or may not have gone out. It is never retried.
          dudosos.push({ lead: entrada.lead, desde: entrada.desde, resuelto_en: now.toISOString() });
          log(`campanas: ${campana.nombre}: lead ${entrada.lead} left unresolved (dudoso), never retried`);
        }
      }
      informe = { ...informe, en_vuelo: siguen, dudosos };
      if (!dryRun) envios = await enviosDe(campana.id);
    }

    // 3. Everything that must be true before a single message is built.
    if (!hayChasis) {
      return bloquear(campana, informe, {
        code: 'sin_chasis',
        motivo: 'faltan CHASSIS_URL u OUTBOUND_SECRET en ~/.config/brotea/jobs-<slug>.env', // lang-sweep: allow
      });
    }
    const lista = plantillaLista(plantilla);
    if (!lista.listo) return bloquear(campana, informe, { code: lista.code, motivo: lista.motivo });

    let alcance;
    try {
      alcance = evaluarSegmento({ segmento: campana.segmento, leads, canal: plantilla.canal, now });
    } catch (e) {
      if (!(e instanceof SegmentoInvalido)) throw e;
      return bloquear(campana, informe, { code: 'segmento_invalido', motivo: 'el segmento no es válido', problemas: e.problemas }); // lang-sweep: allow
    }
    // The unreachable are recorded once, as facts, and never written to.
    const yaExcluidos = new Set(informe.excluidos.map((x) => x.lead));
    const nuevosExcluidos = alcance.excluidos
      .filter((x) => !yaExcluidos.has(x.lead))
      .map((x) => ({ ...x, en: now.toISOString() }));
    if (nuevosExcluidos.length) informe = { ...informe, excluidos: [...informe.excluidos, ...nuevosExcluidos] };
    informe = { ...informe, bloqueo: null };

    // 4. How many this hour allows.
    const cuota = cuotaDelRun({ campana, envios, now });
    if (['horario_invalido', 'lote_invalido'].includes(cuota.motivo)) {
      return bloquear(campana, informe, {
        code: cuota.motivo,
        motivo: cuota.motivo === 'horario_invalido'
          ? `la ventana ${campana.hora_desde || '--:--'}–${campana.hora_hasta || '--:--'} no es válida (no hay vuelta de hora)` // lang-sweep: allow
          : 'lote_diario tiene que ser un entero de 1 o más', // lang-sweep: allow
      });
    }
    const porEnviar = pendientes({ destinatarios: alcance.destinatarios, envios, informe });
    log(`campanas: ${campana.nombre}: ${alcance.destinatarios.length} recipient(s), ${porEnviar.length} pending, quota ${cuota.permitidos} (${cuota.motivo}), ${cuota.enviadosHoy} sent today`);

    // 5. The send loop.
    let enviadosEnRun = 0;
    let simulados = 0;
    let abortado = false;
    for (const lead of porEnviar.slice(0, cuota.permitidos)) {
      const { variables, faltan } = variablesPara({ plantilla, lead, segmento: campana.segmento, agente: agenteDe(lead) });
      if (faltan.length) {
        // The same variables are built for everyone: this is a run-level bug,
        // not this lead's problem, and it must not cost ten messages.
        informe = await bloquear(campana, informe, {
          code: 'variables_missing',
          motivo: `faltan valores para la plantilla: ${faltan.join(', ')}`, // lang-sweep: allow
          faltan,
        });
        abortado = true;
        break;
      }
      if (dryRun) {
        // Counted apart from enviadosEnRun on purpose: a rehearsal that
        // incremented the real counter would emit campana.lote_enviado and
        // report a batch that never left.
        simulados++;
        log(`campanas: ${campana.nombre}: WOULD SEND ${plantilla.clave} (${plantilla.canal}) to lead ${lead.id} with [${Object.keys(variables).sort().join(', ')}]`);
        continue;
      }

      // The crash window opens here and closes after the links are written.
      const desde = new Date().toISOString();
      const conEnVuelo = { ...informe, en_vuelo: [...informe.en_vuelo, { lead: lead.id, desde }] };
      try {
        await escribir(() => pb.collection('campanas').update(campana.id, { informe: conEnVuelo }));
        informe = conEnVuelo;
      } catch (e) {
        // If we cannot record the intent we do not send: an unrecorded send is
        // the one we could double later.
        log(`campanas: ${campana.nombre}: could not record the intent for lead ${lead.id}, not sending: ${String(e?.message ?? e).slice(0, 120)}`);
        break;
      }

      const ruta = plantilla.canal === 'email' ? '/send-email' : '/send-whatsapp';
      const r = await llamarChasis(ruta, {
        lead_id: lead.id, plantilla: plantilla.clave, variables,
        // The WhatsApp route stamps the campaign itself; the patches below
        // cover the email route and any chassis that ignores this field.
        ...(plantilla.canal === 'whatsapp' ? { campana_id: campana.id } : {}),
      });

      if (r.ambiguo) {
        // No answer: the entry STAYS in en_vuelo so the next run adopts it or
        // files it as dudoso. It is counted, and the run will fail loudly.
        informe = { ...informe, rechazos: { ...informe.rechazos, [r.code]: (informe.rechazos[r.code] ?? 0) + 1 } };
        await escribir(() => pb.collection('campanas').update(campana.id, { informe }));
        fallosTransporte.push(`${lead.id}: ${r.code}`);
        log(`campanas: ${campana.nombre}: ${ruta} did not answer for lead ${lead.id} (${r.code}); stopping this campaign`);
        break;
      }

      if (!r.ok && esRechazoAmbiguo(r)) {
        // The chassis said no AFTER the message may already have gone (a 502
        // from /send-email happens on writes that run once nodemailer has
        // accepted it). Retrying is how one person gets three copies, so this
        // is handled exactly like silence: the entry STAYS in en_vuelo, the
        // next run adopts it or files it as dudoso, and the run fails loudly.
        informe = { ...informe, rechazos: { ...informe.rechazos, [r.code]: (informe.rechazos[r.code] ?? 0) + 1 } };
        await escribir(() => pb.collection('campanas').update(campana.id, { informe }));
        fallosTransporte.push(`${lead.id}: ${r.code}`);
        log(`campanas: ${campana.nombre}: ${ruta} answered ${r.code} (HTTP ${r.status}) for lead ${lead.id} — it may have been sent; not retrying`);
        break;
      }

      if (!r.ok) {
        if (RECHAZOS_DE_RUN.includes(r.code)) {
          informe = await bloquear(campana, informe, { code: r.code, motivo: `el chasis rechazó el envío: ${r.code}` }); // lang-sweep: allow
          abortado = true;
          break;
        }
        informe = aplicarRechazo(informe, { lead: lead.id, code: r.code, status: r.status, now });
        await escribir(() => pb.collection('campanas').update(campana.id, { informe }));
        log(`campanas: ${campana.nombre}: ${ruta} refused lead ${lead.id} (${r.code}, HTTP ${r.status})`);
        continue;
      }

      // It left. From here the lead counts as sent whatever else fails.
      const fallos = [];
      const enlazar = async (coleccion, id) => {
        if (!id) return;
        try { await escribir(() => pb.collection(coleccion).update(id, { campana: campana.id })); } catch (e) { fallos.push(String(e?.message ?? e).slice(0, 120)); }
      };
      await enlazar('envios', r.envio_id);
      await enlazar('actividades', r.actividad_id);
      // aplicarEnvio() records the lead in informe.enviados_ids, which is what
      // makes "already written to" independent of the two patches above ever
      // landing — and of the chassis having managed to write an envios row at
      // all (it answers ok with envio_id: null when its own ledger write
      // failed, and swallowing that is documented behaviour on its side).
      informe = aplicarEnvio(informe, { lead: lead.id, now: new Date() });
      if (!r.envio_id) log(`campanas: ${campana.nombre}: the chassis wrote no envios row for lead ${lead.id}; the send is recorded in the informe`);
      if (fallos.length) {
        informe = {
          ...informe,
          enlaces_fallidos: [...informe.enlaces_fallidos, {
            envio_id: r.envio_id ?? null, actividad_id: r.actividad_id ?? null, lead: lead.id, error: fallos.join('; '),
          }].slice(-MAX_ENLACES_FALLIDOS),
        };
      }
      enviadosEnRun++;
      const primera = campana.estado === 'programada' && enviadosEnRun === 1;
      await escribir(() => pb.collection('campanas').update(campana.id, {
        ultimo_envio_en: new Date().toISOString(),
        informe,
        ...(primera ? { estado: 'en_curso' } : {}),
      }));
      if (primera) {
        campana.estado = 'en_curso';
        await event('campana.iniciada', { campana_id: campana.id, nombre: campana.nombre, plantilla: plantilla.clave, canal: plantilla.canal });
      }
      log(`campanas: ${campana.nombre}: sent ${plantilla.clave} to lead ${lead.id}`);
    }

    // 6. Close the run: the counters come back from the ledger.
    if (enviadosEnRun && !dryRun) envios = await enviosDe(campana.id);
    const quedan = pendientes({ destinatarios: alcance.destinatarios, envios, informe });
    // A campaign is finished only when there is nobody left AND nothing is
    // unresolved. A run that aborted on a blockage, one the chassis never
    // answered, or one with a send still in flight has finished nothing —
    // completing there would close the report over an open question.
    const completada = !abortado && !fallosTransporte.length && informe.en_vuelo.length === 0 && quedan.length === 0;
    informe = cerrarInforme(informe, { destinatarios: alcance.destinatarios, envios, enviadosEnRun, now, completada });

    if (simulados) log(`campanas: ${campana.nombre}: dry run, ${simulados} message(s) would have gone out`);
    if (enviadosEnRun) {
      await event('campana.lote_enviado', {
        campana_id: campana.id, nombre: campana.nombre, enviados: enviadosEnRun,
        pendientes: quedan.length, dia: hoy,
      });
    }

    let estado = campana.estado;
    if (completada) {
      estado = 'completada';
      // Sent once, ever. If the closing write below fails, the next run
      // recomputes `completada` and would otherwise WhatsApp the manager a
      // second report — so the result is written on its own the moment it is
      // known, and an already-sent report is never re-sent.
      if (informe.informe_manager?.estado !== 'enviado') {
        const informeManager = await informeDelGestor(campana, informe, envios, alcance.destinatarios);
        informe = { ...informe, informe_manager: informeManager };
        if (informeManager.estado === 'enviado') {
          await escribir(() => pb.collection('campanas').update(campana.id, { informe }));
        }
      }
    } else if (!abortado && informe.runs_sin_envio >= RUNS_SIN_ENVIO_PARA_PAUSAR) {
      estado = 'pausada';
      informe = {
        ...informe,
        bloqueo: informe.bloqueo ?? {
          code: 'sin_envios',
          motivo: `${informe.runs_sin_envio} pasadas seguidas sin enviar nada`, // lang-sweep: allow
          en: now.toISOString(), avisado_dia: hoy,
        },
      };
    }

    await escribir(() => pb.collection('campanas').update(campana.id, { informe, ...(estado !== campana.estado ? { estado } : {}) }));

    if (completada) {
      const payload = payloadCompletada({ campana, plantilla, informe });
      await event('campana.completada', payload);
      await notify(textoCampanaCompletada({ campana, plantilla, informe }));
      log(`campanas: ${campana.nombre}: completed, ${informe.enviados} sent to ${informe.destinatarios} recipient(s)`);
    } else if (estado === 'pausada') {
      await event('campana.pausada', { campana_id: campana.id, nombre: campana.nombre, runs_sin_envio: informe.runs_sin_envio, motivo: informe.bloqueo?.motivo ?? null });
      await notify(textoCampanaPausada({ campana, informe }));
      log(`campanas: ${campana.nombre}: paused after ${informe.runs_sin_envio} run(s) with nothing sent`);
    }

    if (fallosTransporte.length) throw new Error(`campanas: ${campana.nombre}: the chassis did not answer for ${fallosTransporte.length} send(s): ${fallosTransporte.join(', ')}`);
    return informe;
  };

  // -- the run ----------------------------------------------------------------
  const fallos = [];
  for (const campana of borradores) {
    if (!PB_ID.test(String(campana.id))) continue;
    try { await armar(campana); } catch (e) { fallos.push(`${campana.nombre}: ${String(e?.message ?? e).slice(0, 160)}`); }
  }
  for (const campana of activas) {
    if (!PB_ID.test(String(campana.id))) continue;
    // One broken campaign must not take the others down — but a failure is
    // still a failure: collected here and rethrown so Alertas hears it.
    try {
      await procesar(campana);
    } catch (e) {
      log(`campanas: ${campana.nombre}: ${String(e?.message ?? e).slice(0, 200)}`);
      fallos.push(`${campana.nombre}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  if (fallos.length) throw new Error(`${fallos.length} campaign(s) failed: ${fallos.join(' | ')}`);
  return `${activas.length} campaign(s) running, ${borradores.length} draft(s)${dryRun ? ' (dry-run: nothing written, nothing sent)' : ''}`;
}
