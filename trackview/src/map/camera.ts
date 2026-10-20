import { bearing } from '../model/geo';
import { sampleAt, type Sample } from '../model/interpolate';
import type { Track } from '../model/types';
import type { CameraMode } from '../settings';

const LOOK_AHEAD_M = 30;
const MIN_MOVING = 3 / 3.6; // m/s; below this the heading is held (§13.4)
const STEPS = 6; // window samples on each side of the position

/** Order of the fit/follow button cycle (§6.3). */
export const CAMERA_CYCLE: CameraMode[] = ['off', 'north', 'heading', 'keep'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  off: 'Camera off',
  north: 'Follow, north up',
  heading: 'Follow, heading up',
  keep: 'Keep in view',
};

export function isMoving(s: Sample): boolean {
  if (s.pause) return false;
  return Number.isFinite(s.speed) ? s.speed >= MIN_MOVING : true;
}

/** Direction of travel at a sample: recorded course, else towards the point ~30 m ahead. */
export function travelBearing(track: Track, s: Sample): number {
  if (Number.isFinite(track.course[s.i])) return track.course[s.i];
  const seg = track.seg[s.i];
  const target = s.dist + LOOK_AHEAD_M;
  let lo = s.i + 1;
  let hi = track.n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.dist[mid] >= target) hi = mid;
    else lo = mid + 1;
  }
  let j = Math.min(lo, track.n - 1);
  while (j > s.i && track.seg[j] !== seg) j--;
  if (j > s.i && (track.lat[j] !== s.lat || track.lon[j] !== s.lon)) {
    return bearing(s.lat, s.lon, track.lat[j], track.lon[j]);
  }
  // End of the segment: look back instead.
  for (let k = s.i; k >= 0 && track.seg[k] === seg; k--) {
    if (s.dist - track.dist[k] >= LOOK_AHEAD_M || k === 0 || track.seg[k - 1] !== seg) {
      if (track.lat[k] !== s.lat || track.lon[k] !== s.lon) return bearing(track.lat[k], track.lon[k], s.lat, s.lon);
      break;
    }
  }
  return NaN;
}

const segSpans = new WeakMap<Track, Map<number, [number, number]>>();

/** First and last playback time of a segment (cached per track). */
function segSpan(track: Track, seg: number): [number, number] {
  let spans = segSpans.get(track);
  if (!spans) {
    spans = new Map();
    for (let i = 0; i < track.n; i++) {
      const sp = spans.get(track.seg[i]);
      if (sp) sp[1] = track.playT[i];
      else spans.set(track.seg[i], [track.playT[i], track.playT[i]]);
    }
    segSpans.set(track, spans);
  }
  return spans.get(seg)!;
}

export interface View {
  lat: number;
  lon: number;
  /** Degrees; NaN until a direction of travel is known. */
  bearing: number;
}

/**
 * Smooth camera / marker motion over a window centred on the position, measured in *video* seconds
 * (so it looks the same at every rate) and without lag, since the whole track is known.
 * The window never crosses a segment break, so the camera cuts there. The bearing is held while stopped.
 */
export class ViewSmoother {
  private held = NaN;

  constructor(private centerSec = 0.3, private bearingSec = 1.0) {}

  reset(): void {
    this.held = NaN;
  }

  at(track: Track, pos: number, rate: number): View {
    const s0 = sampleAt(track, pos);
    const seg = track.seg[s0.i];
    const [segStart, segEnd] = segSpan(track, seg);
    const around = (halfSec: number, fn: (s: Sample) => void) => {
      // Shrink the window symmetrically near a segment end, so the average stays on the marker.
      const half = Math.max(0, Math.min(halfSec * 1000 * rate, pos - segStart, segEnd - pos));
      for (let k = -STEPS; k <= STEPS; k++) fn(k === 0 || !half ? s0 : sampleAt(track, pos + (k / STEPS) * half));
    };

    let lat = 0, lon = 0, n = 0;
    around(this.centerSec, (s) => { lat += s.lat; lon += s.lon; n++; });

    if (isMoving(s0) || !Number.isFinite(this.held)) {
      let x = 0, y = 0;
      around(this.bearingSec, (s) => {
        if (!isMoving(s)) return;
        const b = travelBearing(track, s) * (Math.PI / 180);
        if (Number.isFinite(b)) { x += Math.sin(b); y += Math.cos(b); }
      });
      const b = x || y ? ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 : travelBearing(track, s0);
      if (Number.isFinite(b)) this.held = b;
    }
    return { lat: lat / n, lon: lon / n, bearing: this.held };
  }
}

/** Shortest signed difference b − a in degrees, in (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}
