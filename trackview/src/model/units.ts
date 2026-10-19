import type { Units } from '../settings';

const KM_PER_MI = 1.609344;
const FT_PER_M = 3.28084;

export const speedUnit = (u: Units) => (u === 'metric' ? 'km/h' : 'mph');
export const distUnit = (u: Units) => (u === 'metric' ? 'km' : 'mi');
export const eleUnit = (u: Units) => (u === 'metric' ? 'm' : 'ft');

/** m/s → km/h or mph */
export function speedValue(ms: number, u: Units): number {
  const kmh = ms * 3.6;
  return u === 'metric' ? kmh : kmh / KM_PER_MI;
}

/** metres → km or mi */
export function distValue(m: number, u: Units): number {
  return u === 'metric' ? m / 1000 : m / 1000 / KM_PER_MI;
}

/** metres → m or ft */
export function eleValue(m: number, u: Units): number {
  return u === 'metric' ? m : m * FT_PER_M;
}

export const fmt = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/** ms → HH:MM:SS (hours may exceed 99). */
export function hms(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--:--';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** ms → "11 h 47 min", "2 min 5 s", "36 s" */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

export function latLonText(lat: number, lon: number): [string, string] {
  return [
    `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}`,
    `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`,
  ];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local clock time of the PC, e.g. "15:45:30 · 31 Aug 2026". */
export function clockText(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${time} · ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
