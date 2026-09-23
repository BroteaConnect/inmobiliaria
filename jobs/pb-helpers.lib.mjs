// pb-helpers.lib.mjs — the small PocketBase reads and writes the E6 jobs share.
// The `.lib.mjs` suffix keeps the scheduler from running this file as a job.
//
// ctx.pb is a LIVE superuser client on production PocketBase, under --dry-run
// too (scripts/run-jobs.mjs says so in its header). So the one write here,
// writeMarker(), takes dryRun explicitly and refuses to write under it, and
// every read that is not essential to a job degrades to null instead of
// throwing: a rehearsal that crashes on a missing settings row fails a gate.

/** A PocketBase record id. Anything else never reaches a filter or a URL. */
export const RECORD_ID = /^[a-z0-9]+$/;
const SETTINGS_KEY = /^[a-z0-9._]+$/;

/**
 * Name of the on-duty agent: settings row `agentes.guardia` = { v: 1, text:
 * <users id> }. A copy of matcher.mjs's nombreDeGuardia (the matcher is left
 * untouched). Missing, broken or unreadable → null, logged under `tag`.
 */
export async function onDutyName(pb, log, tag) {
  try {
    const rows = await pb.collection('settings').getFullList({ filter: 'key = "agentes.guardia"' });
    const id = rows[0]?.value?.text;
    if (!id || !RECORD_ID.test(String(id))) return null;
    const user = await pb.collection('users').getOne(id);
    return user?.name || null;
  } catch (e) {
    log(`${tag}: on-duty agent unavailable: ${e?.message ?? e}`);
    return null;
  }
}

async function markerRow(pb, key) {
  if (!SETTINGS_KEY.test(key)) throw new Error(`not a settings key: ${key}`);
  const rows = await pb.collection('settings').getFullList({ filter: `key = "${key}"` });
  return rows[0] ?? null;
}

/** The `value` of the settings row `key`, or null when absent or on any error. */
export async function readMarker(pb, key) {
  try {
    return (await markerRow(pb, key))?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Create or update the settings row `key` with `value`. Under dryRun nothing
 * is read or written: it only logs `dry-run: would write <key>`.
 */
export async function writeMarker(pb, key, value, dryRun, log) {
  if (dryRun) {
    log(`dry-run: would write ${key}`);
    return;
  }
  const row = await markerRow(pb, key);
  if (row) {
    if (!RECORD_ID.test(String(row.id))) throw new Error(`settings ${key}: not a record id`);
    await pb.collection('settings').update(row.id, { value });
  } else {
    await pb.collection('settings').create({ key, value, note: 'Written by a scheduled job (docs/jobs.md).' });
  }
}
