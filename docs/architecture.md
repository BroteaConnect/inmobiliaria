# Sistema inmobiliario — arquitectura

Dos apps de la fábrica Brotea + un PocketBase compartido. Este repo
(`inmobiliaria`) es el **proyecto de referencia**: aquí viven el modelo de
datos, el seed y la documentación; el CRM vive en
`BroteaConnect/inmobiliaria-crm`.

## Piezas

| Pieza | Qué es | Dónde |
|---|---|---|
| Escaparate | Catálogo público bilingüe (es en `/`, en en `/en/`) + captura de leads (astro, este repo) | https://inmobiliaria.brotea.dev |
| CRM | Panel privado: kanban de leads, propiedades, import CSV (react) | https://crm-inmobiliaria.brotea.dev |
| Backend | PocketBase compartido (datos, fotos, auth, realtime) | https://pb-inmobiliaria.brotea.dev |
| Modelo de datos | `pb/schema.json` (declarativo, aditivo) | este repo |
| Seed demo | `pb/seed.mjs` | este repo |

La capa de UI del escaparate (nav responsive, contrato `brotea:nav`,
convenciones de pulido) está documentada en [docs/frontend-ui.md](frontend-ui.md);
su identidad visual (paleta, escala tipográfica, el apunte de visita y el
contrato de cascada `theme.css` → `identity.css`) en
[docs/visual-identity.md](visual-identity.md).
El escaparate es bilingüe es/en sobre el contrato i18n de la fábrica
(rutas `[...lang]`, `t()`, `LanguageSwitcher`, gate de CI) — ver
[docs/i18n.md](i18n.md); los datos de las propiedades (titulo,
descripcion…) no se traducen. Los jobs programados (agenda 09:00 +
resumen 20:00 por Telegram) en [docs/jobs.md](jobs.md).

## Flujos clave

- **Lead entra**: formulario del escaparate → `create('leads')` en PocketBase
  (regla `create` pública) **y** POST a `api.brotea.dev/requirements`
  (chasis) → aviso al topic de Telegram del proyecto. El CRM lo ve aparecer
  en tiempo real (suscripción SSE a `leads`).
- **Propiedad se publica**: en el CRM, `estado = "publicada"` → visible en el
  catálogo al instante (el escaparate lee client-side con el filtro
  `estado="publicada"`; no hay rebuild).
- **Fotos**: campo `fotos` de `propiedades` (files, thumbs 600x400 servidos
  por PocketBase con `?thumb=`).

## Reglas de acceso (resumen)

- `propiedades`: lectura pública SOLO si `estado="publicada"`; todo lo demás
  requiere sesión (la intermediaria, colección `users`).
- `leads`: `create` público (el formulario), el resto con sesión.
- `propietarios`/`actividades`/`settings`: todo con sesión. `settings` nunca es
  pública: el mapa de módulos de un CRM privado no es información pública.
- `plantillas`/`campanas`/`visitas`/`envios` (E1, 2026-09-07): every action
  requires a session, except `envios.delete`, which nobody can do from the
  browser — see [Data model](#data-model-e1-2026-09-07) below.

## Cómo se actualiza (usa las skills de .claude/skills/)

- Modelo de datos → skill `pb-schema` (editar `pb/schema.json` y aplicar).
- Datos de demo → skill `demo-data`.
- Jobs programados → skill `jobs` (añadir/modificar `jobs/*.mjs`).
- Código → PR normal de la fábrica: CI verde → auto-merge → deploy.
- El tema base es `brotea@2.0.0` (lockfile `brotea.json`, `src/styles/theme.css`
  generado). La identidad de la clienta la sobrescribe
  `src/styles/identity.css`, que se importa después → regenerar el tema es
  inocuo. Nunca editar `theme.css` a mano
  ([docs/visual-identity.md](visual-identity.md)).

## Seguimiento de contactos (2026-07-29)

- Toda interacción con un lead pasa por `registrarContacto()` (CRM api.ts):
  crea una `actividad` (canal, dirección, nota) y sella
  `leads.ultimo_contacto`. La tarjeta muestra "hace X días", marca en ámbar
  los leads sin contacto >2 días (`desatendido()`) y despliega el historial.
- **Email real con seguimiento**: el CRM llama a `POST
  api.brotea.dev/send-email` (secreto compartido en `PUBLIC_OUTBOUND_SECRET`);
  el chasis envía por Brevo con un Message-ID propio, registra la actividad y
  Brevo devuelve los eventos a `POST /brevo-webhook`, que actualiza
  `estado_envio` (enviado→entregado→abierto→click, sin degradar).
  Las credenciales SMTP nunca llegan al navegador.
- **Límite honesto de WhatsApp**: se registra que la agente inició el
  contacto (el click), no la entrega ni la respuesta. Eso exige la WhatsApp
  Business Cloud API (fase 2: cuenta Meta verificada + plantillas).

## Configuration and mock adapters (2026-08-15)

Written in English: the factory produces English prose, and this section is new.
The rest of this document predates that rule and is left as it is.

The CRM grows one module at a time, and a module usually needs a service the
project cannot pay for yet — a WhatsApp Business account, an LLM, a maps key.
Two pieces make that survivable, and they meet in the `settings` collection.

**`settings` is the switchboard.** One row per `key`, `value` a versioned JSON
blob:

```
modules.<id>       -> { "v": 1, "enabled": true }
integrations.<id>  -> { "v": 1, "adapter": "mock" | "live", "config": { ... } }
```

The format declares no indexes, so uniqueness of `key` is not expressible in
`pb/schema.json`. The CRM's data layer enforces it instead: read by
`filter: key="…"`, update if found, create if not. Defaults live in the CRM's
code, so a missing row — or a schema not applied yet — resolves to the default
rather than to a blank screen, the same defensive posture as `t()` on a missing
key.

**No secrets in `settings`.** Every signed-in user can read the collection and
the browser bundle is public. Credentials keep following the precedent of
`enviarEmail`: the secret lives in the chassis and the browser only holds
`PUBLIC_OUTBOUND_SECRET`. `settings` records *which* adapter is selected, never
how to authenticate it.

**A mock must say it is a mock.** Each integration is a port with a `mock` and a
`live` adapter (`live` may be `null` — not built yet, and the Configuration
screen lists it as unavailable instead of offering a toggle that lies). Every
mock receipt carries `simulated: true`, the UI shows a translated marker, and a
simulated send writes `estado_envio: "simulado"` — a value added to
`actividades` for exactly this reason. Writing `enviado` would tell the agent a
message left that never left, and the digest job counts delivery states. The
counters in `jobs/lib.mjs` only add up `entregado|abierto|click`, so `simulado`
cannot inflate them. This is the same honesty the WhatsApp and email-open limits
above are written down for.

## Data model (E1, 2026-09-07)

`pb/schema.json` is the source of truth and is applied from the factory root:

```bash
node scripts/pb-schema.mjs inmobiliaria pb/schema.json
```

The apply is additive and idempotent: it never drops a field, and a second run
prints only `=` lines and ends with `SCHEMA OK`. Collections are declared in
dependency order — `users → propietarios → propiedades → leads → plantillas →
campanas → actividades → visitas → envios → settings` — so every relation
targets a collection that already exists. Every collection carries `created`
and `updated` autodate fields. `users` is untouched by E1.

Access is declared as intent (`signed-in`, `public`, `nobody`, or a `raw`
rule) and compiled by `scripts/lib/access.mjs`. Unless stated otherwise below,
all five actions (`list`, `view`, `create`, `update`, `delete`) are
`signed-in`.

### Fields added to existing collections

| Collection | Field | Type | Notes |
|---|---|---|---|
| `leads` | `asignado` | relation → `users` (max 1) | the agent who owns the lead; empty = unassigned |
| `leads` | `canal_preferido` | select `email` \| `whatsapp` | the lead's preferred delivery channel |
| `leads` | `idioma` | select `es` \| `en` | the language the lead is written to in |
| `propietarios` | `consentimiento` | bool | marketing consent |
| `propietarios` | `consentimiento_en` | date | when the consent was recorded |
| `actividades` | `campana` | relation → `campanas` (max 1) | set when a campaign, not a person, generated the activity |

```bash
curl -X PATCH "$PB/api/collections/leads/records/$ID" \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"asignado": "'$USER_ID'", "canal_preferido": "whatsapp", "idioma": "en"}'
```

### `plantillas` — message templates

One row per `clave` and channel, written in both app languages.

| Field | Type | Notes |
|---|---|---|
| `clave` | text, required, max 80, pattern `^[a-z0-9_.]+$` | stable key; uniqueness is enforced by the CRM (read before write), not by the schema |
| `nombre` | text, required | |
| `canal` | select `email` \| `whatsapp` | |
| `categoria` | select `utility` \| `marketing` | |
| `asunto_es`, `asunto_en` | text, max 200 | subject per language |
| `cuerpo_es`, `cuerpo_en` | text, required | body per language |
| `variables` | json | placeholder names the body uses |
| `evento` | text, max 80 | the lead lifecycle event this template is tied to |
| `estado` | select `borrador` \| `aprobada` \| `retirada` | lifecycle inside the CRM |
| `version` | number, int ≥ 1 | recorded in `envios.plantilla_version` at send time |
| `content_sid` | text, max 40 | Twilio Content API id (WhatsApp) |
| `content_estado` | select `unsubmitted` \| `received` \| `pending` \| `approved` \| `rejected` \| `paused` \| `disabled` | Twilio's approval status, stored verbatim |
| `content_motivo` | text | Twilio's rejection reason |

### `campanas` — outbound campaigns

One template sent to a segment of leads.

| Field | Type | Notes |
|---|---|---|
| `nombre` | text, required | |
| `plantilla` | relation → `plantillas` (max 1) | |
| `segmento` | json | lead filter: `{etapa[], consentimiento, origen[], idioma, canal_preferido, asignado}` |
| `lote_diario` | number, int ≥ 1 | sends per day |
| `intervalo_min` | number, int ≥ 0 | minutes between sends |
| `hora_desde`, `hora_hasta` | text, pattern `HH:MM` (24 h) | sending window |
| `inicio` | date | |
| `estado` | select `borrador` \| `programada` \| `en_curso` \| `pausada` \| `completada` \| `cancelada` | |
| `ultimo_envio_en` | date | |
| `informe` | json | delivery counts |

### `visitas` — property visits

A lead, a property and the agent who shows it, at a given time.

| Field | Type | Notes |
|---|---|---|
| `lead` | relation → `leads` (max 1) | no cascade delete: the visit outlives its lead |
| `propiedad` | relation → `propiedades` (max 1) | |
| `agente` | relation → `users` (max 1) | |
| `cuando` | date, required | |
| `resultado` | select `pendiente` \| `confirmada` \| `realizada` \| `no_show` \| `cancelada` \| `reprogramada` | |
| `notas` | text | |

```bash
curl -X POST "$PB/api/collections/visitas/records" \
  -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"lead": "'$LEAD_ID'", "propiedad": "'$PROP_ID'", "agente": "'$USER_ID'",
       "cuando": "2026-09-12 10:30:00", "resultado": "pendiente"}'
```

### `envios` — delivery ledger

One row per message sent to a lead, by a campaign or by hand. **`delete` is
`nobody`**: delivery evidence cannot be erased from the browser, only by a
superuser. No cascade delete from `leads`.

| Field | Type | Notes |
|---|---|---|
| `lead` | relation → `leads` (max 1) | |
| `campana` | relation → `campanas` (max 1) | empty for manual sends |
| `plantilla` | relation → `plantillas` (max 1) | |
| `plantilla_version` | number | the template version actually sent |
| `actividad` | relation → `actividades` (max 1) | the activity the agent sees |
| `canal` | select `email` \| `whatsapp` | |
| `mensaje_id` | text | provider message id |
| `estado` | select `registrado` \| `enviado` \| `entregado` \| `abierto` \| `click` \| `error` \| `simulado` | same union as `actividades.estado_envio` |
| `variables` | json | values the placeholders were rendered with |
| `enviado_en`, `entregado_en`, `abierto_en`, `click_en`, `error_en` | date | one timestamp per state reached |
| `error_codigo` | text, max 40 | |
| `error_texto` | text | |

### What exists today

E1 ships the data model only. There is no campaign runner, no lead/property
matcher and no visit booking in code yet; the rows above are written and read
by hand (PocketBase admin or API) until the screens and jobs that use them are
merged.

## Deuda consciente / siguiente iteración

- **Seguimiento de email: la entrega es fiable, la apertura no** (cerrado
  2026-07-30). Verificado de punta a punta: webhook transaccional de Brevo →
  evento `delivered` → estado "entregado" en la actividad, en segundos.
  Las aperturas dependen de que el cliente de correo del destinatario cargue
  el píxel invisible: probado A/B/C (Message-ID propio vs por defecto, HTML
  vs solo texto) — ninguna variante registró apertura hoy, y una idéntica sí
  la registró ayer con el mismo relay y destinatario. Es la limitación
  inherente del mecanismo (Gmail decide si carga imágenes; Apple Mail
  Privacy Protection lo rompe casi siempre), no un defecto del sistema.
  Diagnóstico posible en cualquier momento con la API de Brevo
  (BREVO_API_KEY en el almacén de credenciales; requiere que la IP del
  servidor esté en su lista de IPs autorizadas) y con los
  `email.event_received` de la tabla events. **Consecuencia de producto:**
  la UI solo afirma lo que ocurrió (entregado / abierto ✓); nunca interpretar
  la ausencia de "abierto" como "no lo ha leído".
- Motor de seguimiento (jobs mergeados 2026-07-30): agenda de leads
  desatendidos a las 09:00 y resumen del día a las 20:00 por Telegram — ver
  [docs/jobs.md](jobs.md). **Dormidos hasta que el chasis construya su
  runner genérico** (`scripts/run-jobs.mjs`, ámbito plataforma). Queda el
  matching lead↔propiedad para una fase posterior.
- Import: CSV (el Excel se guarda como CSV); parser xlsx nativo si molesta.
- WhatsApp saliente: enlaces `wa.me` prellenados en el CRM (API de WhatsApp
  Business en fase 2).
