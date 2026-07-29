---
name: pb-schema
description: Evoluciona el modelo de datos del sistema inmobiliario — editar pb/schema.json y aplicarlo al PocketBase compartido. Úsala SIEMPRE que una feature necesite campos o colecciones nuevas.
---

# Evolucionar el modelo de datos

El modelo vive en `pb/schema.json` (este repo, declarativo). NUNCA toques
colecciones a mano en el admin de PocketBase: cambia el JSON y aplícalo.

## Pasos

1. Edita `pb/schema.json` — añade la colección o el campo. Tipos habituales:
   `text`, `number`, `email`, `select` (con `values`), `file` (con
   `maxSelect`, `mimeTypes`, `thumbs`), `relation` (con `"collection":
   "<nombre destino>"` — el script resuelve el id).
2. Aplica desde la raíz de la fábrica:
   `node scripts/pb-schema.mjs inmobiliaria projects/inmobiliaria/pb/schema.json`
3. El apply es **aditivo**: crea colecciones/campos que falten y actualiza
   reglas; jamás borra campos (borrar = decisión manual consciente en el
   admin, tras migrar los datos).
4. Commit del JSON por PR (CI → auto-merge). El JSON en main ES la verdad
   del modelo: si el admin y el JSON discrepan, gana el JSON.

## Reglas de acceso

Se declaran en `rules` por colección (sintaxis de PocketBase). Convención del
proyecto: público solo lo imprescindible (`propiedades` publicadas en
lectura, `leads.create` para el formulario); todo lo demás exige
`@request.auth.id != ""`.

## Credenciales

Superusuario en `~/.config/brotea/pb-inmobiliaria.env` (0600) del host de la
fábrica. No las imprimas nunca.
