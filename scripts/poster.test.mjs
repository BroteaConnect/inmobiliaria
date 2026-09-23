// The poster's contract: which leads count as poster leads, the URL a QR
// sends a phone to, and a QR the E6 gate (and a scanner) can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadOrigin, posterTarget, qrSvg } from '../src/lib/poster.mjs';

const SITE = 'https://inmobiliaria.brotea.dev';
const ID = 'oqv58oyqx44q6vs';

/** The gate's rule: <rect> elements plus M/m commands inside every d attribute. */
const modules = (svg) => (svg.match(/<rect\b/g) || []).length
  + [...svg.matchAll(/\bd="([^"]*)"/g)].reduce((n, d) => n + (d[1].match(/[Mm]/g) || []).length, 0);

test('leadOrigin: only origen=cartel is a poster lead', () => {
  assert.equal(leadOrigin('?origen=cartel'), 'cartel');
  assert.equal(leadOrigin('origen=cartel'), 'cartel');
  assert.equal(leadOrigin('?x=1&origen=cartel'), 'cartel');
  for (const s of ['', '?origen=Cartel', '?origen=web', '?origen=<script>', '?origen=cartel2', undefined]) {
    assert.equal(leadOrigin(s), 'web', String(s));
  }
});

test('posterTarget: the property page per language, marked origen=cartel', () => {
  assert.equal(posterTarget(SITE, 'es', ID), `${SITE}/propiedad/${ID}?origen=cartel`);
  assert.equal(posterTarget(SITE, 'en', ID), `${SITE}/en/propiedad/${ID}?origen=cartel`);
  assert.equal(posterTarget(new URL(SITE), 'en', ID, 'es'), `${SITE}/en/propiedad/${ID}?origen=cartel`);
});

test('qrSvg: an inline, themeable, accessible QR the gate can read', () => {
  const target = posterTarget(SITE, 'en', ID);
  const svg = qrSvg(target, 'QR "code" <here>');
  assert.ok(svg.startsWith('<svg'));
  const m = svg.match(/<svg\b[^>]*\bdata-qr="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/);
  assert.ok(m, 'has <svg data-qr="…">…</svg>');
  assert.equal(m[1], target);
  assert.ok(m[1].includes(`/propiedad/${ID}?origen=cartel`));
  const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(vb && vb[1] === vb[2], 'square viewBox');
  assert.ok(Number(vb[1]) >= 21 + 8, 'at least a version-1 code plus the quiet zone');
  assert.match(svg, /fill="currentColor"/);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="QR &quot;code&quot; &lt;here&gt;"/);
  assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b/i, 'no literal colour');
  assert.ok(modules(m[2]) >= 20, `≥ 20 modules by the gate's rule (got ${modules(m[2])})`);
  assert.equal(qrSvg(target, 'x'), qrSvg(target, 'x'), 'deterministic');
});

test('qrSvg: data-qr is attribute-escaped', () => {
  const svg = qrSvg('https://x.test/?a=1&b="2"', 'x');
  assert.match(svg, /data-qr="https:\/\/x\.test\/\?a=1&amp;b=&quot;2&quot;"/);
});
