// refusals.test.mjs — the three test classes that make the defect this module
// exists for unrepeatable:
//   1. a fuzz over codes NO table knows: every one of them must be `infra` and
//      must never be allowed to exclude a person;
//   2. the four tables are disjoint and every LEAD entry carries a reason;
//   3. the exclusion write exists in exactly ONE function of
//      jobs/campanas.lib.mjs, and that function asks mayExcludeLead() first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AMBIGUOUS_TABLE, INFRA_TABLE, LEAD_TABLE, RUN_TABLE, UNKNOWN_REASON,
  answerCode, classifyRefusal, mayExcludeLead, refusalCode,
} from './refusals.lib.mjs';

const TABLES = { lead: LEAD_TABLE, run: RUN_TABLE, infra: INFRA_TABLE, ambiguous: AMBIGUOUS_TABLE };
const known = new Set(Object.values(TABLES).flatMap((t) => Object.keys(t)));

// -- 1. the fuzz ------------------------------------------------------------
// A deterministic PRNG: a fuzz that cannot be replayed is an anecdote.
const rng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};

test('fuzz: 10 000 codes no table knows are infra, and none of them may exclude a lead', () => {
  const rand = rng(20260923);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  // Every shape a refusal has ever arrived in: a Twilio-looking number we
  // never tabulated, an HTML error page from whatever sits in front of the
  // chassis, a truncated JSON body, an empty string, a zero, a null.
  const shapes = [
    () => String(63000 + Math.floor(rand() * 999)),
    () => String(21000 + Math.floor(rand() * 999)),
    () => String(20000 + Math.floor(rand() * 999)),
    () => `error_${Math.floor(rand() * 1e6).toString(36)}`,
    () => '<html><head><title>502 Bad Gateway</title></head>',
    () => '{"error":"',
    () => '',
    () => null,
    () => undefined,
    () => 0,
    () => Math.floor(rand() * 1e9),
    () => ({ code: 'nested' }),
    () => ['array'],
    () => '   ',
    () => 'no_consent '.repeat(9), // long enough to be truncated, never the key
    () => '__proto__',
    () => 'constructor',
    () => 'toString',
  ];
  const statuses = [0, 100, 200, 301, 400, 401, 402, 403, 404, 405, 409, 410, 418, 422, 428, 431, 451, 500, 501, 502, 503, 504, 522, 599, null, undefined, NaN, -1, 99999];

  let checked = 0;
  for (let i = 0; i < 10_000; i++) {
    const code = pick(shapes)();
    const status = pick(statuses);
    const key = refusalCode({ code, status });
    // Only the pairs OUTSIDE the union of the tables are under test: an empty
    // code with status 429 legitimately resolves to the known `http_429`.
    if (known.has(key)) continue;
    const v = classifyRefusal({ code, status });
    assert.equal(v.bucket, 'infra', `${JSON.stringify(code)} / ${status} → ${v.bucket}`);
    assert.equal(v.known, false);
    assert.equal(v.reason, UNKNOWN_REASON);
    assert.equal(mayExcludeLead(v), false);
    assert.ok(v.code.length > 0 && v.code.length <= 60);
    checked++;
  }
  assert.ok(checked > 9000, `the fuzz has to actually fuzz: only ${checked} unknown pairs`);
});

test('no status range is ever a classifier: the same unknown code is infra at 4xx and at 5xx', () => {
  for (const status of [400, 401, 403, 404, 422, 429, 451, 500, 502, 503]) {
    const v = classifyRefusal({ code: 'nunca_visto', status });
    assert.equal(v.bucket, 'infra');
    assert.equal(mayExcludeLead(v), false);
  }
  // An unknown 4xx used to exclude a lead for ever and an unknown 5xx used to
  // become a never-retried unknown. Both are now the same retryable fault.
  assert.deepEqual(
    classifyRefusal({ code: 'x', status: 404 }),
    classifyRefusal({ code: 'x', status: 503 }),
  );
});

test('a code the classifier had to name itself: http_<status>, then sin_codigo', () => {
  assert.equal(refusalCode({ code: '', status: 418 }), 'http_418');
  assert.equal(refusalCode({ code: null, status: 0 }), 'sin_codigo');
  assert.equal(refusalCode({ code: undefined, status: undefined }), 'sin_codigo');
  assert.equal(refusalCode({}), 'sin_codigo');
  assert.equal(refusalCode({ code: '  21610  ' }), '21610');
  // http_429 IS a known infra key: a rate limit that arrives only as a status
  // must still be parked and retried.
  assert.equal(classifyRefusal({ code: '', status: 429 }).bucket, 'infra');
  assert.equal(classifyRefusal({ code: '', status: 429 }).known, true);
});

test('an HTML error page is never cleaned into a table key', () => {
  const v = classifyRefusal({ code: '<b>21610</b>', status: 403 });
  assert.equal(v.bucket, 'infra');
  assert.equal(v.known, false);
  assert.equal(mayExcludeLead(v), false);
});

test('the chassis answers of 2199027 land in their buckets', () => {
  const at = (status, body) => classifyRefusal({ code: answerCode(status, body), status });
  const structured = (code) => ({ ok: false, error: { code, text: 'x' } });
  // The auth gate (auth.js) and the campaign id check of feature 93: our request.
  assert.equal(at(403, structured('forbidden')).bucket, 'run');
  assert.equal(at(403, structured('secret_from_browser')).bucket, 'run');
  assert.equal(at(503, structured('auth_not_configured')).bucket, 'run');
  assert.equal(at(400, structured('campana_invalid')).bucket, 'run');
  // String errors are sentences: chassis_<status>, never the sentence as a code.
  for (const error of ['not configured', 'pocketbase not configured', 'smtp not configured']) {
    const v = at(503, { error });
    assert.deepEqual([v.code, v.bucket], ['chassis_503', 'run']);
  }
  assert.equal(at(400, { error: 'subject and text required' }).bucket, 'run');
  assert.equal(at(413, { error: 'body too large' }).bucket, 'run');
  // Email may already have left on these.
  assert.equal(at(502, { error: 'send failed', detail: 'x' }).bucket, 'ambiguous');
  assert.equal(at(500, { error: 'internal error' }).bucket, 'ambiguous');
  assert.equal(at(504, null).bucket, 'ambiguous');
  // WhatsApp's provider refusals come structured, with the Twilio code.
  assert.equal(at(502, structured('21211')).bucket, 'lead');
  assert.equal(at(502, structured('provider_unavailable')).bucket, 'ambiguous');
  assert.equal(at(502, structured('ledger_unavailable')).bucket, 'infra');
  // A lead with no email is a channel fact, never a consent write.
  assert.deepEqual([at(400, structured('no_email')).bucket, at(400, structured('no_email')).scope], ['lead', 'channel']);
  // A gateway page after the chassis died mid-request may follow a send: the
  // ledger decides next tick. A bodiless proxy 503 comes before the app: infra.
  assert.equal(at(502, null).code, 'http_502');
  assert.equal(at(502, '<html>Bad Gateway</html>').bucket, 'ambiguous');
  assert.equal(at(500, null).bucket, 'ambiguous');
  assert.equal(at(503, null).bucket, 'infra');
  // A 2xx that is not the chassis's ok:true (or could not be read) may be a send.
  for (const status of [200, 201, 202, 204]) assert.equal(at(status, null).bucket, 'ambiguous', String(status));
  assert.equal(at(200, { ok: false }).bucket, 'ambiguous');
  // A refused connection or an unresolvable host proves nothing left.
  assert.equal(classifyRefusal({ code: 'chassis_refused_connection' }).bucket, 'infra');
  assert.equal(classifyRefusal({ code: 'chassis_host_not_found' }).bucket, 'infra');
});

test('a string error never reaches the classifier as a code', () => {
  for (const error of ['21610', 'no_consent', 'consent_revoked', 'lead_unknown']) {
    const code = answerCode(403, { error });
    assert.equal(code, 'chassis_403');
    assert.equal(mayExcludeLead(classifyRefusal({ code, status: 403 })), false);
  }
  assert.equal(answerCode(400, ['no_consent']), '');
  assert.equal(answerCode(400, 'no_consent'), '');
});

test('an unknown structured code is infra at every status the chassis uses', () => {
  for (const status of [400, 401, 403, 404, 422, 451, 500, 502, 503]) {
    const v = classifyRefusal({ code: answerCode(status, { ok: false, error: { code: 'auth_token_required' } }), status });
    assert.equal(v.bucket, 'infra', String(status));
    assert.equal(mayExcludeLead(v), false);
  }
});

// -- 2. disjointness and shape ---------------------------------------------
test('the four tables share no key', () => {
  const seen = new Map();
  for (const [bucket, table] of Object.entries(TABLES)) {
    for (const key of Object.keys(table)) {
      assert.equal(seen.has(key), false, `${key} is in both ${seen.get(key)} and ${bucket}`);
      seen.set(key, bucket);
    }
  }
});

test('every LEAD entry has a scope and a non-empty reason, and classifies as lead', () => {
  const scopes = ['permanent', 'campaign', 'channel'];
  for (const [code, entry] of Object.entries(LEAD_TABLE)) {
    assert.ok(scopes.includes(entry.scope), `${code}: scope ${entry.scope}`);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length > 10, `${code}: reason too short to explain anything`);
    const v = classifyRefusal({ code });
    assert.equal(v.bucket, 'lead');
    assert.equal(v.known, true);
    assert.equal(v.scope, entry.scope);
    assert.equal(mayExcludeLead(v), true);
  }
});

test('every RUN, INFRA and AMBIGUOUS entry classifies into its own bucket and can never exclude', () => {
  for (const [bucket, table] of Object.entries(TABLES)) {
    if (bucket === 'lead') continue;
    for (const [code, reason] of Object.entries(table)) {
      const v = classifyRefusal({ code });
      assert.equal(v.bucket, bucket, `${code} should be ${bucket}`);
      assert.equal(v.known, true);
      assert.equal(v.reason, reason);
      assert.equal(mayExcludeLead(v), false);
    }
  }
});

test('the codes the SPEC pins are where the SPEC pins them', () => {
  // Each of these was, or could be, the bug. 63016 and variables_missing must
  // never cost a lead; 63049 must never cost a lead either; an unrecognised
  // auth answer must not be terminal.
  assert.equal(classifyRefusal({ code: '63016', status: 400 }).bucket, 'run');
  assert.equal(classifyRefusal({ code: 'variables_missing', status: 400 }).bucket, 'run');
  assert.equal(classifyRefusal({ code: '63049', status: 400 }).bucket, 'infra');
  assert.equal(classifyRefusal({ code: '21610', status: 400 }).bucket, 'lead');
  assert.equal(classifyRefusal({ code: '63024', status: 400 }).guarded, true);
  assert.equal(classifyRefusal({ code: 'no_consent', status: 422 }).guarded, false);
  assert.equal(classifyRefusal({ code: 'provider_unavailable', status: 502 }).bucket, 'ambiguous');
  assert.equal(classifyRefusal({ code: 'auth_token_required', status: 403 }).bucket, 'infra');
  assert.equal(classifyRefusal({ code: 'anything', answered: false }).bucket, 'ambiguous');
  assert.equal(classifyRefusal({ code: '21610', answered: false }).bucket, 'ambiguous');
});

test('the classifier holds no status range at all', () => {
  const src = readFileSync(new URL('./refusals.lib.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal(/status\s*[<>]=?\s*\d/.test(code), false, 'status is evidence, never a classifier');
  assert.equal(/\bstatus\b[^\n]*\b[45]00\b/.test(code), false);
});

// -- 3. single writer -------------------------------------------------------
test('the exclusion write lives in exactly one function, and that function asks mayExcludeLead first', () => {
  const src = readFileSync(new URL('./campanas.lib.mjs', import.meta.url), 'utf8');
  // The write is the only place that appends to informe.excluidos. Anything
  // else in the file may read it; nothing else may grow it.
  const writes = [...src.matchAll(/excluidos: \[\.\.\./g)];
  assert.equal(writes.length, 1, `${writes.length} places append to informe.excluidos`);
  const at = writes[0].index;
  const before = src.slice(0, at);
  const fn = [...before.matchAll(/export function (\w+)\(/g)].pop();
  assert.ok(fn, 'the exclusion write is not inside an exported function');
  assert.equal(fn[1], 'excludeLead');
  const body = src.slice(fn.index, at);
  assert.ok(body.includes('mayExcludeLead('), 'excludeLead() does not ask mayExcludeLead() before writing');
  // …and it asks FIRST: before anything else in the body runs.
  const guard = body.indexOf('mayExcludeLead(');
  const firstReturn = body.indexOf('return');
  assert.ok(guard < firstReturn || firstReturn === -1, 'the guard is not the first thing the function does');
});

test('the excluded state is also written only inside excludeLead, and the job never writes a lead', () => {
  const lib = readFileSync(new URL('./campanas.lib.mjs', import.meta.url), 'utf8');
  const sets = [...lib.matchAll(/state: 'excluded'/g)];
  assert.equal(sets.length, 1, `${sets.length} places set a recipient to excluded`);
  const fn = [...lib.slice(0, sets[0].index).matchAll(/export function (\w+)\(/g)].pop();
  assert.equal(fn[1], 'excludeLead');
  const job = readFileSync(new URL('./campanas.mjs', import.meta.url), 'utf8');
  assert.equal(/'excluded'|excluidos: \[/.test(job), false, 'the job excludes somebody by itself');
  assert.equal(/collection\('leads'\)\.(update|create|delete)/.test(job), false, 'the job writes a lead');
  assert.equal(/consentimiento/.test(job), false, 'the job touches consent');
});
