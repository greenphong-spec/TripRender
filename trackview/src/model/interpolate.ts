import { bearing } from './geo';
import type { Pause, Track } from './types';

export interface Sample {
  /** Index of the point at or before the position, and the fraction towards index + 1. */
  i: number;
  f: number;
  lat: number;
  lon: number;
  ele: number; // NaN if unknown
  dist: number;
  speed: number; // m/s; NaN if unknown
  clock: number; // epoch ms; NaN if untimed
  bearing: number; // degrees; NaN if unknown
  pause: Pause | null;
}

/** Largest i with playT[i] <= pos. */
export function indexAt(track: Track, pos: number): number {
  const a = track.playT;
  let lo = 0;
  let hi = track.n - 1;
  if (pos <= a[0]) return 0;
  if (pos >= a[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function headingAt(track: Track, i: number): number {
  if (Number.isFinite(track.course[i])) return track.course[i];
  // Look ahead (then back) for a point that is actually somewhere else.
  for (let j = i + 1; j < Math.min(track.n, i + 20) && track.seg[j] === track.seg[i]; j++) {
    if (track.lat[j] !== track.lat[i] || track.lon[j] !== track.lon[i]) {
      return bearing(track.lat[i], track.lon[i], track.lat[j], track.lon[j]);
    }
  }
  for (let j = i - 1; j >= Math.max(0, i - 20) && track.seg[j] === track.seg[i]; j--) {
    if (track.lat[j] !== track.lat[i] || track.lon[j] !== track.lon[i]) {
      return bearing(track.lat[j], track.lon[j], track.lat[i], track.lon[i]);
    }
  }
  return NaN;
}

export function sampleAt(track: Track, pos: number): Sample {
  const i = indexAt(track, pos);
  const j = Math.min(i + 1, track.n - 1);
  const span = track.playT[j] - track.playT[i];
  const f = i === j || span <= 0 ? 0 : Math.min(1, Math.max(0, (pos - track.playT[i]) / span));

  // Inside a pause the marker holds at the last point before it (and jumps across segment breaks).
  const pause = i !== j && f > 0 && f < 1 ? findPause(track, i) : null;
  const g = pause ? 0 : f;

  return {
    i,
    f,
    lat: lerp(track.lat[i], track.lat[j], g),
    lon: lerp(track.lon[i], track.lon[j], g),
    ele: lerp(track.ele[i], track.ele[j], g),
    dist: lerp(track.dist[i], track.dist[j], g),
    speed: pause && track.hasSpeed ? 0 : lerp(track.speed[i], track.speed[j], f),
    clock: lerp(track.t[i], track.t[j], f),
    bearing: headingAt(track, i),
    pause,
  };
}

function findPause(track: Track, i: number): Pause | null {
  const ps = track.pauses;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ps[mid].index === i) return ps[mid];
    if (ps[mid].index < i) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}
