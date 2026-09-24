# Jobs programados — recordatorios y resumen diario

Los `jobs/*.mjs` de este repo son la mitad *proactiva* del seguimiento.
Cada módulo expone el contrato que el runner genérico del chasis consumirá:

```js
export const when = { daily: '09:00' }; // hora LOCAL de Madrid, HH:MM

export async function run(ctx) { ... }
// ctx = { pb, notify, event, log, now, slug }
//   pb          cliente PocketBase ya autenticado
//   notify(txt) mensaje HTML al topic de Telegram del proyecto (en español)
//   event(t, p) fila en la tabla events de la plataforma (payload jsonb)
//   log(msg)    stdout · now: Date del arranque · slug: del proyecto
```

**Estado actual (2026-07-30)**: en marcha. El runner del chasis
(`scripts/run-jobs.mjs`, ámbito plataforma) corre con un cron horario, descubre
estos jobs en el checkout de `main` y decide cuál toca por su `when`. Aquí solo
viven las **reglas de producto**; la infraestructura (auth, scheduling, cron,
aislamiento de fallos, reintentos) es del chasis y no se copia.

## Qué se envía y cuándo (hora de Madrid)

| Job | Hora | Mensaje al topic de Telegram |
|---|---|---|
| `jobs/agenda.mjs` | 09:00 | Leads con más de **48 h** sin contacto, el más abandonado primero. `⚠️` a partir de 5 días. Máximo 10 líneas + "… y N más". |
| `jobs/resumen.mjs` | 20:00 | Resumen del día: leads nuevos, importados a la cartera, contactos salientes por canal, mensajes entrantes, emails entregados y propiedades publicadas. |
| `jobs/campanas.mjs` | hourly | Only when a campaign pauses or completes (see [campanas](#campanas)). |
| `jobs/matcher.mjs` | 09:30 | Shortlist de leads que encajan con cada propiedad publicada o tocada en las últimas 24 h (ver [matcher](#matcher)). |
| `jobs/unanswered.mjs` | hourly | A lead whose WhatsApp/email has waited more than **2 h** with no outbound row, once per unanswered streak, 09:00–21:00 only (see [unanswered](#unanswered)). |
| `jobs/weekly-summary.mjs` | Fri 18:00 | The business summary of the week, never silent (see [weekly-summary](#weekly-summary)). |
| `jobs/reactivation.mjs` | Mon 10:00 | A **proposal**: dormant leads that fit the published stock, for an agent to call. Nothing is sent to the leads (see [reactivation](#reactivation)). |
| `jobs/owner-report.mjs` | 10:00, first weekday of the month (days 1–7) | **Drafts** of the monthly owner report for the previous month, for review. Nothing is sent to owners (see [owner-report](#owner-report)). |

**El silencio es una feature**: si no hay leads desatendidos o el día está
vacío, no se envía nada. Un canal que solo habla cuando hay algo que decir
no se silencia.

## Las reglas (viven en `jobs/lib.mjs`, con tests)

- Reloj de abandono: `ultimo_contacto || created` — un lead nuevo que nadie
  ha tocado nunca es el caso más urgente y aparece por el fallback.
- Etapas excluidas: `nutriendo` (aparcado a propósito) y `vendido` (no hay
  nada que perseguir) — las mismas que `desatendido()` en el CRM.
- Umbrales: 48 h para entrar en la agenda (`STALE_HOURS`), 5 días para el
  `⚠️` (`ALERT_DAYS`), 10 líneas de tope (`MAX_LINES`) y nombres truncados a
  80 caracteres (`MAX_NOMBRE`: vienen de un formulario público y un nombre
  sin límite podría pasar de los 4096 caracteres de Telegram y matar el
  mensaje). Cambiarlos es editar las constantes de `lib.mjs` en un PR.
- Fechas vacías: las filas creadas **antes** de declarar los `autodate` en
  `pb/schema.json` conservan `created`/`updated` a `""` para siempre (el
  autodate solo sella al escribir). Los datos reales las tienen, así que toda
  fecha se parsea a la defensiva: un día desconocido no es "hoy" y no rompe el
  resumen, y un lead sin fecha usable encabeza la agenda con `⚠️` y "sin fecha
  registrada" — es el caso más abandonado, no uno que ocultar.
- Un **import no es generación de leads**: las filas con `origen: 'histórico'`
  (las que mete el importador CSV del CRM) se cuentan aparte, en "importados a
  la cartera". Si no, el día que entró el Excel real el resumen habría cantado
  "220 leads nuevos" cuando fueron 4.
- Contadores del resumen: las `nota` no cuentan como contacto saliente;
  «emails entregados» son actividades email con `estado_envio` en
  entregado/abierto/click; «propiedades publicadas» son las que están en
  estado `publicada` y se tocaron hoy (`updated`) — un proxy: no existe log
  de cambios de estado.
- El "día" es siempre el día local de **Europe/Madrid**, calculado con
  `Intl.DateTimeFormat` — nunca sumando offsets fijos (el DST desplazaría
  la agenda una hora dos veces al año).

## matcher

`jobs/matcher.mjs` runs at 09:30 Madrid and answers, for every published
property, "which open leads fit this?". The CRM stores no structured wish —
`leads.criterios` is free text (the CSV importer writes
`Compró en <master project> · <edificio> · unidad N · ~<precio> · …`, the web
form writes whatever the visitor typed) and `mensaje` is prose — so the wish is
**derived** per lead at run time and never written back:

- **zona**: every zone of the vocabulary (see below) found as a whole token
  in `criterios + mensaje`, plus the zones of the property the lead asked
  about (`leads.propiedad`). Normalisation is lowercase, accents stripped,
  spaces collapsed: `Chamberí` and `chamberi` are one town; `madrid` is not
  found in `madridejos`, nor `lakes towers` in `jumeirah lakes towers`, nor
  `marina gate 1` in `marina gate 12`.
- **precio_max**: the first amount in the text (`~1200000`, `550k`, `1.2m`,
  `1,200,000`, `hasta 300.000`, `presupuesto 550k`). A bare number is not an
  amount (`unidad 1413` is a flat, `29/12/2022` a date, `120 m2` a surface).
  `null` when there is none.
- **habitaciones**: `4 habitaciones` / `3 hab` / `2 bedrooms` / `3br`; `null`
  when absent.

The zone vocabulary (`vocabularioZonas()`, 2026-09-23): a property names up
to three zones — `municipio` (the Dubai export's Master Project), `proyecto`
and `edificio` (its building) — and, for a row imported before `edificio`
existed, the segments of its `zona · edificio · unidad N` title minus the
unit (the `unidad` segment is the proof the importer wrote the title; a
hand-typed `Ático · 2 hab · terraza` stays prose). `zonasDePropiedad()`
normalises them and drops what is not a zone (`esZonaValida()`: under 3
chars, only symbols like `-`/`—`, numeric, or a placeholder word of
`JUNK_ZONA` — `N/A`, `Master Project`, `Building Name`, `none`…). Built
from *all* properties, published or not. The same list and rules live in the
CRM importer (`src/crm/import-mapping.ts`, which now stores `edificio` and
`proyecto` on import); the two test files pin the same vectors. Without the
junk rule, every historical lead whose `criterios` read `Compró en - · …`
was a candidate for every property whose `municipio` was `-`. The old
`vocabularioMunicipios()` stays exported but the matcher no longer uses it.

Scoring (`candidatos()` in `jobs/lib.mjs`): the zone is the only hard rule —
a lead who never named one of the property's zones (town, master project or
building), nor asked about a listing there, is not a candidate no matter the
budget. Zone written in the text +3, zone known only
from the linked listing +2, budget unknown or `precio <= precio_max × 1.15`
+1, rooms unknown or `habitaciones >= wanted` +1. Only `vendido` leads are
excluded (`nutriendo` stays: a parked lead is exactly who a new listing might
wake up). Best score first.

What it says: the log gets one line per published property, always —
`matcher: <n> candidate(s) for <propiedad id>` — which is what the E4 gate
reads. Telegram only hears about a property `updated` in the last 30 h (the
daily cadence plus the runner's 6 h grace) with at least one candidate: one message per property, `• <b>lead</b> · agent ·
reasons`, the agent being the lead's `asignado`, else the on-duty agent
(settings row `agentes.guardia` = `{ v: 1, text: <users id> }`, resolved to
its name), else "sin asignar"; capped at 10 lines + "… y N más", every name
cut to 80 chars and HTML-escaped, and the same CRM footer as the agenda. The
platform event `matcher.shortlist` `{ propiedad_id, candidates, lead_ids
(top 10) }` is written **before** `notify()`. One broken row is logged and
skipped so the other properties still get their line, but the run then fails
with `<k> of <n> properties failed: <ids>` — a broken send or insert reaches
Alertas instead of hiding behind a green run. On success it returns
`<n> properties scored, <m> shortlist(s)`.

Honest limits of "touched in the last 30 h": the jobs are stateless and see
no event history, so a run delayed into the grace window may repeat
yesterday's shortlist once, and any edit of a published property (a photo, a
price) re-sends its shortlist the next morning — that is the "touched"
semantics the team asked for, not a bug. De-duplicating against the
`matcher.shortlist` events would need the runner to expose them to `ctx`.

Where the live data stands (2026-09-23): the 216 historical leads carry no
price and no `municipio` — the importer's `criterios` names the Dubai
building the buyer bought in (`Seven City JLT`, `MBL Royal`…). Since the zone
vocabulary reads buildings, a lead matches the moment a property of that
building is published with its `edificio` set (or a legacy title naming it);
the demo web lead still matches through the Madrid property it asked about.
The unpublished property whose `municipio` is the literal `Master Project`
(a column header that leaked through the import) no longer reaches the
vocabulary: `esZonaValida()` drops it. Correcting the row is still the right
data fix.

Out of scope until E5: the WhatsApp half of the flow — asking the lead
"¿te encaja?" and turning a "sí" into `propiedad.encaja` on the lead. A
business-initiated WhatsApp message needs a Twilio Content template (or the
lead's own 24-hour window, which a lead who wrote weeks ago no longer has);
that template is E5's deliverable, and the matcher will call it from there.

## unanswered

`jobs/unanswered.mjs` (hourly; rules in `jobs/unanswered.lib.mjs`) reads the
last 48 h of `actividades` and, per lead, oldest first: an outbound row of
**any** tipo (a `nota` typed as `saliente` included) closes the streak — except
a failed send (`estado_envio = 'error'`, what the WhatsApp agent writes when
Twilio refuses), which reached nobody — and
the first inbound `whatsapp`/`email` after it opens the next one. That first
inbound is the **anchor**: one alert per unanswered streak, however many
messages the lead sends while waiting. An anchor between 2 h and 24 h old is
alerted; an older one is the 09:00 agenda's job. An inbound `llamada` opens
no streak (a lead does not call in through the CRM). No stage or consent
exclusion; the lead in job secret `CAMPAIGN_REPORT_LEAD_ID` (the manager) is
never alerted.

The 48 h re-anchor (a known limit, chosen over one extra query per lead every
hour): the job does not look up each lead's last outbound, it reads 48 h. A
lead nobody answered for more than 48 h has their old inbound out of view, so
the next message they send becomes a new anchor and is alerted again — a
second reminder every two days for a lead who keeps writing into the void.

- Log line, always (the E6 gate reads it): `unanswered: <n> lead(s) waiting over 2h`.
- Quiet hours: alerts go out only 09:00–21:00 Madrid. Outside, the job logs
  `unanswered: holding <k> alert(s) until 09:00` and writes nothing; the
  first run after 09:00 sends them.
- Order: **the Telegram message first** (lead first name, channel, wait,
  assigned agent → on-duty agent → "sin asignar"), then the marker, then one
  `lead.unanswered_alert` `{lead_id, activity_id, waited_min}` event per
  alerted lead. Deliberately the reverse of the other jobs: the events are the
  E6 gate's proof that an alert went out, so they only exist after a
  successful send, and a lost alert is worse than a duplicate one.
- Names in every E6 message go through `safeName()` (`pb-helpers.lib.mjs`):
  an email address or a phone-shaped digit run never reaches the topic — the
  on-duty agent's `users.name` is their login address today.
- Marker: settings row `jobs.unanswered` = `{v: 1, alerted: {<activity id>:
  <ISO>}}`, pruned to 7 days — the anchors already alerted. Under
  `--dry-run` it is not written (the job logs `dry-run: would write
  jobs.unanswered`).

## weekly-summary

`jobs/weekly-summary.mjs` (Fridays 18:00, `when = { daily: '18:00', dow: [5]
}`; rules in `jobs/weekly-summary.lib.mjs`) covers Friday 18:00 → Friday
18:00 on the Madrid wall clock — seven local days, 167 or 169 hours on a DST
week. A run before Friday 18:00 (a forced rehearsal) reports the last complete
week. `semana` is the ISO week of the closing Friday (`2026-W39`).

- Counts: `leads_nuevos` (created in the week, `histórico` excluded — those
  are `importados`), `por_origen` (empty → `sin origen`, keys cut to 40;
  `cartel` is one more origin; the top 6 plus an `otros` count, in the event
  and the text alike), `contactos` / `contactos_por_canal` (outbound rows,
  notes and failed sends excluded), `entrantes`, `visitas` (held: `cuando` in the week
  and `realizada`), `visitas_agendadas` (booked in the week, not cancelled),
  `visitas_no_show`, `publicadas` (published and touched in the week — a
  proxy), `envios` `{total, por_estado}` (null when the ledger could not be
  read), `sin_respuesta` (the unanswered rule, now) and `embudo` (leads per
  stage **today**).
- **No stage history**: the CRM keeps only a lead's current `etapa`, so the
  summary cannot say "3 leads moved to oferta this week"; the funnel is a
  snapshot. A stage-move metric needs a stage-change log first.
- Log line, always: `weekly-summary: <n> new lead(s) this week`; then the
  `project.weekly_summary` `{semana, desde, hasta, …counts}` event, then the
  message. A quiet week is said (`Semana sin movimiento…`), never skipped.
  It writes nothing to PocketBase.

## reactivation

`jobs/reactivation.mjs` (Mondays 10:00; rules in `jobs/reactivation.lib.mjs`)
proposes, to the team only, which dormant leads fit the stock published
today. It never sends to a lead, never calls the chassis, never writes to
PocketBase and never emits `reactivation.sent` — decision 3 of the estate
build-out: no message to real leads before CU-15 has run and the owner said
yes.

- Dormant: `etapa` not in `oferta`/`reservado`/`vendido`, and no contact
  (`ultimo_contacto || created`) for more than 30 days — an unknown date is
  dormant. A lead with **any** `actividades` row in the last 30 days (an
  inbound message included — `ultimo_contacto` is not stamped on inbound) is
  not dormant. A revoked consent (`consentimiento` false with a
  `consentimiento_en`) is out; a never-given one stays, marked 🚫 (a call
  needs no marketing consent).
- Fit: the matcher's `candidatos()` over the **published** properties (zone
  vocabulary from all of them). Per lead: the best property, how many more
  fit (`(+k)`) and the reasons. Best score first, then longest silence;
  10 lines + "… y N más". Lead first name only.
- Log line, always: `reactivation: <n> dormant lead(s) fit published stock`.
  With n > 0: `reactivation.proposed` `{leads, properties, with_consent}`,
  then the message. With n = 0: nothing else.

## owner-report

`jobs/owner-report.mjs` (daily 10:00; rules in `jobs/owner-report.lib.mjs`)
acts on the first Madrid weekday within the first 7 days of the month, once
per month, and drafts the report of the **previous** month: one draft per
(owner, published property), rendered from the live `plantillas` row
`propietario.informe` (`cuerpo_es`, with `render()` from `campanas.lib.mjs`).
Nothing is sent to an owner — no chassis call, no `owner_report.sent` —
until Meta approves the template and the jobs hold their chassis secret.

- Per draft: `contactos` (leads whose `propiedad` is the property, created in
  the month, `histórico` excluded), `visitas` (held in the month), plus
  `visitas_agendadas`, `visitas_no_show` and `actividad` for the agent's
  eyes; `agente` = the on-duty agent, else "el equipo"; `mes` in Spanish;
  owner first name only; title cut to 60. A draft is flagged `no enviable:
  sin teléfono` / `sin consentimiento` when it could not be sent anyway.
- Missing template: the variables are shown instead; the job does not fail.
- Log line: `owner-report: <n> draft(s) for <YYYY-MM>`. With drafts: the
  `owner_report.drafted` `{count, month, owners, not_sendable}` event, then
  every message (split under 3900 chars, never inside a draft), then the
  marker — a send that fails half-way leaves the month unmarked, to be
  drafted again. With none: only the marker.
- Marker: settings row `jobs.owner_report` = `{v: 1, last_month: 'YYYY-MM'}`.
  Under `--dry-run` the calendar/marker verdict is logged but bypassed (a
  rehearsal always shows drafts) and the marker is not written.

## State the jobs keep (settings rows)

| Key | Value | Written by |
|---|---|---|
| `jobs.unanswered` | `{v: 1, alerted: {<actividades id>: <ISO>}}`, 7 days | `unanswered` |
| `jobs.owner_report` | `{v: 1, last_month: 'YYYY-MM'}` | `owner-report` |

Both are written only outside `--dry-run`, and only after the job's
Telegram message(s). A missing row reads as "no marker yet"; a row that
cannot be **read** (any error but a 404) fails the run, so the runner retries
instead of re-alerting every streak or re-sending the month's drafts.
Deleting a row is safe: `unanswered` may repeat an alert for a streak still
open, `owner-report` may draft the month again.

Every E6 message passes through `fitTelegram()` (`lib.mjs`): over 4000 chars
it becomes its first line, a note and the CRM footer, never a failed send.

## campanas

`jobs/campanas.mjs` (hourly, I/O only) advances every `campanas` row in
`programada` or `en_curso` by at most one batch; the rules live in
`jobs/campanas.lib.mjs` and the refusal taxonomy in `jobs/refusals.lib.mjs`
(the `.lib.mjs` suffix keeps the scheduler from running them as jobs).

- **Estados.** `borrador` is armed and never touched; a human moves it to
  `programada` (PocketBase Admin today). The job moves `programada → en_curso`
  (recipients frozen into `informe.recipients`), `en_curso → pausada` and
  `en_curso → completada`. Only a human resumes a `pausada`.
- **Segment v1** (`segmento`): `{v: 1, ids?, etapa?, origen?, consentimiento?,
  idioma?, canal_preferido?, asignado?}`, ANDed. An unknown key, a wrong type,
  a missing `v` or no criterion pauses the campaign — never "everybody".
- **Guards**, before any write, and a refused guard writes nothing and emits
  no `campana.*` event: a row named `CU-15` needs job secrets
  `CU15_OWNER_YES=<its id>` and `CAMPAIGN_SENDER_READY=1`; without
  `CAMPAIGN_SENDER_READY` the only allowed recipients are `TEST_LEAD_IDS`
  (a constant in `campanas.lib.mjs`: changing it is a PR); real recipients
  also need CU-15 `completada`.
- **Cadence.** Inside `[hora_desde, hora_hasta)` Madrid time, from `inicio`,
  at most `min(10, lote_diario left today, intervalo_min credits)` per tick.
- **Refusals.** Every chassis answer is classified by `refusals.lib.mjs`.
  Only a *recognised* per-lead code (STOP, no consent, no phone/email…)
  excludes a lead, from this campaign only. A provider number code before
  anything was sent may be our sender's fault: that lead is `deferred` behind
  every pending one, and three in a row with nothing sent pause the campaign
  (a resume starts the count again). A code about the run (auth,
  config, template) pauses. **Anything unrecognised is infrastructure**: the
  lead goes back to pending, and three such ticks in a row pause. An answer
  after which the message may have left (email 502/500, a proxy 500/502/504
  page, an unreadable 2xx, timeouts, `provider_unavailable`) is never
  retried: it is settled against `envios` on a later tick, or marked doubtful
  for a human. For email any ledger row means it left (a later bounce is
  doubtful, never retried); only WhatsApp error rows are classified by code.
- **Report.** `informe` v1 (`alcanzados` = distinct leads with an `envios`
  row in enviado/entregado/abierto/click, `intentados_ids`, `excluidos`,
  `revision_humana`, `completada_en`) is what the E5 gate recomputes.
  Completion writes `campana.completada` first, then the row, then Telegram;
  the manager's WhatsApp report goes to `CAMPAIGN_REPORT_LEAD_ID` when set.
- **Secrets** (`~/.config/brotea/jobs-inmobiliaria.env`): `CHASSIS_URL`,
  `OUTBOUND_SECRET`; flags `CAMPAIGN_SENDER_READY`, `CU15_OWNER_YES`,
  `CAMPAIGN_REPORT_LEAD_ID`. The secret goes in the query string, never a
  header, and is scrubbed from every log, event and error.
- **Seed.** `node pb/campanas.mjs [--dry-run]` creates `pb/campanas.json`
  rows by `nombre` and never patches one: CU-15 in `borrador`, and an email
  rehearsal to the test lead in `programada`.
- Every tick that pauses, refuses a guard or stops on a fault **throws**, so
  the runner records a failure and Alertas hears about it.

## Probar y dry-run

- Tests unitarios: `npm test` (ejecuta `node --test jobs/*.test.mjs
  src/locales/*.test.mjs` — los tests de jobs más el gate i18n del
  escaparate, ver [docs/i18n.md](i18n.md) — y después el build de Astro;
  CI corre exactamente eso).
- Dry-run contra datos reales, sin enviar nada (desde la raíz de la fábrica):
  `node scripts/run-jobs.mjs --slug inmobiliaria --dry-run --force`
  Añade `--jobs-dir <ruta>/jobs` para probar el código de un worktree **antes**
  de mergearlo (en producción el runner solo lee `main`).
- Qué toca ahora y por qué: `node scripts/run-jobs.mjs --list`.
- Los jobs son stateless y re-ejecutables: no escriben en PocketBase. Cada
  envío inserta su evento de plataforma — `lead.reminder_sent`
  (`{count, oldest}`) la agenda, `project.daily_digest` (los contadores) el
  resumen, `matcher.shortlist` (`{propiedad_id, candidates, lead_ids}`) el
  matcher — **antes** de `notify()`: si un reintento repite el job, duplica
  una fila inofensiva, no un mensaje de Telegram.
- Exception: `campanas` does write its own `campanas` row (never a lead), and
  under `--dry-run` every write and every chassis call is skipped and logged.
- Exceptions too: `unanswered` and `owner-report` write their own settings
  marker (see [State the jobs keep](#state-the-jobs-keep-settings-rows)),
  never under `--dry-run`. `project.weekly_summary`, `reactivation.proposed`
  and `owner_report.drafted` are written before `notify()`, like the others;
  `lead.unanswered_alert` is written **after** it (see
  [unanswered](#unanswered)). `jobs/e6-runs.test.mjs` runs each E6 job
  against a fake PocketBase and asserts zero writes under `dryRun`.

Para añadir o modificar un job, usa la skill `jobs`
(`.claude/skills/jobs/SKILL.md`), que documenta el contrato del módulo.
