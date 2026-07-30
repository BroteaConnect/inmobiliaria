---
name: jobs
description: Añade o modifica jobs programados del proyecto (agenda de leads, resumen diario) — módulos jobs/*.mjs que el runner del chasis ejecuta a su hora de Madrid. Úsala SIEMPRE que una feature necesite avisos o tareas periódicas.
---

# Jobs programados del proyecto

Los jobs viven en `jobs/*.mjs` (este repo). El runner genérico del chasis
(`scripts/run-jobs.mjs` en la raíz de la fábrica, cron horario) los descubre
en el checkout de `main`, mira su `when` y los ejecuta con contexto
inyectado. NUNCA metas aquí auth, scheduling ni manejo de credenciales: eso
es del chasis.

## Contrato del módulo

```js
export const when = { daily: '09:00' }; // hora LOCAL de Madrid, HH:MM

export async function run(ctx) { ... }
// ctx = { pb, notify, event, log, now, slug }
//   pb          cliente PocketBase JS ya autenticado (superusuario)
//   notify(txt) mensaje de Telegram al topic del proyecto (parse HTML, en español)
//   event(t, p) inserta una fila en events de la plataforma (payload jsonb)
//   log(msg)    logging a stdout
//   now         Date del arranque de la ejecución
//   slug        slug del proyecto
```

## Pasos

1. La lógica (selección, umbrales, textos) va en `jobs/lib.mjs` como
   funciones **puras** — sin I/O ni imports de PocketBase — con sus tests en
   `jobs/lib.test.mjs`. El módulo del job queda fino: fetch → función pura →
   `notify()` solo si hay algo que decir (el silencio es una feature).
2. Tests: `node --test jobs/*.test.mjs` (o `npm test`, que además hace el
   build de Astro — es lo que corre CI y bloquea el merge).
3. Dry-run contra datos reales sin enviar nada (raíz de la fábrica):
   `node scripts/run-jobs.mjs --slug inmobiliaria --dry-run --force`
4. Commit por PR (CI → auto-merge). El runner ejecuta lo que hay en `main`,
   nunca un worktree: hasta el merge no cambia nada en producción.

## Reglas que ya viven en lib.mjs (no las dupliques)

- `desatendidos()`: >48 h sin contacto con reloj `ultimo_contacto || created`;
  excluye `nutriendo` y `vendido` (igual que el CRM); orden: el más
  abandonado primero.
- `textoAgenda()`: máx. 10 líneas + "… y N más", `⚠️` a partir de 5 días,
  `null` si no hay nada.
- `resumenDelDia()` / `textoResumen()`: contadores del día local de Madrid;
  `null` si el día está vacío.
- Día/hora SIEMPRE con `Intl.DateTimeFormat` y timeZone `Europe/Madrid` —
  jamás sumando offsets fijos (DST).

Los textos de Telegram van en español (HTML escapado con `escapeHtml` para
datos de usuario); el resto del código y comentarios, en inglés.
