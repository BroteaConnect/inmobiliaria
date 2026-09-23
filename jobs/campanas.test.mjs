// campanas.test.mjs — the runner's I/O half against a fake PocketBase and a
// fake chassis. The rules are tested in campanas.lib.test.mjs; what is tested
// here is what only the job can get wrong:
//   · a dry run writes NOTHING and calls the chassis ZERO times (this job is
//     the first one in the repo that writes to PocketBase at all)
//   · the send is linked to the campaign on both rows, reading the activity id
//     under either of the two names the chassis routes use
//   · a refusal is data, a missing precondition is a blockage, and neither
//     changes `estado` behind the team's back
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { run, when } from './campanas.mjs';

const NOW = new Date('2026-09-23T10:00:00.000Z'); // 12:00 Madrid, inside 08:00–22:00

// -- a PocketBase shaped like the runner's client, with every write recorded --
const RELACIONES = { plantilla: 'plantillas', asignado: 'users', lead: 'leads', campana: 'campanas' };

function fakePb(datos) {
  const escrituras = [];
  const store = JSON.parse(JSON.stringify(datos));
  const coincide = (rec, filter) => {
    if (!filter) return true;
    const m = /^(\w+)\s*=\s*"([^"]*)"$/.exec(filter.trim());
    if (!m) throw new Error(`fakePb: unsupported filter ${filter}`);
    return String(rec[m[1]] ?? '') === m[2];
  };
  const expandir = (rec, expand) => {
    if (!expand) return rec;
    const out = { ...rec, expand: {} };
    for (const campo of expand.split(',').map((s) => s.trim())) {
      const col = RELACIONES[campo];
      const id = rec[campo];
      const found = id ? (store[col] ?? []).find((r) => r.id === id) : null;
      if (found) out.expand[campo] = found;
    }
    return out;
  };
  return {
    escrituras,
    store,
    collection: (nombre) => ({
      getFullList: async ({ filter = '', expand = '' } = {}) =>
        (store[nombre] ?? []).filter((r) => coincide(r, filter)).map((r) => expandir(r, expand)),
      getOne: async (id, { expand = '' } = {}) => {
        const rec = (store[nombre] ?? []).find((r) => r.id === id);
        if (!rec) { const e = new Error('not found'); e.status = 404; throw e; }
        return expandir(rec, expand);
      },
      update: async (id, body) => {
        escrituras.push({ coleccion: nombre, id, body });
        const rec = (store[nombre] ?? []).find((r) => r.id === id);
        if (!rec) { const e = new Error('not found'); e.status = 404; throw e; }
        Object.assign(rec, body);
        return rec;
      },
      create: async (body) => {
        escrituras.push({ coleccion: nombre, id: null, body });
        const rec = { id: `nuevo${(store[nombre] ?? []).length}`, ...body };
        (store[nombre] ??= []).push(rec);
        return rec;
      },
    }),
  };
}

const plantillaEmail = {
  id: 'plant000000001', clave: 'lead.reactivacion.email', canal: 'email', categoria: 'marketing',
  estado: 'borrador', content_estado: '', variables: ['nombre', 'municipio', 'url', 'agente', 'baja_url'],
};
const plantillaWhatsapp = {
  id: 'plant000000002', clave: 'consentimiento.solicitud', canal: 'whatsapp', categoria: 'marketing',
  estado: 'borrador', content_estado: 'unsubmitted', variables: ['nombre', 'agencia'],
};
const leadUno = {
  id: 'lead000000001', nombre: 'Ana', email: 'ana@example.com', telefono: '+34600000001',
  etapa: 'nuevo', origen: 'web', consentimiento: true, idioma: 'es', canal_preferido: 'email',
  ultimo_contacto: '', created: '2026-01-01 00:00:00.000Z', asignado: '',
};
const campanaBase = {
  id: 'camp000000001', nombre: 'Ensayo', plantilla: plantillaEmail.id,
  segmento: { v: 1, incluye_ids: [leadUno.id], max: 1, variables: { municipio: 'Madrid', url: 'https://x.dev' } },
  lote_diario: 1, intervalo_min: 0, hora_desde: '08:00', hora_hasta: '22:00', inicio: '',
  estado: 'programada', ultimo_envio_en: '', informe: null, created: '2026-09-01 00:00:00.000Z',
};
const datosBase = (over = {}) => ({
  campanas: [{ ...campanaBase }],
  leads: [{ ...leadUno }],
  envios: [],
  actividades: [],
  plantillas: [plantillaEmail, plantillaWhatsapp],
  settings: [{ id: 'set1', key: 'agentes.guardia', value: { v: 1, text: 'user1' } }],
  users: [{ id: 'user1', name: 'intermediaria@brotea.dev' }],
  ...over,
});

// A context whose event/notify are recorded, exactly as the runner builds it.
const contexto = (pb, over = {}) => {
  const eventos = [];
  const mensajes = [];
  const lineas = [];
  return {
    ctx: { pb, now: NOW, dryRun: false, env: { CHASSIS_URL: 'https://api.example.dev', OUTBOUND_SECRET: 'secreto' },
      log: (m) => lineas.push(m),
      event: async (type, payload) => { eventos.push({ type, payload }); },
      notify: async (text) => { mensajes.push(text); },
      ...over },
    eventos, mensajes, lineas,
  };
};

// -- a chassis that answers whatever the test says ---------------------------
let fetchOriginal;
let llamadas;
const conChasis = (responder) => {
  globalThis.fetch = async (url, init) => {
    llamadas.push({ url: String(url), body: JSON.parse(init.body) });
    return responder(String(url), JSON.parse(init.body));
  };
};
const respuesta = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { fetchOriginal = globalThis.fetch; llamadas = []; });
afterEach(() => { globalThis.fetch = fetchOriginal; });

describe('the job contract', () => {
  it('runs hourly and exports run()', () => {
    assert.deepEqual(when, { hourly: true });
    assert.equal(typeof run, 'function');
  });
});

describe('a dry run', () => {
  it('writes nothing to PocketBase and never calls the chassis', async () => {
    conChasis(() => { throw new Error('the chassis must not be called in a dry run'); });
    const pb = fakePb(datosBase());
    const { ctx, eventos, lineas } = contexto(pb, { dryRun: true });
    const resumen = await run(ctx);

    assert.deepEqual(pb.escrituras, [], 'a dry run must not write a single row');
    assert.equal(llamadas.length, 0);
    assert.equal(eventos.length, 0, 'nothing happened, so nothing is recorded');
    assert.ok(lineas.some((l) => l.includes('WOULD SEND')), lineas.join('\n'));
    assert.match(resumen, /dry-run: nothing written, nothing sent/);
    // And the row on the "instance" is untouched.
    assert.equal(pb.store.campanas[0].estado, 'programada');
    assert.equal(pb.store.campanas[0].informe, null);
  });
});

describe('a send', () => {
  it('links the envio and the actividad to the campaign and completes', async () => {
    const pb = fakePb(datosBase({
      envios: [{ id: 'env1', lead: leadUno.id, plantilla: plantillaEmail.id, campana: '', estado: 'enviado', enviado_en: '', created: '' }],
      actividades: [{ id: 'act1', lead: leadUno.id, campana: '', tipo: 'email' }],
    }));
    // The ledger rows exist but belong to no campaign yet: the chassis creates
    // them on send and answers with their ids.
    pb.store.envios = [];
    pb.store.actividades = [];
    conChasis((url) => {
      assert.ok(url.startsWith('https://api.example.dev/send-email?secret='), url);
      pb.store.envios.push({ id: 'env1', lead: leadUno.id, plantilla: plantillaEmail.id, campana: '', estado: 'enviado', enviado_en: '2026-09-23 10:00:00.000Z', created: '2026-09-23 10:00:00.000Z' });
      pb.store.actividades.push({ id: 'act1', lead: leadUno.id, campana: '', tipo: 'email' });
      // /send-email answers `activity_id`; /send-whatsapp answers `actividad_id`.
      return respuesta(200, { ok: true, envio_id: 'env1', activity_id: 'act1', message_id: '<x@brotea.dev>' });
    });
    const { ctx, eventos, mensajes } = contexto(pb);
    await run(ctx);

    assert.equal(llamadas.length, 1);
    assert.deepEqual(llamadas[0].body.variables, {
      nombre: 'Ana', municipio: 'Madrid', url: 'https://x.dev', agente: 'intermediaria@brotea.dev',
    });
    assert.equal('baja_url' in llamadas[0].body.variables, false, 'the chassis mints and signs that link');

    assert.equal(pb.store.envios[0].campana, campanaBase.id);
    assert.equal(pb.store.actividades[0].campana, campanaBase.id);
    const campana = pb.store.campanas[0];
    assert.equal(campana.estado, 'completada');
    assert.equal(campana.informe.enviados, 1);
    assert.deepEqual(campana.informe.por_dia, { '2026-09-23': 1 });
    assert.deepEqual(campana.informe.en_vuelo, []);
    assert.ok(campana.ultimo_envio_en, 'the pace is measured from a real stamp');

    const tipos = eventos.map((e) => e.type);
    assert.deepEqual(tipos, ['campana.iniciada', 'campana.lote_enviado', 'campana.completada']);
    const completada = eventos.at(-1).payload;
    assert.equal(completada.campana_id, campanaBase.id);
    assert.equal(completada.enviados, 1);
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0], /Campaña completada/);
    // The manager's report is never faked: it says why it did not go.
    assert.equal(campana.informe.informe_manager.estado, 'no_enviado');
    assert.match(campana.informe.informe_manager.motivo, /campanas\.gestor/);
  });

  it('records the in-flight entry BEFORE calling the chassis', async () => {
    const pb = fakePb(datosBase());
    let enVueloAlLlamar = null;
    conChasis(() => {
      enVueloAlLlamar = JSON.parse(JSON.stringify(pb.store.campanas[0].informe.en_vuelo));
      return respuesta(200, { ok: true, envio_id: null, activity_id: null });
    });
    const { ctx } = contexto(pb);
    await run(ctx);
    assert.equal(enVueloAlLlamar.length, 1);
    assert.equal(enVueloAlLlamar[0].lead, leadUno.id);
    assert.deepEqual(pb.store.campanas[0].informe.en_vuelo, [], 'and it is cleared once the send is resolved');
  });

  it('counts a refusal as data, excludes the lead and still completes', async () => {
    const pb = fakePb(datosBase());
    conChasis(() => respuesta(400, { ok: false, error: { code: 'no_email', text: 'el lead no tiene email' } }));
    const { ctx, eventos } = contexto(pb);
    await run(ctx);
    const informe = pb.store.campanas[0].informe;
    assert.deepEqual(informe.rechazos, { no_email: 1 });
    assert.deepEqual(informe.excluidos.map((e) => e.code), ['no_email']);
    assert.equal(informe.enviados, 0);
    assert.equal(pb.store.campanas[0].estado, 'completada');
    assert.ok(eventos.some((e) => e.type === 'campana.completada'));
  });

  it('keeps a retryable refusal pending and gives up after MAX_REINTENTOS_LEAD', async () => {
    const pb = fakePb(datosBase());
    conChasis(() => respuesta(502, { ok: false, error: { code: 'provider_unavailable', text: 'proveedor caído' } }));
    for (let i = 0; i < 3; i++) {
      const { ctx } = contexto(pb);
      await run(ctx);
    }
    const informe = pb.store.campanas[0].informe;
    assert.equal(informe.rechazos.provider_unavailable, 3);
    assert.deepEqual(informe.excluidos.map((e) => e.code), ['agotado']);
    assert.equal(pb.store.campanas[0].estado, 'completada');
  });

  it('leaves an unanswered send in flight, fails the run, and never retries it blind', async () => {
    const pb = fakePb(datosBase());
    conChasis(() => { const e = new Error('socket hang up'); e.name = 'TypeError'; throw e; });
    const { ctx } = contexto(pb);
    await assert.rejects(run(ctx), /did not answer/);
    assert.deepEqual(pb.store.campanas[0].informe.en_vuelo.map((e) => e.lead), [leadUno.id]);
    assert.equal(pb.store.campanas[0].estado, 'programada', 'nothing is known, so nothing changes');

    // Next run: no ledger row appears, so it is filed as doubtful and dropped.
    conChasis(() => { throw new Error('it must not be sent a second time'); });
    const segunda = contexto(pb);
    await run(segunda.ctx);
    const informe = pb.store.campanas[0].informe;
    assert.deepEqual(informe.en_vuelo, []);
    assert.deepEqual(informe.dudosos.map((d) => d.lead), [leadUno.id]);
    assert.equal(informe.enviados, 0);
  });

  it('adopts a send that did leave while the previous run was dying', async () => {
    const pb = fakePb(datosBase());
    pb.store.campanas[0].informe = { v: 1, en_vuelo: [{ lead: leadUno.id, desde: '2026-09-23T09:00:00.000Z' }] };
    pb.store.envios.push({ id: 'env9', lead: leadUno.id, plantilla: plantillaEmail.id, campana: '', estado: 'enviado', enviado_en: '2026-09-23 09:00:30.000Z', created: '2026-09-23 09:00:30.000Z' });
    conChasis(() => { throw new Error('an adopted send must not be sent again'); });
    const { ctx } = contexto(pb);
    await run(ctx);
    assert.equal(pb.store.envios[0].campana, campanaBase.id);
    assert.equal(pb.store.campanas[0].informe.enviados, 1);
    assert.deepEqual(pb.store.campanas[0].informe.dudosos, []);
  });
});

describe('what stops a campaign, and stops it loudly', () => {
  it('refuses to send without chassis credentials, and changes no state', async () => {
    conChasis(() => { throw new Error('there is nothing to call'); });
    const pb = fakePb(datosBase());
    const { ctx, mensajes } = contexto(pb, { env: {} });
    await run(ctx);
    assert.equal(llamadas.length, 0);
    assert.equal(pb.store.campanas[0].estado, 'programada');
    assert.equal(pb.store.campanas[0].informe.bloqueo.code, 'sin_chasis');
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0], /Campaña bloqueada/);
  });

  it('refuses a segment it cannot parse instead of writing to everybody', async () => {
    conChasis(() => { throw new Error('nothing may be sent'); });
    const pb = fakePb(datosBase());
    pb.store.campanas[0].segmento = { v: 1, consentimento: false };
    const { ctx } = contexto(pb);
    await run(ctx);
    assert.equal(llamadas.length, 0);
    assert.equal(pb.store.campanas[0].informe.bloqueo.code, 'segmento_invalido');
    assert.equal(pb.store.campanas[0].estado, 'programada');
  });

  it('blocks a WhatsApp campaign whose template Meta has not approved', async () => {
    conChasis(() => { throw new Error('every recipient would be refused'); });
    const pb = fakePb(datosBase());
    pb.store.campanas[0].plantilla = plantillaWhatsapp.id;
    pb.store.campanas[0].segmento = { v: 1, incluye_ids: [leadUno.id], max: 1, variables: { agencia: 'Inmobiliaria' } };
    const { ctx } = contexto(pb);
    await run(ctx);
    assert.equal(llamadas.length, 0);
    assert.equal(pb.store.campanas[0].informe.bloqueo.code, 'template_not_approved');
  });

  it('blocks the whole run on a missing variable rather than burning the batch', async () => {
    conChasis(() => { throw new Error('a body with a literal placeholder must never leave'); });
    const pb = fakePb(datosBase());
    delete pb.store.campanas[0].segmento.variables.municipio;
    const { ctx, mensajes } = contexto(pb);
    await run(ctx);
    assert.equal(llamadas.length, 0);
    assert.equal(pb.store.campanas[0].informe.bloqueo.code, 'variables_missing');
    assert.ok(pb.store.campanas[0].informe.bloqueo.faltan.includes('municipio'));
    assert.equal(pb.store.campanas[0].estado, 'programada');
    assert.match(mensajes[0], /municipio/);
  });

  it('says a blockage once a day, not once an hour', async () => {
    conChasis(() => { throw new Error('nothing to send'); });
    const pb = fakePb(datosBase());
    const primera = contexto(pb, { env: {} });
    await run(primera.ctx);
    const segunda = contexto(pb, { env: {} });
    await run(segunda.ctx);
    assert.equal(primera.mensajes.length, 1);
    assert.equal(segunda.mensajes.length, 0, 'the same blockage, the same day, is said once');
  });

  it('pauses after three runs that sent nothing, and says how to resume', async () => {
    conChasis(() => { throw new Error('outside the window there is nothing to call'); });
    const pb = fakePb(datosBase());
    pb.store.campanas[0].hora_desde = '02:00';
    pb.store.campanas[0].hora_hasta = '03:00'; // never now
    let mensajes = [];
    for (let i = 0; i < 3; i++) {
      const c = contexto(pb);
      await run(c.ctx);
      mensajes = c.mensajes;
    }
    assert.equal(pb.store.campanas[0].estado, 'pausada');
    assert.match(mensajes[0], /Campaña pausada/);
    assert.match(mensajes[0], /en_curso/);
  });

  it('never touches a campaign a human parked, finished or cancelled', async () => {
    conChasis(() => { throw new Error('nothing may be sent'); });
    for (const estado of ['pausada', 'completada', 'cancelada']) {
      const pb = fakePb(datosBase());
      pb.store.campanas[0].estado = estado;
      const { ctx } = contexto(pb);
      await run(ctx);
      assert.deepEqual(pb.escrituras, [], `a ${estado} campaign must be left alone`);
    }
  });
});

describe('arming a draft', () => {
  it('previews reach and names the blocker, and sends nothing', async () => {
    conChasis(() => { throw new Error('arming never sends'); });
    const pb = fakePb(datosBase());
    pb.store.campanas[0].estado = 'borrador';
    pb.store.campanas[0].plantilla = plantillaWhatsapp.id;
    pb.store.campanas[0].segmento = { v: 1, variables: { agencia: 'Inmobiliaria' } };
    pb.store.leads.push({ ...leadUno, id: 'lead000000002', telefono: '' });
    const { ctx, eventos, mensajes } = contexto(pb);
    await run(ctx);

    assert.equal(llamadas.length, 0);
    const informe = pb.store.campanas[0].informe;
    assert.equal(informe.destinatarios_estimados, 1);
    assert.deepEqual(informe.alcance_estimado, { coincidentes: 2, alcanzables: 1, sin_contacto: 1 });
    assert.equal(informe.bloqueo.code, 'template_not_approved');
    assert.equal(pb.store.campanas[0].estado, 'borrador', 'arming never starts a campaign');
    assert.equal(eventos[0].type, 'campana.armada');
    assert.match(mensajes[0], /Campaña preparada/);
    assert.match(mensajes[0], /alcanzables 1 · sin teléfono 1/);
  });

  it('arms once: a second run leaves the draft alone', async () => {
    conChasis(() => { throw new Error('arming never sends'); });
    const pb = fakePb(datosBase());
    pb.store.campanas[0].estado = 'borrador';
    const primera = contexto(pb);
    await run(primera.ctx);
    const escritas = pb.escrituras.length;
    const segunda = contexto(pb);
    await run(segunda.ctx);
    assert.equal(pb.escrituras.length, escritas);
    assert.equal(segunda.mensajes.length, 0);
  });
});
