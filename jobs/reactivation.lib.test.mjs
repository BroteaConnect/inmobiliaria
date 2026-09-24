// reactivation.lib.test.mjs — the Monday reactivation proposal rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consentRevoked, dormantLeads, reactivationProposals, textReactivation } from './reactivation.lib.mjs';
import { MAX_LINES, MAX_MESSAGE_CHARS, PIE_CRM, normalizarLeads, vocabularioZonas } from './lib.mjs';

const NOW = new Date('2026-09-28T08:00:00.000Z'); // Monday 10:00 Madrid
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString().replace('T', ' ');
let seq = 0;
const lead = (over = {}) => ({
  id: `l${++seq}`, nombre: `Ana María ${seq}`, etapa: 'nutriendo', created: daysAgo(90), ultimo_contacto: daysAgo(40),
  consentimiento: true, consentimiento_en: daysAgo(90), criterios: 'Busco en Chamberí', ...over,
});

describe('dormantLeads', () => {
  it('31 days silent is dormant, 29 is not', () => {
    const a = lead({ ultimo_contacto: daysAgo(31) });
    const b = lead({ ultimo_contacto: daysAgo(29) });
    assert.deepEqual(dormantLeads([a, b], NOW).map((l) => l.id), [a.id]);
  });
  it('a deal in progress or done is not dormant', () => {
    const out = dormantLeads(['oferta', 'reservado', 'vendido', 'nuevo', 'nutriendo'].map((etapa) => lead({ etapa })), NOW);
    assert.deepEqual(out.map((l) => l.etapa), ['nuevo', 'nutriendo']);
  });
  it('an unknown date is dormant, and first', () => {
    const known = lead();
    const unknown = lead({ created: '', ultimo_contacto: '' });
    assert.deepEqual(dormantLeads([known, unknown], NOW).map((l) => l.id), [unknown.id, known.id]);
  });
  it('a revoked consent is out; a never-given one stays', () => {
    const revoked = lead({ consentimiento: false });
    const never = lead({ consentimiento: false, consentimiento_en: '' });
    assert.equal(consentRevoked(revoked), true);
    assert.equal(consentRevoked(never), false);
    assert.deepEqual(dormantLeads([revoked, never], NOW).map((l) => l.id), [never.id]);
  });
  it('a lead with any recent activity (an inbound too) is not dormant', () => {
    const wrote = lead();
    const silent = lead();
    const out = dormantLeads([wrote, silent], NOW, { activeLeadIds: new Set([wrote.id]) });
    assert.deepEqual(out.map((l) => l.id), [silent.id]);
  });
  it('falls back to created when never contacted', () => {
    const l = lead({ ultimo_contacto: '', created: daysAgo(45) });
    assert.equal(dormantLeads([l], NOW).length, 1);
  });
});

describe('reactivationProposals', () => {
  const chamberi = { id: 'p1', titulo: 'Piso en Chamberí', municipio: 'Chamberí', estado: 'publicada', precio: 300000, habitaciones: 2 };
  const chamberi2 = { id: 'p2', titulo: 'Ático en Chamberí', municipio: 'Chamberí', estado: 'publicada', precio: 900000, habitaciones: 4 };
  const retiro = { id: 'p3', titulo: 'Retiro', municipio: 'Retiro', estado: 'publicada', precio: 1, habitaciones: 1 };
  const props = [chamberi, chamberi2, retiro];
  const norm = (leads) => normalizarLeads(leads, vocabularioZonas(props));

  it('keeps the best property per lead and counts the fits', () => {
    const l = lead({ criterios: 'Chamberí, hasta 400.000, 2 habitaciones' });
    const [p] = reactivationProposals(props, norm([l]));
    assert.equal(p.property.id, 'p1');
    assert.equal(p.fits, 2);
    assert.ok(p.motivos.includes('encaja en presupuesto'));
  });
  it('a lead that fits nothing is not proposed', () => {
    assert.deepEqual(reactivationProposals(props, norm([lead({ criterios: 'Getafe' })])), []);
  });
  it('best score first, then the longest silence', () => {
    const vague = lead({ criterios: 'Chamberí, hasta 50.000' }); // loses the budget point
    const exact = lead({ criterios: 'Retiro' });
    const out = reactivationProposals(props, norm([vague, exact]));
    assert.deepEqual(out.map((p) => p.lead.id), [exact.id, vague.id]);
  });
});

describe('textReactivation', () => {
  const p = { id: 'p1', titulo: 'Piso <grande>' };
  const prop = (over = {}) => ({ lead: lead(), property: p, score: 5, motivos: ['zona chamberi'], fits: 1, ...over });
  it('is null when nobody fits', () => {
    assert.equal(textReactivation([], null, NOW), null);
  });
  it('first name only, escaped title, extra fits, agent, silence, consent mark', () => {
    const t = textReactivation([
      prop({ fits: 3, lead: lead({ nombre: 'Ana María López', expand: { asignado: { name: 'Luis' } } }) }),
      prop({ lead: lead({ nombre: 'Juan', consentimiento: false, consentimiento_en: '' }) }),
    ], 'Marta', NOW);
    assert.match(t, /^💤 <b>Reactivación<\/b> — 2 leads dormidos encajan con el stock publicado:/);
    assert.match(t, /• <b>Ana<\/b> · Piso &lt;grande&gt; \(\+2\) · zona chamberi · Luis · último contacto hace 40 días · ✅ consentimiento/);
    assert.match(t, /• <b>Juan<\/b> · .* · Marta \(guardia\) · .* · 🚫 sin consentimiento/);
    assert.doesNotMatch(t, /López/);
    assert.ok(t.endsWith(`Propuesta para llamar: no se ha enviado nada a los leads.\n${PIE_CRM}`));
  });
  it('never exceeds the Telegram limit', () => {
    const t = textReactivation(Array.from({ length: 10 }, () => prop({ motivos: ['z'.repeat(1000)] })), null, NOW);
    assert.ok(t.length <= MAX_MESSAGE_CHARS);
    assert.match(t, /^💤/);
  });
  it('caps the list', () => {
    const t = textReactivation(Array.from({ length: MAX_LINES + 2 }, () => prop()), null, NOW);
    assert.match(t, /… y 2 más/);
    assert.match(t, /sin asignar/);
  });
});
