import { distanceToSegment, haversine } from './geo';
import type { RawPoint } from './types';

const MAX_SPEED = 250 / 3.6; // m/s
const MAX_RUN = 3; // longest run of consecutive points treated as one spike
const DETOUR_RATIO = 3;

/**
 * Remove points that jump off the route and come back (§5.2).
 * Each candidate is compared with the last kept point and the next few points,
 * so spikes of up to MAX_RUN consecutive points are caught.
 */
export function removeSpikes(
  seg: RawPoint[],
  maxDistance: number,
  timed: boolean,
): { points: RawPoint[]; removed: number } {
  if (seg.length < 3) return { points: seg, removed: 0 };
  const out: RawPoint[] = [seg[0]];
  let pending: RawPoint[] = [];

  const isDetour = (a: RawPoint, p: RawPoint, c: RawPoint) => {
    const dev = distanceToSegment(a.lat, a.lon, p.lat, p.lon, c.lat, c.lon);
    if (dev <= maxDistance) return false;
    const ap = haversine(a.lat, a.lon, p.lat, p.lon);
    const pc = haversine(p.lat, p.lon, c.lat, c.lon);
    const ac = haversine(a.lat, a.lon, c.lat, c.lon);
    return (ap + pc) / Math.max(ac, 1) > DETOUR_RATIO;
  };

  for (let i = 1; i < seg.length - 1; i++) {
    const a = out[out.length - 1];
    const p = seg[i];
    let spike = false;
    if (timed && a.t !== null && p.t !== null && p.t > a.t) {
      spike = haversine(a.lat, a.lon, p.lat, p.lon) / ((p.t - a.t) / 1000) > MAX_SPEED;
    }
    for (let k = 1; !spike && k <= MAX_RUN && i + k < seg.length; k++) {
      spike = isDetour(a, p, seg[i + k]);
    }
    if (spike) {
      pending.push(p);
      if (pending.length > MAX_RUN) {
        // Too long to be a spike: it is real movement after all.
        out.push(...pending);
        pending = [];
      }
    } else {
      pending = [];
      out.push(p);
    }
  }
  out.push(seg[seg.length - 1]);
  return { points: out, removed: seg.length - out.length };
}
