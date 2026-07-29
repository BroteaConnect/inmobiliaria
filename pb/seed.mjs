#!/usr/bin/env node
// seed.mjs — demo data for the inmobiliaria PocketBase. Idempotent: looks up
// by natural key (email/nombre/titulo) before creating. Run from anywhere:
// node projects/inmobiliaria/pb/seed.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const creds = readFileSync(join(homedir(), '.config', 'brotea', 'pb-inmobiliaria.env'), 'utf8');
const pick = (k) => creds.match(new RegExp(`^${k}=(.*)$`, 'm'))[1];
const PB = pick('PB_URL');

const auth = await fetch(`${PB}/api/collections/_superusers/auth-with-password`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identity: pick('PB_ADMIN_EMAIL'), password: pick('PB_ADMIN_PASS') }),
}).then((r) => r.json());
const H = { Authorization: auth.token };
const HJ = { ...H, 'Content-Type': 'application/json' };
const q = (s) => encodeURIComponent(s);

const findOne = async (col, filter) =>
  (await fetch(`${PB}/api/collections/${col}/records?filter=${q(filter)}&perPage=1`, { headers: H })
    .then((r) => r.json())).items?.[0];

const create = async (col, body) => {
  const r = await fetch(`${PB}/api/collections/${col}/records`, {
    method: 'POST',
    headers: body instanceof FormData ? H : HJ,
    body: body instanceof FormData ? body : JSON.stringify(body),
  });
  const data = await r.json();
  if (r.status >= 300) { console.error(`✖ ${col}: ${JSON.stringify(data).slice(0, 200)}`); process.exit(1); }
  return data;
};

// -- CRM user ---------------------------------------------------------------------
const userFile = join(homedir(), '.config', 'brotea', 'inmobiliaria-crm-user.env');
const userEmail = 'intermediaria@brotea.dev';
if (!(await findOne('users', `email='${userEmail}'`))) {
  const pass = existsSync(userFile)
    ? readFileSync(userFile, 'utf8').match(/^CRM_PASS=(.*)$/m)[1]
    : randomBytes(12).toString('base64url');
  if (!existsSync(userFile)) {
    writeFileSync(userFile, `CRM_URL=https://crm-inmobiliaria.brotea.dev\nCRM_EMAIL=${userEmail}\nCRM_PASS=${pass}\n`, { mode: 0o600 });
  }
  await create('users', { email: userEmail, password: pass, passwordConfirm: pass, name: 'Intermediaria', emailVisibility: true });
  console.log(`+ usuaria CRM (${userEmail}; credenciales en ${userFile})`);
} else console.log('= usuaria CRM existe');

// -- propietarios --------------------------------------------------------------------
const OWNERS = [
  { nombre: 'Carmen Ruiz', telefono: '+34 600 111 222', email: 'carmen@example.com', notas: 'Vende el piso de su madre. Prefiere llamadas por la tarde.' },
  { nombre: 'Familia Ortega', telefono: '+34 600 333 444', email: 'ortega@example.com', notas: 'Chalet heredado, hay que vaciar el trastero.' },
  { nombre: 'Luis Andrade', telefono: '+34 600 555 666', email: 'luis@example.com', notas: 'Inversor; tiene dos pisos más que sacará este año.' },
];
const ownerId = {};
for (const o of OWNERS) {
  let rec = await findOne('propietarios', `nombre='${o.nombre}'`);
  if (!rec) { rec = await create('propietarios', o); console.log(`+ propietario ${o.nombre}`); }
  ownerId[o.nombre] = rec.id;
}

// -- propiedades (con foto SVG generada) -----------------------------------------------
const svgFoto = (label, c1, c2) => new Blob([`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600" viewBox="0 0 900 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="900" height="600" fill="url(#g)"/>
  <g fill="none" stroke="#ffffff" stroke-width="14" stroke-linejoin="round" opacity="0.9">
    <path d="M270 340 L450 200 L630 340"/>
    <rect x="320" y="340" width="260" height="160"/>
    <rect x="420" y="400" width="60" height="100" fill="#ffffff" opacity="0.65" stroke="none"/>
  </g>
  <text x="450" y="560" font-family="sans-serif" font-size="34" fill="#ffffff" text-anchor="middle" opacity="0.9">${label}</text>
</svg>`], { type: 'image/svg+xml' });

const PROPS = [
  { titulo: 'Piso luminoso en Lavapiés', municipio: 'Madrid', precio: 289000, habitaciones: 2, banos: 1, superficie: 72, estado: 'publicada', propietario: 'Carmen Ruiz', c: ['#5F60D9', '#09092D'], descripcion: 'Segunda planta exterior, reformado en 2021, junto al metro. Ideal primera vivienda.' },
  { titulo: 'Chalet con jardín en Las Rozas', municipio: 'Las Rozas', precio: 545000, habitaciones: 4, banos: 3, superficie: 210, estado: 'publicada', propietario: 'Familia Ortega', c: ['#E24E87', '#330A0F'], descripcion: 'Parcela de 400 m², piscina comunitaria, garaje doble. A 5 min de la estación.' },
  { titulo: 'Ático con terraza en Chamberí', municipio: 'Madrid', precio: 620000, habitaciones: 3, banos: 2, superficie: 110, estado: 'publicada', propietario: 'Luis Andrade', c: ['#2BA26B', '#022922'], descripcion: 'Terraza de 30 m² orientación sur, ascensor, finca clásica rehabilitada.' },
  { titulo: 'Estudio junto a la universidad', municipio: 'Getafe', precio: 139000, habitaciones: 1, banos: 1, superficie: 38, estado: 'borrador', propietario: 'Luis Andrade', c: ['#E4A126', '#332005'], descripcion: 'Alquilado hasta septiembre; perfecto para inversión.' },
  { titulo: 'Bajo con patio en Carabanchel', municipio: 'Madrid', precio: 198000, habitaciones: 2, banos: 1, superficie: 65, estado: 'borrador', propietario: 'Carmen Ruiz', c: ['#0891b2', '#082f49'], descripcion: 'Patio privado de 20 m², necesita actualización de cocina.' },
];
const propId = {};
for (const p of PROPS) {
  let rec = await findOne('propiedades', `titulo='${p.titulo}'`);
  if (!rec) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(p)) {
      if (k === 'c') continue;
      fd.append(k, k === 'propietario' ? ownerId[v] : String(v));
    }
    fd.append('fotos', svgFoto(p.municipio, p.c[0], p.c[1]), `${p.titulo.slice(0, 12).replaceAll(' ', '-')}.svg`);
    rec = await create('propiedades', fd);
    console.log(`+ propiedad ${p.titulo}`);
  }
  propId[p.titulo] = rec.id;
}

// -- leads + actividad -----------------------------------------------------------------
const LEADS = [
  { nombre: 'Marta Vidal', telefono: '+34 611 222 333', email: 'marta@example.com', mensaje: 'Me encaja el piso de Lavapiés, ¿puedo verlo el sábado?', propiedad: 'Piso luminoso en Lavapiés', etapa: 'visita', origen: 'web' },
  { nombre: 'Jorge y Ana', telefono: '+34 622 333 444', email: 'jorgeyana@example.com', mensaje: 'Buscamos chalet con jardín, presupuesto 550k.', propiedad: 'Chalet con jardín en Las Rozas', etapa: 'contactado', origen: 'web' },
  { nombre: 'Isabel Ferrer', telefono: '+34 633 444 555', email: '', mensaje: 'Vi el cartel del ático. Llamadme por la mañana.', propiedad: 'Ático con terraza en Chamberí', etapa: 'nuevo', origen: 'cartel' },
];
for (const l of LEADS) {
  if (await findOne('leads', `nombre='${l.nombre}'`)) continue;
  const rec = await create('leads', { ...l, propiedad: propId[l.propiedad] });
  console.log(`+ lead ${l.nombre} (${l.etapa})`);
  if (l.etapa !== 'nuevo') {
    await create('actividades', { lead: rec.id, tipo: 'llamada', nota: 'Primer contacto: interesada, quedamos en concretar visita.' });
  }
}
console.log('SEED OK');
