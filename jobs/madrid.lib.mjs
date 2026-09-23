// madrid.lib.mjs — Europe/Madrid calendar arithmetic shared by the E6 jobs.
// Pure: no I/O. Every conversion goes through Intl.DateTimeFormat, never a
// fixed offset — a week that crosses a DST change still has seven local days,
// and "Friday 18:00" is 18:00 on the wall clock in March and in October.
import { esFecha, parseFecha } from './lib.mjs';

const TZ = 'Europe/Madrid';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});

/** Madrid wall-clock parts of an instant, or null when the date is unusable. dow: 0 = Sunday. */
export function madridParts(date) {
  const d = parseFecha(date);
  if (!esFecha(d)) return null;
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  return {
    year, month, day,
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    dow: DOW.indexOf(p.weekday),
    ymd: `${p.year}-${p.month}-${p.day}`,
  };
}

/**
 * The instant at which the Madrid wall clock reads y-m-d hh:mm. Two passes:
 * the offset of the first guess can differ from the offset at the answer when
 * the guess sits on the other side of a DST change.
 */
export function madridWallTime(y, m, d, hh = 0, mm = 0) {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const p = madridParts(new Date(t));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    t += target - seen;
  }
  return new Date(t);
}

/** 'YYYY-MM-DD' plus n calendar days (pure calendar arithmetic, no clock). */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the month before `ym` ('2026-01' → '2025-12'). */
export function previousMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Spanish month name of 'YYYY-MM' ('2026-09' → 'septiembre'). */
export const monthNameEs = (ym) => MONTHS_ES[Number(ym.split('-')[1]) - 1] ?? ym;
