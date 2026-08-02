#!/usr/bin/env node
// build-stamp.mjs — escribe public/version.json con el commit del que salió el
// build. Fichero GENERADO en cada app por `brotea quality sync`: se arregla en
// la fábrica (quality/build-stamp.mjs), no en el repo del proyecto.
//
// ¿Por qué existe? Porque hasta hoy no había forma de responder «¿la web sirve
// el código que revisamos?». Coolify guarda `git_commit_sha: "HEAD"` (no un SHA)
// y no pasa el commit como build-arg, así que el plano de control no lo sabe. Y
// el caso que de verdad importa no lo detecta ninguna base de datos: un
// despliegue que falla deja el contenedor ANTERIOR sirviendo, con CI en verde y
// la fila de despliegue diciendo que todo fue bien (nos pasó el 2026-08-01 con
// maría-limpieza: `/` respondía 200 con la versión vieja y `/en/` daba 404).
// Solo un sello que responda la propia web distingue eso.
//
// El commit llega en PUBLIC_BUILD_COMMIT, que la fábrica pone como variable de
// build antes de desplegar. Si falta —build local, o alguien lanzó el deploy a
// mano desde Coolify— se cae al git del contexto y, si tampoco, a "unknown":
// un sello honesto que dice "no lo sé" vale más que uno inventado.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const fromEnv = (process.env.PUBLIC_BUILD_COMMIT ?? '').trim();
const fromGit = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};

const commit = fromEnv || fromGit() || 'unknown';
const stamp = {
  commit,
  short: commit.slice(0, 12),
  source: fromEnv ? 'factory' : (commit === 'unknown' ? 'none' : 'git'),
  branch: (process.env.COOLIFY_BRANCH ?? '').trim() || null,
  built_at: new Date().toISOString(),
};

mkdirSync('public', { recursive: true });
writeFileSync('public/version.json', `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`build-stamp: ${stamp.short} (${stamp.source})`);
