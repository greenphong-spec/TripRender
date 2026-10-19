import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTrack } from '../src/model/build';
import { removeSpikes } from '../src/model/spikes';
import type { RawPoint } from '../src/model/types';
import { parseTrackFile } from '../src/parse';
import { DEFAULTS } from '../src/settings';

const DIR = join(__dirname, '..', '..', 'example_GPSfiles');
const name = 'Apr_15,_2022_11_14_28.kml';
const base = parseTrackFile(name, new Uint8Array(readFileSync(join(DIR, name)))).segments[0];

/** A point 300 m north of p, timed halfway between p and the next point. */
function offRoute(p: RawPoint, q: RawPoint, k: number, of: number): RawPoint {
  const t = p.t! + ((q.t! - p.t!) * (k + 1)) / (of + 1);
  return { ...p, lat: p.lat + 300 / 111_000, t, speed: null, course: null };
}

/** Insert runs of 1, 2 and 3 spike points after the given indices. */
function withSpikes(seg: RawPoint[], at: [number, number][]): { seg: RawPoint[]; spikes: Set<RawPoint> } {
  const spikes = new Set<RawPoint>();
  const out: RawPoint[] = [];
  seg.forEach((p, i) => {
    out.push(p);
    const run = at.find(([idx]) => idx === i);
    if (!run) return;
    for (let k = 0; k < run[1]; k++) {
      const s = offRoute(p, seg[i + 1], k, run[1]);
      spikes.add(s);
      out.push(s);
    }
  });
  return { seg: out, spikes };
}

describe('spike filter', () => {
  it.each([true, false])('removes 1-, 2- and 3-point spikes and nothing else (timed=%s)', (timed) => {
    const { seg, spikes } = withSpikes(base, [[20, 1], [50, 2], [80, 3]]);
    const input = timed ? seg : seg.map((p) => ({ ...p, t: null }));
    const spikeIdx = new Set(seg.map((p, i) => (spikes.has(p) ? i : -1)).filter((i) => i >= 0));
    const { points, removed } = removeSpikes(input, 50, timed);
    expect(removed).toBe(6);
    const kept = new Set(points);
    input.forEach((p, i) => expect(kept.has(p)).toBe(!spikeIdx.has(i)));
  });

  it('keeps a long excursion (more than 3 points) as real movement', () => {
    const { seg } = withSpikes(base, [[50, 6]]);
    const { removed } = removeSpikes(seg.map((p) => ({ ...p, t: null })), 50, false);
    expect(removed).toBe(0);
  });

  it('is applied by buildTrack only when enabled', () => {
    const { seg } = withSpikes(base, [[20, 1]]);
    const raw = { name: 'x', creator: '', format: 'kml' as const, segments: [seg], waypoints: [] };
    expect(buildTrack(raw, 'x', DEFAULTS).spikesRemoved).toBe(1);
    expect(buildTrack(raw, 'x', { ...DEFAULTS, removeSpikes: false }).spikesRemoved).toBe(0);
  });
});
