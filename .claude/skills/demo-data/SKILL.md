---
name: demo-data
description: Puebla (o repuebla) el PocketBase del sistema inmobiliario con datos de demostración — usuaria del CRM, propietarios, propiedades con foto y leads de ejemplo. Úsala para preparar demos o entornos limpios.
---

# Datos de demostración

`pb/seed.mjs` es idempotente: puedes ejecutarlo las veces que quieras, solo
crea lo que falta (busca por nombre/email antes de crear).

## Ejecutar

Desde la raíz de la fábrica:

```
node projects/inmobiliaria/pb/seed.mjs
```

Crea:
- La usuaria del CRM (`intermediaria@brotea.dev`) — la contraseña se genera
  y se guarda 0600 en `~/.config/brotea/inmobiliaria-crm-user.env`.
- 3 propietarios, 5 propiedades (3 publicadas, con foto SVG generada) y
  3 leads en etapas distintas con una actividad.

## Para la demo con datos reales

El CRM tiene un asistente de importación CSV (pestaña "Importar"): la
clienta guarda su Excel como CSV y lo sube — columnas mapeables a
propietarios y propiedades. No metas datos personales reales en el seed.
