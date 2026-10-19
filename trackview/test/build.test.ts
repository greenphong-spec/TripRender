import { describe, expect, it } from 'vitest';
import { buildTrack } from '../src/model/build';
import type { RawPoint, RawTrack } from '../src/model/types';
import { DEFAULTS } from '../src/settings';

function straightTrack(n: number, missingEvery: number): RawTrack {
  const pts: RawPoint[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      lat: 10 + i * 1e-4,
      lon: 106,
      ele: null,
      t: i % missingEvery === 5 ? null : Date.UTC(2026, 0, 1) + i * 1000,
      speed: null,
      course: null,
    });
  }
  return { name: 't', creator: '', format: 'gpx', segments: [pts], waypoints: [] };
}

describe('missing timestamps', () => {
  it('fills gaps linearly and stays fast on 100k points', () => {
    const raw = straightTrack(100_000, 20);
    const t0 = performance.now();
    const track = buildTrack(raw, 't', DEFAULTS);
    const ms = performance.now() - t0;
    expect(track.timing).toBe('timed');
    expect(track.n).toBe(100_000);
    for (let i = 0; i < track.n; i++) expect(track.t[i]).toBe(Date.UTC(2026, 0, 1) + i * 1000);
    expect(ms).toBeLessThan(2000);
  });
});
