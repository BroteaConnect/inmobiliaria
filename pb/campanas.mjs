#!/usr/bin/env node
// campanas.mjs — seeds the campaign catalog (pb/campanas.json) into the
// PocketBase `campanas` collection, keyed by `nombre`. CREATE-ONLY: a row that
// already exists is never patched, so a reseed can never rewrite, re-arm or
// reset a campaign a human has moved on (that is the whole point of estados).
//
//   node pb/campanas.mjs [--slug inmobiliaria] [--dry-run]
//
// One line per catalog row: `campanas: <nombre> created|kept`. The catalog is
// validated by catalogProblems() (jobs/campanas.lib.mjs) BEFORE credentials
// are read: exactly one CU-15 and it is borrador; any other row may only name
// TEST_LEAD_IDS. Each template key is resolved to its record id on the
// instance; an unknown clave fails the seed before any write. A CU-15 row is
// never created while ANY existing row carries the marker (seedPlan()).
// Exit codes: 0 ok, 1 instance/credentials error, 2 catalog invalid, 64 usage.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { catalogProblems, seedPlan } from '../jobs/campanas.lib.mjs';

const USAGE = 'usage: node pb/campanas.mjs [--slug <slug>] [--dry-run]';
const fail = (code, msg) => { console.error(`✖ campanas: ${msg}`); process.exit(code); };

const argv = process.argv.slice(2);
let slug = 'inmobiliaria';
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dry-run') dryRun = true;
  else if (argv[i] === '--slug' && argv[i + 1] && !argv[i + 1].startsWith('--')) slug = argv[++i];
  else fail(64, `unknown or incomplete flag ${argv[i]}\n${USAGE}`);
}

const rows = JSON.parse(readFileSync(new URL('./campanas.json', import.meta.url), 'utf8'));
const problems = catalogProblems(rows);
if (problems.length) fail(2, problems.join('; '));

// -- credentials (never printed), read like pb/plantillas.mjs ---------------------
const credFile = join(homedir(), '.config', 'brotea', `pb-${slug}.env`);
if (!existsSync(credFile)) fail(1, `no credentials for ${slug}`);
const creds = readFileSync(credFile, 'utf8');
const pick = (k) => creds.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim();
const [PB, EMAIL, PASS] = ['PB_URL', 'PB_ADMIN_EMAIL', 'PB_ADMIN_PASS'].map(pick);
if (!PB || !EMAIL || !PASS) fail(1, `no credentials for ${slug}`);

const call = async (path, init = {}) => {
  let r;
  try {
    r = await fetch(`${PB}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    fail(1, `instance unreachable (${e.cause?.code ?? e.name})`);
  }
  if (r.status >= 300) fail(1, `${init.method ?? 'GET'} ${path.split('?')[0]} → HTTP ${r.status}`);
  return r.json();
};

const { token } = await call('/api/collections/_superusers/auth-with-password', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identity: EMAIL, password: PASS }),
});
const H = { Authorization: token, 'Content-Type': 'application/json' };
// Paged: a truncated first page would make an existing row look missing.
const list = async (col) => {
  const items = [];
  for (let page = 1; ; page++) {
    const data = await call(`/api/collections/${col}/records?perPage=200&page=${page}`, { headers: H });
    items.push(...(data.items ?? []));
    if (page >= (data.totalPages ?? 1) || !(data.items ?? []).length) return items;
  }
};

const existing = await list('campanas');
const templateIds = new Map((await list('plantillas')).map((p) => [p.clave, p.id]));
const unknown = rows.filter((r) => !templateIds.has(r.plantilla)).map((r) => r.plantilla);
if (unknown.length) fail(2, `plantilla clave not on the instance: ${unknown.join(', ')} (seed pb/plantillas.mjs first)`);

const plan = seedPlan(rows, existing);
const refused = plan.filter((p) => p.action === 'refuse').map((p) => p.row.nombre);
if (refused.length) fail(2, `a CU-15 row already exists on the instance; refusing to create ${refused.join(', ')}`);
for (const { row, action } of plan) {
  if (action === 'keep') { console.log(`campanas: ${row.nombre} kept${dryRun ? ' (dry-run)' : ''}`); continue; }
  const body = { ...row, plantilla: templateIds.get(row.plantilla) };
  if (!dryRun) await call('/api/collections/campanas/records', { method: 'POST', headers: H, body: JSON.stringify(body) });
  console.log(`campanas: ${row.nombre} created${dryRun ? ' (dry-run)' : ''}`);
}
