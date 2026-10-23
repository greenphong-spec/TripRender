import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { autoCurve, curveAt, forgetCurve, loadCurve, saveCurve, simulateZoom } from '../src/map/zoomcurve';
import { buildTrack } from '../src/model/build';
import { parseTrackFile } from '../src/parse';
import { DEFAULT_SMART, DEFAULTS } from '../src/settings';

const DIR = join(__dirname, '..', '..', 'example_GPSfiles');
const NAME = 'Sep_13,_2026_11_26_19.kmz';
const bytes = new Uint8Array(readFileSync(join(DIR, NAME)));
const build = (s = DEFAULTS) => buildTrack(parseTrackFile(NAME, bytes), NAME, s);
const sz = { ...DEFAULT_SMART, enabled: true };

// The tests run in Node: a minimal in-memory localStorage.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

describe('zoom curve (§16)', () => {
  const track = build();
  const dur = track.stats.duration;

  beforeEach(() => store.clear());

  it('reduces the simulated smart zoom to a few control points spanning the track', () => {
    const c = autoCurve(track, 10, 1440, sz)!;
    expect(c.edited).toBe(false);
    expect(c.rate).toBe(10);
    expect(c.knots.length).toBeGreaterThan(3);
    expect(c.knots.length).toBeLessThanOrEqual(60);
    expect(c.knots[0].pos).toBe(0);
    expect(c.knots[c.knots.length - 1].pos).toBe(dur);
    for (let i = 1; i < c.knots.length; i++) expect(c.knots[i].pos).toBeGreaterThan(c.knots[i - 1].pos);
  });

  it('follows the smart zoom it was computed from', () => {
    const c = autoCurve(track, 10, 1440, sz)!;
    const { xs, zs } = simulateZoom(track, 10, 1440, sz)!;
    const worst = Math.max(...xs.map((pos, i) => Math.abs(curveAt(c.knots, pos) - zs[i])));
    expect(worst).toBeLessThan(0.15);
  });

  it('passes through the points without overshooting between them', () => {
    const knots = [{ pos: 0, z: 14 }, { pos: 1000, z: 17 }, { pos: 2000, z: 17 }, { pos: 3000, z: 13 }];
    knots.forEach((k) => expect(curveAt(knots, k.pos)).toBeCloseTo(k.z, 9));
    for (let p = 0; p <= 3000; p += 25) {
      const z = curveAt(knots, p);
      expect(z).toBeGreaterThanOrEqual(13 - 1e-9);
      expect(z).toBeLessThanOrEqual(17 + 1e-9);
    }
    expect(curveAt(knots, 1500)).toBeCloseTo(17, 9); // flat between equal points
    expect(curveAt(knots, -5)).toBe(14);
    expect(curveAt(knots, 9999)).toBe(13);
  });

  it('is unavailable without speed data', () => {
    const untimed = buildTrack(parseTrackFile('x.kml', new TextEncoder().encode(
      '<kml><Document><Placemark><LineString><coordinates>106,11 106.001,11 106.002,11</coordinates></LineString></Placemark></Document></kml>',
    )), 'x.kml', DEFAULTS);
    expect(autoCurve(untimed, 10, 1440, sz)).toBeNull();
  });

  it('saves edits per file and maps them onto a rebuilt timeline', () => {
    const c = autoCurve(track, 10, 1440, sz)!;
    const mid = c.knots[Math.floor(c.knots.length / 2)];
    mid.z = 19;
    saveCurve(track, { ...c, edited: true });

    const back = loadCurve(track)!;
    expect(back.edited).toBe(true);
    expect(back.knots.length).toBe(c.knots.length);
    back.knots.forEach((k, i) => {
      expect(k.pos).toBeCloseTo(c.knots[i].pos, 3);
      expect(k.z).toBeCloseTo(c.knots[i].z, 9);
    });

    // A rebuild with other settings still finds the curve; the ends stay on the track's ends.
    const other = build({ ...DEFAULTS, pauseThresholdSec: 10 });
    const moved = loadCurve(other)!;
    expect(moved.knots[0].pos).toBe(0);
    expect(moved.knots[moved.knots.length - 1].pos).toBe(other.stats.duration);
    expect(Math.max(...moved.knots.map((k) => k.z))).toBe(19);

    forgetCurve(track);
    expect(loadCurve(track)).toBeNull();
  });
});
