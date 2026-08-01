---
name: i18n
description: Cambia, revisa o amplía los textos del escaparate en español e inglés — src/locales/*.json y el runtime t(). Úsala SIEMPRE que una feature toque copy visible o añada un idioma.
---

# Textos del escaparate (es / en)

Los textos son **datos**: `src/locales/es.json` y `src/locales/en.json`, planos
y ordenados por clave. Nada de literales en las páginas ni en los scripts.

## Reglas

1. **Toda cadena visible pasa por `t(locale, clave)`**. Si escribes un literal
   en `.astro` o en un `<script>`, el sitio queda a medio traducir y CI no te
   avisa (el gate compara diccionarios, no busca literales).
2. **Añade la clave a los DOS ficheros** en el mismo PR. `npm test` bloquea el
   merge si un idioma requerido tiene una clave vacía, de más o de menos, si el
   fichero está desordenado o si un `{placeholder}` desaparece al traducir.
3. **Claves en inglés, planas y con prefijo por zona**: `card.*`, `form.*`,
   `catalog.*`, `gallery.*`, `nav.*`, `page.*`. Una clave por cadena.
4. **Plurales con `Intl`**: `clave.one` / `clave.other` y llamada
   `t(locale, 'card.photos', { count: n })`. No montes el plural a mano.
5. **Números, fechas y precios**: `fmtMoney(locale, n, 'AED')`,
   `fmtNumber`, `fmtDate` — nunca `toLocaleString('es-ES')` a pelo.
6. **Los mensajes a Telegram siguen en español** (convención de la fábrica):
   el aviso de lead que va a `api.brotea.dev/requirements` no se traduce.

## Cómo llega el idioma a cada sitio

- Página: `export const getStaticPaths = localePaths;` → `Astro.props.locale`.
- Script de cliente: `document.documentElement.lang` (Astro comparte un único
  bundle entre `/` y `/en/`; el idioma no se puede compilar dentro).
- Script que solo toca atributos: `data-*` renderizados en servidor.

## Comprobar y ampliar

```
npm test                                                     # el gate (y el build)
node cli/brotea.mjs i18n check --app projects/inmobiliaria    # % por idioma
node cli/brotea.mjs i18n add <código> --app projects/inmobiliaria
node cli/brotea.mjs i18n promote <código> --app projects/inmobiliaria
```

Detalle y decisiones: `docs/i18n.md`. Contrato de la fábrica:
`docs/i18n-contract.md`.
