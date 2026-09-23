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
| `jobs/matcher.mjs` | 09:30 | Shortlist de leads que encajan con cada propiedad publicada o tocada en las últimas 24 h (ver [matcher](#matcher)). |
| `jobs/campanas.mjs` | cada hora | Solo habla cuando una campaña se prepara, se completa, se pausa o se bloquea. Lo que envía son mensajes a los leads a través del chasis, no avisos al equipo (ver [campanas](#campanas)). |

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

## campanas

`jobs/campanas.mjs` runs every hour and is the only job that writes to the
database. It picks up the campaigns a human put in `programada` or `en_curso`,
works out who is still owed a message, and hands the ones this hour allows to
the chassis — one at a time, inside the campaign's window, never more than
`MAX_ENVIOS_POR_RUN` (10) in a single run, whatever the settings say. All the
rules live in `jobs/campanas.lib.mjs` with tests; `jobs/campanas.test.mjs` runs
the job itself against a fake PocketBase and a fake chassis.

Order of one run, per campaign: repair the links a previous run could not
write → resolve what was in flight → check the preconditions → compute the
quota → send → close. Drafts are *armed* (a preview and a Telegram line, never
a send) the first time they are seen.

### `campanas.segmento` — who the campaign is for (contract v1)

Declarative JSON, evaluated by pure code. An unknown key, an unknown value, a
wrong type or a missing `v` is a loud refusal: the campaign sends nothing,
writes `informe.bloqueo` and keeps its state. A segment that does not parse
must never mean "everybody".

| key | type | meaning |
|---|---|---|
| `v` | `1`, required | contract version |
| `etapa` | `string[]` | `lead.etapa` is in the list |
| `origen` | `string[]` | `lead.origen` is in the list, compared **normalised** (the importer writes `histórico`, with an accent) |
| `consentimiento` | `true`/`false` | `true` matches `=== true`; `false` matches everyone else, the never-asked included |
| `canal_preferido` | `string[]` ⊂ email/whatsapp | a field that is empty on the instance matches nobody — do not filter on it |
| `idioma` | `string[]` ⊂ es/en | same warning |
| `incluye_ids` | `string[]` | restricts the candidates; it never bypasses another rule |
| `excluye_ids` | `string[]` | applied last, always wins |
| `sin_contacto_dias` | int ≥ 0 | excludes leads contacted in the last N days; an empty `ultimo_contacto` means never contacted, which is eligible |
| `max` | int ≥ 1 | hard cap, applied after a deterministic sort (`created` ascending, then `id`) |
| `variables` | `{string: string}` | **not a filter**: the campaign's fixed template values (`url`, `municipio`…) |

Reachability cannot be written in the JSON and is implicit in the template's
channel: an email campaign needs a non-empty `leads.email`, a WhatsApp one a
non-empty `leads.telefono`. Whoever fails is excluded as `sin_email` /
`sin_telefono`, counted in the report, and never handed to the chassis.

`baja_url` and `si_url` (`VARIABLES_DEL_CHASIS`) are minted and signed by the
chassis with a secret only it holds. They are never built here, never sent and
never counted as missing. Anything else a template declares must come from the
lead (`nombre`, `agente`) or from `segmento.variables`; what is still missing
blocks the campaign rather than shipping a body with a literal `{{municipio}}`
in it.

### `campanas.informe` — what happened (contract v1)

Written by the job, read by a human. `armada_en` and `alcance_estimado` come
from the arming preview (matched / reachable / unreachable, because "216
recipients" when 25 of them have no phone is a number that gets approved and
then disappoints); `enviados`, `estados` and `por_dia` are re-read from the
`envios` ledger at every close, never accumulated in memory; `enviados_ids` is who
has been written to (see below — it is the one record that must not live in
another collection); `rechazos` tallies every chassis answer under its own
code; `excluidos`, `reintentos`, `dudosos`, `en_vuelo` and `enlaces_fallidos`
are the open questions; `bloqueo` is why
nothing is going out; `informe_manager` records whether the manager's WhatsApp
report went, and when it did not, exactly which precondition was missing.

Delivery counters are a **snapshot**: `entregado` arrives by webhook minutes
later, so a campaign that completes in the same run truthfully reports 0
delivered and never updates it. The Telegram line says "a fecha del cierre".

### Cadence, without ever sleeping

The window is `hora_desde` ≤ now < `hora_hasta` in **Madrid local time**
(`Intl`, so DST is never our problem); `hora_desde >= hora_hasta` is a
configuration error, not a night shift, and is reported as one. "Already sent
today" is counted from the `envios` rows of the campaign whose Madrid day is
today and whose `estado` is not `error` — the ledger, never a counter we kept.
The interval is spent as **credits**: an hourly runner cannot hold a process
for eight hours, so a run may send `floor(minutes since ultimo_envio_en /
intervalo_min)`, capped by what is left of `lote_diario` and by
`MAX_ENVIOS_POR_RUN`.

That means the drip arrives in **batches**, not one message every N minutes: a
campaign with no `ultimo_envio_en` sends up to 10 in the first run, then as
many as the interval has earned each hour. It is a real behaviour and the
arming preview says so in those words — it used to promise "1 cada 10 min",
which the very first run broke. Re-checking the wall clock inside the loop
would make the promise literally true and quietly turn a 30-a-day campaign into
an 8-a-day one, which is a product change hiding inside a wording fix. The
messages go to *different* people, so the batch is bulk sending, not a person
being messaged ten times.

`lote_diario` below 1, an `intervalo_min` that is negative or not a number, and
a window that does not run forwards are all configuration errors: they block
the campaign and say so, instead of defaulting to something nobody chose. An
empty `intervalo_min` column still means "no pacing", which is a decision.

### The state machine

The runner picks up **`programada`** and **`en_curso`** and writes exactly four
transitions:

- `programada → en_curso` on the first successful send
- `en_curso → completada` when nobody is left AND nothing is unresolved (an
  empty segment completes on the first run with 0 recipients — honest, not a
  bug)
- `en_curso → pausada` after three runs in a row that **could have sent and did
  not**, with the reason in `informe.bloqueo`. Runs outside the sending window,
  before `inicio`, with the day's batch already spent or with nobody pending do
  not count: there was nothing to fail at. Counting them made `lote_diario` and
  the sending hours cancel each other out — a campaign with a batch of 1 sent
  its message and paused three hours later, and an 08:00–22:00 campaign paused
  overnight, each needing a human in PocketBase Admin to come back.
- nothing else. `borrador` is only armed; `pausada`, `completada` and
  `cancelada` are a human's decision and the job does not argue with them.

Resuming is a human writing `en_curso`. **Today that is done from PocketBase
Admin**: the CRM screen where a campaign is reviewed and started is a separate
feature for a later pass, and `inmobiliaria-crm` is deliberately untouched here.

A `completada` campaign does not pick up a lead imported next month. That is
deliberate: a campaign is a decision taken on a population at a point in time,
not a standing rule. Sending to the newcomers is a new campaign.

### Sending twice is the failure that matters

**Who has already been written to is recorded in `informe.enviados_ids`, by the
job, at the moment of the send.** That is the invariant everything else rests
on, and it deliberately depends on nothing outside the campaign row. The
`envios` ledger cannot carry it: the chassis answers `ok` with `envio_id: null`
whenever its own ledger write failed (it never fails a send that already left,
by design), and the `envios.campana` patch can fail on its own. Reading "has
this person received it?" off a foreign key means that, whenever either write
misses, the next run finds the lead pending and writes to them again — every
hour, for as long as it keeps missing. `pendientes()` therefore reads
`enviados_ids` first, and the closing report never claims fewer sends than the
job knows it made.

Before every chassis call the recipient is appended to `informe.en_vuelo` and
the campaign row is patched; the entry is removed once the send is resolved. If
the patch itself fails, that recipient is skipped **without sending** — an
unrecorded send is the one that gets doubled later. A surviving entry is
resolved on the next run by **adoption**, which runs *after* the template gate
— it needs the template to recognise our own row, and a campaign whose
`plantilla` was cleared would otherwise file every entry as `dudoso`,
irreversibly, a moment before the run blocked on `sin_plantilla`. If an
`envios` row exists for that
lead **and that exact template**, not already claimed by another campaign, and
created since then, it is adopted (its `campana` is patched) and counted as
sent; if not, it moves to `informe.dudosos` and is **never retried**. Adoption
re-stamps a row as this campaign's, so it has to be sure the row is ours — a
loose match would rewrite another flow's history and report a delivery that
never happened. An `en_vuelo` entry whose lead id could not be an id is
discarded rather than interpolated into a filter: the column is editable from
PocketBase Admin.

Linking is two patches after the send — `envios.campana` and
`actividades.campana` — and the activity id is read as
`body.activity_id ?? body.actividad_id`, because `/send-email` and
`/send-whatsapp` disagree on the name. A failed patch never makes a lead
pending again (`enviados_ids` is what decides): it goes to
`informe.enlaces_fallidos`, capped at the 50 most recent because `informe` is
rewritten after every single send, and the next run repairs it first.

### What the chassis answers, and what it costs

| answer | what the job does |
|---|---|
| `no_email`, `no_phone`, `no_consent`, `consent_revoked`, `template_not_approved`, `outside_window`, any other 4xx | terminal for that lead: `informe.excluidos`, and the campaign can complete |
| `chassis_timeout`, `chassis_unreachable`, `provider_unavailable`, 429, Twilio `63018` | retryable, because the chassis said in so many words that nothing left: stays pending, `informe.reintentos[lead]++`, given up as `agotado` at 3 |
| `variables_missing` | terminal for the RUN: the same values are built for everybody, so one bug must not burn ten leads |
| **401 / 403**, unless it carries a per-lead code we recognise | terminal for the RUN: `informe.bloqueo = { code: 'chasis_no_autorizado' }`, nobody is excluded, no state changes |
| **`… not configured`** (`not configured`, `smtp not configured`, `pocketbase not configured`, `outbound email not configured`) | terminal for the RUN: `chasis_no_configurado`. Same reasoning as the credential — a guard clause raised for every recipient alike, before any provider call |
| `send failed`, and any unnamed 5xx **the chassis itself produced** | ambiguous, treated exactly like silence (below) |
| a 5xx that is *not* chassis JSON (a Traefik/Coolify page mid-redeploy) | retryable: nothing ever reached the mailer |
| no answer at all | the entry stays in flight, the run **fails** so Alertas hears, and the next run adopts it or files it as `dudoso` |

The rows that cost real money are the ones about the chassis rather than about
a person. **A credential and a configuration are properties of the run**: the
shared secret travels in the query string, so a rotated one answers 403 to
every recipient, and a container that boots with half an environment answers
`smtp not configured` to every recipient. Classified per lead, the first files
the whole cartera as terminally excluded and the second spends everybody's
three retries and then writes them off as `agotado` — in both cases the
campaign "completes" having written to nobody, with no way back but editing the
`informe` by hand, and the Telegram line blames the segment. Both block the
campaign instead, naming which one it is, and change nobody's state. The
credential rule is deliberately **inclusive**: a 401/403 blocks the run unless
it carries a per-lead code we already recognise (`no_consent` and the rest of
`RECHAZOS_TERMINALES`). An auth code we have never seen — and the chassis's
auth contract is changing — must not be read as a refusal of one person,
because the fall-through for an unknown 4xx is "terminal for that lead": it
would write off every recipient in the run, ten an hour, and then let the
campaign complete and announce itself having messaged nobody. Blocking is
recoverable; excluding the cartera is not. A 403 from a proxy or a WAF is
indistinguishable from the chassis's own out here and blocks in the same way,
so the Telegram line names both possibilities instead of sending the team
straight to `OUTBOUND_SECRET`. The far end's code travels with it, sanitised
down to an identifier: it reaches Telegram and an event payload, and it is not
our string.

**Ambiguity is narrow on purpose**: only a 5xx the chassis wrote itself (its
own `{ok}`/`{error}` shape, or at least a JSON content-type), with no code we
know, may have been sent. An infrastructure error page is a known non-send.
Two things worth knowing about that line:

- A 5xx that is not JSON is retried, so there is a narrow window where the
  chassis dies *after* the mail is accepted and the gateway answers HTML: the
  orphan `envios` row carries no `campana`, and the retry sends a second copy.
  The content-type check shrinks it; nothing available from outside closes it.
- The chassis's catch-all `500 {error:'internal error'}` is, today, a provable
  non-send — every uncaught throw on both routes happens before the provider
  call. It is still treated as ambiguous, deliberately: that proof is an audit
  of throw sites, which one `await` added after a send would invalidate, while
  the proof for 401/403 and `… not configured` is a guard clause that cannot be
  reached after a send. A lost lead shows up in `informe.dudosos` and in the
  Telegram report, where a human can act on it; a second message to a real
  person cannot be undone.

As a last guard, a campaign that reaches the end having sent **nothing** while
holding unresolved sends is blocked (`nada_enviado`) rather than completed:
quiet failure must not look like success. That blockage is recorded, never
returned early — the transport alarm at the end of the run has to fire, or
`run-jobs` records a green run, Alertas is never told and the three-strike
circuit never opens. After three runs that could have sent and did not, the campaign
pauses (carrying that reason) instead of re-blocking for ever. A blockage is
announced at most once a Madrid day, compared against what the *previous* run
left: the run clears `informe.bloqueo` before the send loop, so comparing
against the live value quietly made every blockage hourly and unbounded.

Only a chassis that never answered — or answered ambiguously — makes `run()`
throw. Business refusals never do: three throws in one Madrid day open the
runner's circuit and the campaign would stall until tomorrow.

### Preconditions, and no fallbacks

`ctx.env` carries the chassis credentials (`CHASSIS_URL`, `OUTBOUND_SECRET`,
read from `~/.config/brotea/jobs-<slug>.env`, never printed). Missing them is
`informe.bloqueo = { code: 'sin_chasis' }`, one Telegram line a day, and no
state change — there is no fallback transport and no writing `simulado` rows
and calling it a campaign. The same for a WhatsApp template Meta has not
approved: it is checked **once**, before anything is sent, because asking per
lead would burn the whole batch on `template_not_approved` one refusal at a
time.

The manager's WhatsApp report is checked as data and never faked: a `settings`
row `campanas.gestor` naming a lead, that lead existing with a phone, and the
`campana.informe` template being `approved`. Any one missing and **no call is
made**, with the exact missing precondition recorded in
`informe.informe_manager` and echoed in the Telegram line. It is sent **once,
ever**: the result is written on its own the moment it is known, and if *that*
write is the one that fails it is caught — the closing write is the second
chance to persist it — so no failure mode reports the same campaign twice.

### The catalog

`pb/campanas.json` seeds two campaigns keyed by `nombre`
(`node pb/campanas.mjs --slug inmobiliaria [--dry-run] [--force]`). `--force`
only ever rewrites a row still in `borrador`: a running campaign has a report,
a ledger and people in it, and a file must not be able to rewind that. The seed
validates the catalog — including the segment, through the same contract the
runner uses — before contacting the instance, and prints which seeded campaign
is BLOCKED and why.

One rule is worth naming: a `marketing` template may not be aimed at a segment
of people who have not consented **unless** its `evento` is
`campana.consentimiento`. The consent request is precisely the message that may
go to someone who has not consented; everything else may not.

## Probar y dry-run

- Tests unitarios: `npm test` (ejecuta `node --test src/locales/*.test.mjs
  scripts/*.test.mjs jobs/*.test.mjs pb/*.test.mjs` — el gate i18n del
  escaparate, ver [docs/i18n.md](i18n.md), los tests de jobs y los de los
  catálogos de `pb/` — y después `astro check` y el build; CI corre
  exactamente eso).
- Sembrar el catálogo de campañas: `node pb/campanas.mjs --slug inmobiliaria
  --dry-run` primero (imprime qué crearía y no escribe), y sin `--dry-run`
  cuando el listado cuadre. Solo reescribe filas en `borrador`.
- Dry-run contra datos reales, sin enviar nada (desde la raíz de la fábrica):
  `node scripts/run-jobs.mjs --slug inmobiliaria --dry-run --force`
  Añade `--jobs-dir <ruta>/jobs` para probar el código de un worktree **antes**
  de mergearlo (en producción el runner solo lee `main`).
- Qué toca ahora y por qué: `node scripts/run-jobs.mjs --list`.
- `agenda`, `resumen` y `matcher` son stateless y re-ejecutables: no escriben
  en PocketBase. Cada envío inserta su evento de plataforma —
  `lead.reminder_sent` (`{count, oldest}`) la agenda, `project.daily_digest`
  (los contadores) el resumen, `matcher.shortlist`
  (`{propiedad_id, candidates, lead_ids}`) el matcher — **antes** de
  `notify()`: si un reintento repite el job, duplica una fila inofensiva, no
  un mensaje de Telegram.
- **`campanas` sí escribe en PocketBase**, y eso rompe la regla anterior a
  propósito: sin estado no hay forma de saber a quién ya se le escribió. Todas
  sus escrituras pasan por un único `escribir()` que `--dry-run` corta, y en un
  ensayo tampoco llama al chasis: imprime lo que enviaría y no toca una fila.
  `ctx.dryRun` **solo** neutraliza `event()` y `notify()`; `ctx.pb` es un
  cliente superusuario de verdad, así que cualquier escritura nueva que no pase
  por `escribir()` escribiría también en el ensayo.

Para añadir o modificar un job, usa la skill `jobs`
(`.claude/skills/jobs/SKILL.md`), que documenta el contrato del módulo.
