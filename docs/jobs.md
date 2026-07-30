# Jobs programados — recordatorios y resumen diario

Los `jobs/*.mjs` de este repo son la mitad *proactiva* del seguimiento: el
chasis de la fábrica (`scripts/run-jobs.mjs`, cron horario en el host) los
descubre en el checkout de `main`, decide cuál toca según su `when` y les
inyecta el contexto (PocketBase autenticado, notificador de Telegram,
eventos de plataforma). Aquí solo viven las **reglas de producto**; la
infraestructura (auth, scheduling, fallos) es del chasis y no se copia.

## Qué se envía y cuándo (hora de Madrid)

| Job | Hora | Mensaje al topic de Telegram |
|---|---|---|
| `jobs/agenda.mjs` | 09:00 | Leads con más de **48 h** sin contacto, el más abandonado primero. `⚠️` a partir de 5 días. Máximo 10 líneas + "… y N más". |
| `jobs/resumen.mjs` | 20:00 | Resumen del día: leads nuevos, contactos salientes por canal, mensajes entrantes, emails entregados y propiedades publicadas. |

**El silencio es una feature**: si no hay leads desatendidos o el día está
vacío, no se envía nada. Un canal que solo habla cuando hay algo que decir
no se silencia.

## Las reglas (viven en `jobs/lib.mjs`, con tests)

- Reloj de abandono: `ultimo_contacto || created` — un lead nuevo que nadie
  ha tocado nunca es el caso más urgente y aparece por el fallback.
- Etapas excluidas: `nutriendo` (aparcado a propósito) y `vendido` (no hay
  nada que perseguir) — las mismas que `desatendido()` en el CRM.
- Umbrales: 48 h para entrar en la agenda, 5 días para el `⚠️`, 10 líneas
  de tope. Cambiarlos es editar las constantes de `lib.mjs` en un PR.
- El "día" es siempre el día local de **Europe/Madrid**, calculado con
  `Intl.DateTimeFormat` — nunca sumando offsets fijos (el DST desplazaría
  la agenda una hora dos veces al año).

## Probar y dry-run

- Tests unitarios: `npm test` (ejecuta `node --test jobs/*.test.mjs` y
  después el build de Astro; CI corre exactamente eso).
- Dry-run contra datos reales, sin enviar nada (desde la raíz de la
  fábrica, cuando exista el runner):
  `node scripts/run-jobs.mjs --slug inmobiliaria --dry-run --force`
- El estado de ejecución (`job.ran` / `job.failed`) vive en la tabla
  `events` de la plataforma, no en PocketBase: los jobs son stateless y
  re-ejecutables.

Para añadir o modificar un job, usa la skill `jobs`
(`.claude/skills/jobs/SKILL.md`), que documenta el contrato del módulo.
