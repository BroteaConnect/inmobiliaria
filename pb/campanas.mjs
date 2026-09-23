#!/usr/bin/env node
// campanas.mjs — seeds the campaign catalog (pb/campanas.json) into the
// PocketBase `campanas` collection, keyed by `nombre`.
//
//   node pb/campanas.mjs [--slug inmobiliaria] [--dry-run] [--force]
//
// Three verbs, one line per catalog row, in file order:
//   campanas: <nombre> created   the row did not exist → POST
//   campanas: <nombre> kept      it exists (or --force found it identical, or
//                                it has already started: a campaign past
//                                `borrador` is NEVER rewritten from a file —
//                                it has a report, a ledger and people in it)
//   campanas: <nombre> updated   --force only, and only on a `borrador` row
// Rows on the instance the catalog does not know are reported, never touched.
// After the writes it says which seeded campaign is BLOCKED and why — a
// WhatsApp campaign whose template Meta has not approved would refuse every
// recipient, and reading that here beats discovering it thirty refusals later.
// --dry-run prints the same lines with " (dry-run)" and writes nothing.
// Exit codes: 0 ok, 1 instance/credentials error, 2 catalog invalid, 64 usage.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { bloqueadas, createBody, missingOnCreate, problemasConPlantillas, problems, updateBody } from './campanas.lib.mjs';

const USAGE = 'usage: node pb/campanas.mjs [--slug <slug>] [--dry-run] [--force]';

// -- flags ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
let slug = 'inmobiliaria';
let dryRun = false;
let force = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--force') force = true;
  else if (a === '--slug' && argv[i + 1] && !argv[i + 1].startsWith('--')) slug = argv[++i];
  else if (a === '--slug') { console.error(`✖ campanas: --slug needs a value\n${USAGE}`); process.exit(64); }
  else if (a.startsWith('--slug=')) slug = a.slice('--slug='.length);
  else { console.error(`✖ campanas: unknown flag ${a}\n${USAGE}`); process.exit(64); }
}
const suffix = dryRun ? ' (dry-run)' : '';

// -- catalog (validated before any I/O) -----------------------------------------------
const rows = JSON.parse(readFileSync(new URL('./campanas.json', import.meta.url), 'utf8'));
const plantillas = JSON.parse(readFileSync(new URL('./plantillas.json', import.meta.url), 'utf8'));
const invalid = [...problems(rows), ...problemasConPlantillas(rows, plantillas)];
if (invalid.length) {
  for (const p of invalid) console.error(`✖ campanas: ${p}`);
  process.exit(2);
}
const bodyProblems = rows.flatMap((row) => missingOnCreate(createBody(row, 'x')).map((f) => `${row.nombre}: create body lacks ${f}`));
if (bodyProblems.length) {
  for (const p of bodyProblems) console.error(`✖ campanas: ${p}`);
  process.exit(2);
}

// -- credentials (never printed) ------------------------------------------------------
const credFile = join(homedir(), '.config', 'brotea', `pb-${slug}.env`);
if (!existsSync(credFile)) {
  console.error(`✖ campanas: no credentials for ${slug} (~/.config/brotea/pb-${slug}.env)`);
  process.exit(1);
}
const creds = readFileSync(credFile, 'utf8');
const pick = (k) => creds.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const PB = pick('PB_URL');
const EMAIL = pick('PB_ADMIN_EMAIL');
const PASS = pick('PB_ADMIN_PASS');
if (!PB || !EMAIL || !PASS) {
  console.error(`✖ campanas: no credentials for ${slug} (~/.config/brotea/pb-${slug}.env)`);
  process.exit(1);
}

// A network failure would otherwise surface undici's error, whose cause names
// the host. We print the error code only, and never hang for ever.
const call = async (url, init = {}) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    console.error(`✖ campanas: instance unreachable (${e.cause?.code ?? e.name})`);
    process.exit(1);
  }
};

// -- auth (superuser login is rate-limited: 2 per 3 s; retry on 429 only) --------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = '';
for (let attempt = 1; attempt <= 4; attempt++) {
  const r = await call(`${PB}/api/collections/_superusers/auth-with-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: EMAIL, password: PASS }),
  });
  if (r.status === 429 && attempt < 4) { await sleep(3500 * attempt); continue; }
  if (r.status >= 300) { console.error(`✖ campanas: superuser auth failed (HTTP ${r.status})`); process.exit(1); }
  token = (await r.json()).token;
  break;
}
const H = { Authorization: token };
const HJ = { ...H, 'Content-Type': 'application/json' };

const listAll = async (coleccion, sort) => {
  const items = [];
  for (let page = 1; ; page++) {
    const r = await call(`${PB}/api/collections/${coleccion}/records?perPage=200&page=${page}&sort=${sort}`, { headers: H });
    if (r.status >= 300) { console.error(`✖ campanas: list ${coleccion} failed (HTTP ${r.status})`); process.exit(1); }
    const data = await r.json();
    items.push(...(data.items ?? []));
    if (page >= (data.totalPages ?? 1) || (data.items ?? []).length === 0) break;
  }
  return items;
};

// -- the templates the relations point at ---------------------------------------------
const plantillasInstancia = await listAll('plantillas', 'clave');
const idPorClave = new Map(plantillasInstancia.map((p) => [p.clave, p.id]));
const sinPlantilla = rows.filter((row) => !idPorClave.has(row.plantilla));
if (sinPlantilla.length) {
  for (const row of sinPlantilla) console.error(`✖ campanas: ${row.nombre}: template ${row.plantilla} is not on the instance (run pb/plantillas.mjs first)`);
  process.exit(1);
}

// -- current state --------------------------------------------------------------------
const existing = await listAll('campanas', 'nombre');
const porNombre = new Map();
for (const rec of existing) {
  if (porNombre.has(rec.nombre)) {
    console.error(`✖ campanas: duplicate nombre on the instance: ${rec.nombre} (${porNombre.get(rec.nombre).id}, ${rec.id})`);
    process.exit(1);
  }
  porNombre.set(rec.nombre, rec);
}

// -- writes ---------------------------------------------------------------------------
const COL = `${PB}/api/collections/campanas/records`;
const write = async (nombre, method, url, body) => {
  const r = await call(url, { method, headers: HJ, body: JSON.stringify(body) });
  if (r.status >= 300) {
    const text = await r.text();
    console.error(`✖ campanas: ${nombre}: HTTP ${r.status} ${text.slice(0, 200)}`);
    process.exit(1);
  }
};

const counts = { created: 0, updated: 0, kept: 0 };
for (const row of rows) {
  const current = porNombre.get(row.nombre);
  const say = (verb) => console.log(`campanas: ${row.nombre} ${verb}${suffix}`);
  const plantillaId = idPorClave.get(row.plantilla);

  if (!current) {
    if (!dryRun) await write(row.nombre, 'POST', COL, createBody(row, plantillaId));
    counts.created++;
    say('created');
    continue;
  }
  if (!force) { counts.kept++; say('kept'); continue; }
  // A campaign that has started has a report, a ledger and people in it. A
  // file must never be able to rewind that, --force or not.
  if (current.estado !== 'borrador') { counts.kept++; say(`kept (already ${current.estado}: a running campaign is not seeded from a file)`); continue; }
  if (!dryRun) await write(row.nombre, 'PATCH', `${COL}/${current.id}`, updateBody(row, plantillaId));
  counts.updated++;
  say('updated');
}

// -- foreign rows: reported, never deleted --------------------------------------------
const known = new Set(rows.map((r) => r.nombre));
for (const rec of existing) {
  if (!known.has(rec.nombre)) console.log(`campanas: ${rec.nombre} foreign (not in catalog, left alone)`);
}

// -- what would stop them sending -----------------------------------------------------
for (const b of bloqueadas(rows, plantillasInstancia)) {
  console.log(`campanas: ${b.nombre} BLOCKED (${b.code}) — ${b.motivo}`);
}

console.log(`campanas: ${dryRun ? existing.length : (await listAll('campanas', 'nombre')).length} rows on the instance`);
if (dryRun) console.log(`campanas: dry-run would create ${counts.created}, update ${counts.updated}, keep ${counts.kept}`);
