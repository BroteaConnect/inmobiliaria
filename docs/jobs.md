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

## Probar y dry-run

- Tests unitarios: `npm test` (ejecuta `node --test jobs/*.test.mjs` y
  después el build de Astro; CI corre exactamente eso).
- Dry-run contra datos reales, sin enviar nada (desde la raíz de la fábrica):
  `node scripts/run-jobs.mjs --slug inmobiliaria --dry-run --force`
  Añade `--jobs-dir <ruta>/jobs` para probar el código de un worktree **antes**
  de mergearlo (en producción el runner solo lee `main`).
- Qué toca ahora y por qué: `node scripts/run-jobs.mjs --list`.
- Los jobs son stateless y re-ejecutables: no escriben en PocketBase. Cada
  envío inserta su evento de plataforma — `lead.reminder_sent`
  (`{count, oldest}`) la agenda, `project.daily_digest` (los contadores) el
  resumen — **antes** de `notify()`: si un reintento repite el job, duplica
  una fila inofensiva, no un mensaje de Telegram.

Para añadir o modificar un job, usa la skill `jobs`
(`.claude/skills/jobs/SKILL.md`), que documenta el contrato del módulo.
