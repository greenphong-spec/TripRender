import { sampleAt } from '../model/interpolate';
import type { Track } from '../model/types';
import type { SmartZoomSettings } from '../settings';
import { isMoving } from './camera';

// Smart zoom (§15): zoom from the smoothed speed, between a near and a far zoom. Pure, so it is unit-tested;
// times are screen seconds on the live map and video seconds in the export.

const EARTH_M = 40_075_016.686;
const TILE_PX = 512; // MapLibre tile size: metres per pixel = EARTH · cos(lat) / (512 · 2^zoom)
const SPEED_HALF_SEC = 8; // speed window: ±8 s (§15.3)
const LOOK_AHEAD_SEC = 2; // window shifted forward
const SPEED_HALF_MAX_MS = 30_000; // at most ±30 s of track time, so city stop-and-go still shows at ×10
const LOOK_AHEAD_MAX_MS = 7_500;
const STEPS = 8; // window samples on each side
const MAX_SCREEN_FRACTION = 0.5; // the vehicle crosses at most ½ map width per second (§15.4)
const MAX_RATE = 0.5; // zoom levels per second
const ACCEL = 1; // zoom levels per second², for ease-in
const DEAD_BAND = 0.25;
const MIN_SLOW_KMH = 5;
export const ZOOM_LIMITS = { min: 3, max: 20 };

/** Auto slow / fast speeds (km/h): ½× and 2× the track's average moving speed. Null without speed data. */
export function autoSpeeds(avgMs: number | null): { slow: number; fast: number } | null {
  if (avgMs === null || !(avgMs > 0)) return null;
  const avg = avgMs * 3.6;
  const slow = Math.max(MIN_SLOW_KMH, Math.round(avg / 2));
  return { slow, fast: Math.max(slow + 1, Math.round(avg * 2)) };
}

/** Slow / fast speeds in use (custom values win over Auto). */
export function speedRange(sz: SmartZoomSettings, avgMs: number | null): { slow: number; fast: number } | null {
  const auto = autoSpeeds(avgMs);
  const slow = sz.slowKmh ?? auto?.slow;
  const fast = sz.fastKmh ?? auto?.fast;
  return slow === undefined || fast === undefined ? null : { slow, fast };
}

/** Speed → zoom: Near below the slow speed, Far above the fast speed, log-interpolated between. */
export function curveZoom(kmh: number, near: number, far: number, slow: number, fast: number): number {
  if (!(kmh > slow)) return near;
  if (kmh >= fast) return far;
  return near + ((far - near) * Math.log(kmh / slow)) / Math.log(fast / slow);
}

/** Highest zoom at which a vehicle at `groundMs` × rate moves at most ½ the map width per second. */
export function maxZoomForRate(groundMs: number, rate: number, widthPx: number, lat: number): number {
  const v = groundMs * rate;
  if (!(v > 0) || !(widthPx > 0)) return Infinity;
  const mpp = v / (MAX_SCREEN_FRACTION * widthPx);
  return Math.log2((EARTH_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * mpp));
}

/**
 * Speed (m/s) averaged over ±8 s around a point 2 s ahead (screen/video seconds × rate), capped at ±30 s / 7.5 s
 * of track time; 0 while stopped. Gaussian weights (σ = half the window): a flat average over a window as long as
 * the slow/fast phases turns them upside down (at ×10, ±80 s of a city drive zoomed out while crawling).
 */
export function lookAheadSpeed(track: Track, pos: number, rate: number): number {
  if (!track.hasSpeed) return NaN;
  const s0 = sampleAt(track, pos);
  if (!isMoving(s0)) return 0;
  const end = track.playT[track.n - 1];
  const seg = track.seg[s0.i];
  const center = pos + Math.min(LOOK_AHEAD_SEC * 1000 * rate, LOOK_AHEAD_MAX_MS);
  const half = Math.min(SPEED_HALF_SEC * 1000 * rate, SPEED_HALF_MAX_MS);
  let sum = 0, w = 0;
  for (let k = -STEPS; k <= STEPS; k++) {
    const s = sampleAt(track, Math.min(end, Math.max(0, center + (k / STEPS) * half)));
    if (track.seg[s.i] !== seg || !Number.isFinite(s.speed)) continue;
    const wk = Math.exp(-2 * (k / STEPS) ** 2);
    sum += wk * s.speed;
    w += wk;
  }
  return w ? sum / w : s0.speed;
}

/** Moves the zoom towards a target: at most 0.5 level/s, eased, ignoring changes under 0.25 once settled. */
export class ZoomFollower {
  z = NaN;
  private v = 0;
  private settled = true;

  jump(z: number): void {
    this.z = z;
    this.v = 0;
    this.settled = true;
  }

  step(target: number, dt: number): number {
    if (!Number.isFinite(this.z)) {
      this.jump(target);
      return this.z;
    }
    const diff = target - this.z;
    if (this.settled && Math.abs(diff) < DEAD_BAND) return this.z;
    this.settled = false;
    const want = Math.max(-MAX_RATE, Math.min(MAX_RATE, diff * 1.5)); // slows down near the target (ease-out)
    this.v += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, want - this.v)); // speeds up gradually (ease-in)
    this.v = Math.max(-MAX_RATE, Math.min(MAX_RATE, this.v));
    const next = this.z + this.v * dt;
    // Arrive (and settle) when this step would reach or pass the target and the target is within one step.
    const arrived = Math.sign(target - next) !== Math.sign(diff) || Math.abs(target - next) < 0.01;
    if (arrived && Math.abs(diff) <= MAX_RATE * dt) this.jump(target);
    else this.z = next;
    return this.z;
  }
}

/** Smart zoom state for one map: manual offset, smoothing, jumps on seek / rate change. */
export class SmartZoom {
  /** Manual zoom shift (wheel, +/−) applied to the whole curve (§15.5). */
  offset = 0;
  private follower = new ZoomFollower();
  private lastPos = NaN;
  private lastRate = NaN;

  reset(): void {
    this.offset = 0;
    this.follower.jump(NaN);
    this.lastPos = NaN;
    this.lastRate = NaN;
  }

  /** Shift the curve by a manual zoom change. */
  shift(delta: number): void {
    this.offset += delta;
    if (Number.isFinite(this.follower.z)) this.follower.jump(this.follower.z + delta);
  }

  /** Target zoom at a position, or NaN when the track has no speed. */
  target(track: Track, pos: number, rate: number, widthPx: number, sz: SmartZoomSettings): number {
    const range = speedRange(sz, track.stats.avgSpeed);
    const speed = lookAheadSpeed(track, pos, rate);
    if (!range || !Number.isFinite(speed)) return NaN;
    const curve = curveZoom(speed * 3.6, sz.near, sz.far, range.slow, range.fast) + this.offset;
    const lat = sampleAt(track, pos).lat;
    const z = Math.min(curve, maxZoomForRate(speed, rate, widthPx, lat));
    return Math.min(22, Math.max(1, z));
  }

  /** Zoom for this frame; `dt` is the frame time in screen/video seconds. */
  update(track: Track, pos: number, rate: number, dt: number, widthPx: number, sz: SmartZoomSettings): number {
    const target = this.target(track, pos, rate, widthPx, sz);
    if (!Number.isFinite(target)) return NaN;
    // A seek or a rate change jumps straight to the target (§15.4).
    const expected = rate * dt * 1000;
    const jumped = !Number.isFinite(this.lastPos) || rate !== this.lastRate || Math.abs(pos - this.lastPos) > expected * 3 + 2000;
    this.lastPos = pos;
    this.lastRate = rate;
    if (jumped) this.follower.jump(target);
    else this.follower.step(target, dt);
    return this.follower.z;
  }
}

/** Whether smart zoom can run for a track (§15.3). */
export function smartZoomAvailable(track: Track | null): boolean {
  return !!track && track.hasSpeed && autoSpeeds(track.stats.avgSpeed) !== null;
}
