#!/usr/bin/env node
// plantillas.mjs — seeds the message-template catalog (pb/plantillas.json)
// into the PocketBase `plantillas` collection, keyed by `clave`.
//
//   node pb/plantillas.mjs [--slug inmobiliaria] [--dry-run] [--force]
//
// Three verbs, one line per catalog row, in file order:
//   plantillas: <clave> created   the row did not exist → POST content + lifecycle defaults
//   plantillas: <clave> kept      the row exists (or, under --force, its content is unchanged
//                                 or the instance version is newer than the catalog)
//   plantillas: <clave> updated   --force only: content differs AND the catalog version is
//                                 newer → PATCH content, stamp `version` and reset the Twilio
//                                 lifecycle (estado borrador, content_* cleared) so the template
//                                 goes back through /content/submit. Same version, different
//                                 text is kept: bump CATALOG_VERSION to ship it.
// Rows on the instance that the catalog does not know are reported and never
// touched. --dry-run prints the same lines with a " (dry-run)" suffix and
// writes nothing. Exit codes: 0 ok, 1 instance/credentials error, 2 catalog
// invalid (nothing contacted), 64 usage.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { contentOf, problems, sameContent } from './plantillas.lib.mjs';

// The catalog's own version. Bump it when a content change must win over
// edits made on the instance; rows whose instance version is higher are kept.
const CATALOG_VERSION = 1;
const USAGE = 'usage: node pb/plantillas.mjs [--slug <slug>] [--dry-run] [--force]';

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
  else if (a === '--slug') { console.error(`✖ plantillas: --slug needs a value\n${USAGE}`); process.exit(64); }
  else if (a.startsWith('--slug=')) slug = a.slice('--slug='.length);
  else { console.error(`✖ plantillas: unknown flag ${a}\n${USAGE}`); process.exit(64); }
}
const suffix = dryRun ? ' (dry-run)' : '';

// -- catalog (validated before any I/O) -----------------------------------------------
const rows = JSON.parse(readFileSync(new URL('./plantillas.json', import.meta.url), 'utf8'));
const invalid = problems(rows);
if (invalid.length) {
  for (const p of invalid) console.error(`✖ plantillas: ${p}`);
  process.exit(2);
}

// -- credentials (never printed) ------------------------------------------------------
const credFile = join(homedir(), '.config', 'brotea', `pb-${slug}.env`);
if (!existsSync(credFile)) {
  console.error(`✖ plantillas: no credentials for ${slug} (~/.config/brotea/pb-${slug}.env)`);
  process.exit(1);
}
const creds = readFileSync(credFile, 'utf8');
const pick = (k) => creds.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const PB = pick('PB_URL');
const EMAIL = pick('PB_ADMIN_EMAIL');
const PASS = pick('PB_ADMIN_PASS');
if (!PB || !EMAIL || !PASS) {
  console.error(`✖ plantillas: no credentials for ${slug} (~/.config/brotea/pb-${slug}.env)`);
  process.exit(1);
}

// Every call to the instance goes through here: a network failure would
// otherwise surface undici's error, whose cause names the host. We print the
// error code only, and never let a hung instance hold the seed forever.
const call = async (url, init = {}) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    console.error(`✖ plantillas: instance unreachable (${e.cause?.code ?? e.name})`);
    process.exit(1);
  }
};

// -- auth (superuser login is rate-limited: 2 per 3 s; retry on 429 only) -----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = '';
for (let attempt = 1; attempt <= 4; attempt++) {
  const r = await call(`${PB}/api/collections/_superusers/auth-with-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: EMAIL, password: PASS }),
  });
  if (r.status === 429 && attempt < 4) { await sleep(3500 * attempt); continue; }
  if (r.status >= 300) { console.error(`✖ plantillas: superuser auth failed (HTTP ${r.status})`); process.exit(1); }
  token = (await r.json()).token;
  break;
}
const H = { Authorization: token };
const HJ = { ...H, 'Content-Type': 'application/json' };
const COL = `${PB}/api/collections/plantillas/records`;

// -- current state --------------------------------------------------------------------
const listAll = async () => {
  const items = [];
  for (let page = 1; ; page++) {
    const r = await call(`${COL}?perPage=200&page=${page}&sort=clave`, { headers: H });
    if (r.status >= 300) { console.error(`✖ plantillas: list failed (HTTP ${r.status})`); process.exit(1); }
    const data = await r.json();
    items.push(...(data.items ?? []));
    if (page >= (data.totalPages ?? 1) || (data.items ?? []).length === 0) break;
  }
  return items;
};

const existing = await listAll();
const byClave = new Map();
for (const rec of existing) {
  if (byClave.has(rec.clave)) {
    console.error(`✖ plantillas: duplicate clave on the instance: ${rec.clave} (${byClave.get(rec.clave).id}, ${rec.id})`);
    process.exit(1);
  }
  byClave.set(rec.clave, rec);
}

// -- writes ---------------------------------------------------------------------------
const write = async (clave, method, url, body) => {
  const r = await call(url, { method, headers: HJ, body: JSON.stringify(body) });
  if (r.status >= 300) {
    const text = await r.text();
    console.error(`✖ plantillas: ${clave}: HTTP ${r.status} ${text.slice(0, 200)}`);
    process.exit(1);
  }
};

const contentDefaults = (row) => {
  const wa = row.canal === 'whatsapp';
  return { content_estado: wa ? 'unsubmitted' : '', content_estado_en: wa ? 'unsubmitted' : '' };
};

const counts = { created: 0, updated: 0, kept: 0 };
for (const row of rows) {
  const clave = row.clave;
  const current = byClave.get(clave);
  const say = (verb) => console.log(`plantillas: ${clave} ${verb}${suffix}`);

  if (!current) {
    if (!dryRun) await write(clave, 'POST', COL, { ...contentOf(row), estado: 'borrador', version: CATALOG_VERSION, ...contentDefaults(row) });
    counts.created++;
    say('created');
    continue;
  }
  if (!force) { counts.kept++; say('kept'); continue; }

  const instanceVersion = Number(current.version) || 0;
  if (instanceVersion > CATALOG_VERSION) { counts.kept++; say(`kept (instance v${instanceVersion} newer than catalog)`); continue; }
  if (sameContent(current, row)) { counts.kept++; say('kept'); continue; }
  // Same version, different text: writing it would make envios.plantilla_version
  // point at two bodies. The catalog has to say it changed.
  if (instanceVersion === CATALOG_VERSION) { counts.kept++; say('kept (content differs at the same version — bump CATALOG_VERSION)'); continue; }

  if (!dryRun) {
    await write(clave, 'PATCH', `${COL}/${current.id}`, {
      ...contentOf(row),
      version: CATALOG_VERSION,
      estado: 'borrador',
      content_sid: '', content_motivo: '',
      content_sid_en: '', content_motivo_en: '',
      ...contentDefaults(row),
    });
  }
  counts.updated++;
  say('updated');
}

// -- foreign rows: reported, never deleted --------------------------------------------
const known = new Set(rows.map((r) => r.clave));
for (const rec of existing) {
  if (!known.has(rec.clave)) console.log(`plantillas: ${rec.clave} foreign (not in catalog, left alone)`);
}

// -- summary --------------------------------------------------------------------------
const total = dryRun ? existing.length : (await listAll()).length;
console.log(`plantillas: ${total} rows on the instance`);
if (dryRun) console.log(`plantillas: dry-run would create ${counts.created}, update ${counts.updated}, keep ${counts.kept}`);
