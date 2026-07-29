# Sistema inmobiliario — arquitectura

Dos apps de la fábrica Brotea + un PocketBase compartido. Este repo
(`inmobiliaria`) es el **proyecto de referencia**: aquí viven el modelo de
datos, el seed y la documentación; el CRM vive en
`BroteaConnect/inmobiliaria-crm`.

## Piezas

| Pieza | Qué es | Dónde |
|---|---|---|
| Escaparate | Catálogo público + captura de leads (astro, este repo) | https://inmobiliaria.brotea.dev |
| CRM | Panel privado: kanban de leads, propiedades, import CSV (react) | https://crm-inmobiliaria.brotea.dev |
| Backend | PocketBase compartido (datos, fotos, auth, realtime) | https://pb-inmobiliaria.brotea.dev |
| Modelo de datos | `pb/schema.json` (declarativo, aditivo) | este repo |
| Seed demo | `pb/seed.mjs` | este repo |

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
- `propietarios`/`actividades`: todo con sesión.

## Cómo se actualiza (usa las skills de .claude/skills/)

- Modelo de datos → skill `pb-schema` (editar `pb/schema.json` y aplicar).
- Datos de demo → skill `demo-data`.
- Código → PR normal de la fábrica: CI verde → auto-merge → deploy.
- El tema visual es `brotea@2.0.0` (lockfile `brotea.json`); para la marca de
  la clienta: crear su tema en el catálogo de la fábrica y `brotea theme`.

## Deuda consciente / siguiente iteración

- Motor de seguimiento (recordatorios 48 h, matching, resumen diario): cron
  del chasis pendiente de diseño — hoy el aviso es instantáneo por Telegram.
- Import: CSV (el Excel se guarda como CSV); parser xlsx nativo si molesta.
- WhatsApp saliente: enlaces `wa.me` prellenados en el CRM (API de WhatsApp
  Business en fase 2).
