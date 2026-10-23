import { sampleAt } from '../model/interpolate';
import type { Track } from '../model/types';
import type { SmartZoomSettings } from '../settings';
import { SmartZoom, ZOOM_LIMITS } from './smartzoom';

// Zoom curve (§16): the smart zoom of a whole track, computed once as a few control points the user can drag.
// While it exists, the follow camera and the video read the zoom from it instead of computing it per frame.

export interface ZoomKnot {
  pos: number; // playback timeline, ms
  z: number;
}

export interface ZoomCurve {
  knots: ZoomKnot[]; // sorted by pos; the first is at 0, the last at the track duration
  rate: number; // playback rate the auto curve was computed for
  edited: boolean;
}

const SIM_DT = 0.1; // simulation step, screen seconds
const MAX_STEPS = 20_000;
const MAX_KNOTS = 60;
const START_TOLERANCE = 0.1; // zoom levels

/** Smart zoom as it would play at `rate` (rate limit, dead band, rate widening), every 0.1 s of screen time. */
export function simulateZoom(track: Track, rate: number, widthPx: number, sz: SmartZoomSettings): { xs: number[]; zs: number[] } | null {
  const dur = track.stats.duration;
  if (!(dur > 0)) return null;
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.ceil(dur / (rate * SIM_DT * 1000))));
  const dt = dur / steps / (rate * 1000);
  const smart = new SmartZoom();
  const xs: number[] = [];
  const zs: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const pos = (k / steps) * dur;
    const z = smart.update(track, pos, rate, dt, widthPx, sz);
    if (!Number.isFinite(z)) return null;
    xs.push(pos);
    zs.push(z);
  }
  return { xs, zs };
}

/** The simulated smart zoom reduced to at most 60 control points. */
export function autoCurve(track: Track, rate: number, widthPx: number, sz: SmartZoomSettings): ZoomCurve | null {
  const sim = simulateZoom(track, rate, widthPx, sz);
  if (!sim) return null;
  const { xs, zs } = sim;
  let tol = START_TOLERANCE;
  let keep = simplify(xs, zs, tol);
  while (keep.length > MAX_KNOTS) keep = simplify(xs, zs, (tol *= 1.5));
  return { knots: keep.map((i) => ({ pos: xs[i], z: round2(zs[i]) })), rate, edited: false };
}

const round2 = (z: number) => Math.round(z * 100) / 100;

/** Douglas–Peucker on the vertical error; returns the kept indices in order. */
function simplify(xs: number[], ys: number[], tol: number): number[] {
  const n = xs.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, err = tol;
    for (let i = a + 1; i < b; i++) {
      const f = (xs[i] - xs[a]) / (xs[b] - xs[a] || 1);
      const e = Math.abs(ys[i] - (ys[a] + (ys[b] - ys[a]) * f));
      if (e > err) { err = e; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Zoom at a position: straight lines between the knots, flat outside them. Linear matches the computed curve,
 * whose ramps are the follower's constant 0.5 level/s (a smooth spline bends them into an S), and dragging a
 * point moves only the two lines next to it.
 */
export function curveAt(knots: ZoomKnot[], pos: number): number {
  const n = knots.length;
  if (!n) return NaN;
  if (pos <= knots[0].pos || n === 1) return knots[0].z;
  if (pos >= knots[n - 1].pos) return knots[n - 1].z;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid].pos <= pos) lo = mid;
    else hi = mid;
  }
  const a = knots[lo], b = knots[hi];
  const h = b.pos - a.pos;
  if (!(h > 0)) return b.z;
  return a.z + ((b.z - a.z) * (pos - a.pos)) / h;
}

export const clampZoom = (z: number) => Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, z));

// ---------- Saved edits (per file) ----------
// Knots are stored by recorded time (ms after the first point), so they survive rebuilds that change the
// playback timeline (skip pauses, pause threshold, spike filter).

const KEY = 'trackview.zoomcurves.v1';
const MAX_FILES = 30;

interface Stored {
  savedAt: number;
  rate: number;
  knots: [number, number][]; // [ms after the first point, zoom]
}

export function curveKey(track: Track): string {
  return `${track.fileName}|${track.t[0]}`;
}

function readAll(): Record<string, Stored> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Stored>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Stored>): void {
  try {
    const keys = Object.keys(all).sort((a, b) => all[b].savedAt - all[a].savedAt);
    for (const k of keys.slice(MAX_FILES)) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: edits last for this session only */
  }
}

/** Playback position → ms after the first recorded point. */
function toClock(track: Track, pos: number): number {
  return sampleAt(track, pos).clock - track.t[0];
}

/** ms after the first recorded point → playback position. */
function fromClock(track: Track, ms: number): number {
  const t = track.t[0] + ms;
  const a = track.t;
  if (t <= a[0]) return 0;
  if (t >= a[track.n - 1]) return track.playT[track.n - 1];
  let lo = 0, hi = track.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = a[hi] - a[lo];
  const f = span > 0 ? (t - a[lo]) / span : 0;
  return track.playT[lo] + (track.playT[hi] - track.playT[lo]) * f;
}

export function saveCurve(track: Track, curve: ZoomCurve): void {
  const all = readAll();
  all[curveKey(track)] = { savedAt: Date.now(), rate: curve.rate, knots: curve.knots.map((k) => [toClock(track, k.pos), k.z]) };
  writeAll(all);
}

export function forgetCurve(track: Track): void {
  const all = readAll();
  if (!(curveKey(track) in all)) return;
  delete all[curveKey(track)];
  writeAll(all);
}

/** The saved edited curve for this file, mapped onto the current playback timeline. */
export function loadCurve(track: Track): ZoomCurve | null {
  const s = readAll()[curveKey(track)];
  if (!s || !Array.isArray(s.knots) || s.knots.length < 2) return null;
  const knots = s.knots.map(([ms, z]) => ({ pos: fromClock(track, ms), z: clampZoom(z) })).sort((a, b) => a.pos - b.pos);
  knots[0].pos = 0;
  knots[knots.length - 1].pos = track.stats.duration;
  // Knots that collapsed onto one position (inside a now-skipped pause) keep only the last.
  const out = knots.filter((k, i) => i === knots.length - 1 || knots[i + 1].pos > k.pos);
  return { knots: out, rate: s.rate, edited: true };
}
