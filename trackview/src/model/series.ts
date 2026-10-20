import type { Units } from '../settings';
import type { Track } from './types';
import { eleUnit, eleValue, speedUnit, speedValue } from './units';

const SMOOTH = 5; // moving-average window for display only

export type ChartMode = 'speed' | 'ele' | 'none';

export interface ChartSeries {
  mode: ChartMode;
  unit: string;
  /** Smoothed values in display units, aligned with the track points (NaN = gap). */
  ys: number[];
}

/** What the speed chart shows: speed, else elevation, else nothing (§7.4). */
export function chartSeries(track: Track, units: Units): ChartSeries {
  const mode: ChartMode = track.hasSpeed ? 'speed' : track.hasEle ? 'ele' : 'none';
  if (mode === 'none') return { mode, unit: '', ys: [] };
  const raw = mode === 'speed' ? track.speed : track.ele;
  const conv = mode === 'speed' ? (v: number) => speedValue(v, units) : (v: number) => eleValue(v, units);
  const ys: number[] = new Array(track.n);
  const half = Math.floor(SMOOTH / 2);
  for (let i = 0; i < track.n; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(track.n - 1, i + half); k++) {
      if (track.seg[k] === track.seg[i] && Number.isFinite(raw[k])) { sum += raw[k]; cnt++; }
    }
    ys[i] = cnt ? conv(sum / cnt) : NaN;
  }
  return { mode, unit: mode === 'speed' ? speedUnit(units) : eleUnit(units), ys };
}
