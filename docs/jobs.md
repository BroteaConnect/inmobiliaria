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

Para añadir o modificar un job, usa la skill `jobs`
(`.claude/skills/jobs/SKILL.md`), que documenta el contrato del módulo.
