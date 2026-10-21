import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  autoSpeeds, curveZoom, lookAheadSpeed, maxZoomForRate, SmartZoom, smartZoomAvailable, speedRange, ZoomFollower,
} from '../src/map/smartzoom';
import { buildTrack } from '../src/model/build';
import { sampleAt } from '../src/model/interpolate';
import { parseTrackFile } from '../src/parse';
import { DEFAULT_SMART, DEFAULTS } from '../src/settings';

const DIR = join(__dirname, '..', '..', 'example_GPSfiles');
const load = (name: string) => buildTrack(parseTrackFile(name, new Uint8Array(readFileSync(join(DIR, name)))), name, DEFAULTS);
const mpp = (zoom: number, lat: number) => (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);

describe('smart zoom curve (§15.2)', () => {
  const aug31 = load('Aug_31,_2026_15_20_59.gpx');

  it('takes Auto speeds from the track average: ½× and 2×', () => {
    expect(autoSpeeds(aug31.stats.avgSpeed)).toEqual({ slow: 22, fast: 87 });
    expect(autoSpeeds(load('Front_20260919_084111_to_20260919_091911_part1_4.kmz').stats.avgSpeed)).toEqual({ slow: 18, fast: 70 });
    expect(autoSpeeds(load('Aug_24,_2026_08_07_19.kml').stats.avgSpeed)).toEqual({ slow: 8, fast: 32 });
    expect(autoSpeeds(null)).toBeNull();
  });

  it('custom speeds win over Auto', () => {
    expect(speedRange({ ...DEFAULT_SMART, slowKmh: 40, fastKmh: 120 }, aug31.stats.avgSpeed)).toEqual({ slow: 40, fast: 120 });
    expect(speedRange({ ...DEFAULT_SMART, fastKmh: 120 }, aug31.stats.avgSpeed)).toEqual({ slow: 22, fast: 120 });
  });

  it('maps speed to zoom: near when slow, far when fast, middle at the average', () => {
    expect(curveZoom(5, 17, 13, 22, 87)).toBe(17);
    expect(curveZoom(100, 17, 13, 22, 87)).toBe(13);
    expect(curveZoom(Math.sqrt(22 * 87), 17, 13, 22, 87)).toBeCloseTo(15, 6);
    expect(curveZoom(30, 17, 13, 22, 87)).toBeCloseTo(16.1, 1);
  });

  it('needs speed data', () => {
    expect(smartZoomAvailable(aug31)).toBe(true);
    expect(smartZoomAvailable(load('20260908081016-52100-map.kmz'))).toBe(false);
  });
});

describe('rate widening (§15.4)', () => {
  it('keeps the vehicle under half the map width per second', () => {
    const v = 100 / 3.6;
    for (const rate of [10, 60, 240]) {
      const z = maxZoomForRate(v, rate, 1440, 11);
      expect((v * rate) / mpp(z, 11)).toBeCloseTo(720, 3);
    }
    expect(maxZoomForRate(v, 240, 1440, 11)).toBeLessThan(maxZoomForRate(v, 10, 1440, 11));
    expect(maxZoomForRate(0, 240, 1440, 11)).toBe(Infinity);
  });
});

describe('zoom follower (§15.4)', () => {
  it('changes at most 0.5 level per second and eases in', () => {
    const f = new ZoomFollower();
    f.jump(17);
    const dt = 1 / 60;
    let prev = 17;
    const steps: number[] = [];
    for (let i = 0; i < 60 * 20; i++) {
      const z = f.step(13, dt);
      steps.push(Math.abs(z - prev));
      prev = z;
    }
    expect(Math.max(...steps)).toBeLessThanOrEqual(0.5 * dt + 1e-9);
    expect(steps[1]).toBeLessThan(steps[60]); // starts slowly
    expect(prev).toBeCloseTo(13, 2);
  });

  it('ignores small changes once settled', () => {
    const f = new ZoomFollower();
    f.jump(15);
    for (let i = 0; i < 100; i++) f.step(15.2, 1 / 30);
    expect(f.z).toBe(15);
  });
});

describe('smart zoom on the sample tracks (§15.7)', () => {
  const aug31 = load('Aug_31,_2026_15_20_59.gpx');
  const sz = { ...DEFAULT_SMART, enabled: true };

  it('zooms in through town and out on the expressway at ×10', () => {
    const z = new SmartZoom();
    const town: number[] = [];
    const highway: number[] = [];
    for (let pos = 0; pos < aug31.stats.duration; pos += 5000) {
      const target = z.target(aug31, pos, 10, 1440, sz);
      const kmh = lookAheadSpeed(aug31, pos, 10) * 3.6;
      if (kmh > 25 && kmh < 35) town.push(target);
      if (kmh > 95) highway.push(target);
    }
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    expect(town.length).toBeGreaterThan(5);
    expect(highway.length).toBeGreaterThan(5);
    expect(median(town)).toBeGreaterThan(15.5);
    expect(median(town)).toBeLessThan(16.6);
    expect(median(highway)).toBeCloseTo(13, 1);
  });

  it('is wider at ×240 than at ×10', () => {
    const z = new SmartZoom();
    const pos = aug31.stats.duration / 2;
    expect(z.target(aug31, pos, 240, 1440, sz)).toBeLessThan(z.target(aug31, pos, 10, 1440, sz));
  });

  it('settles on the near zoom while stopped', () => {
    const dash = load('Front_20260919_084111_to_20260919_091911_part1_4.kmz');
    const z = new SmartZoom();
    let found = 0;
    for (let pos = 0; pos < dash.stats.duration && found < 3; pos += 1000) {
      const s = sampleAt(dash, pos);
      if (Number.isFinite(s.speed) && s.speed === 0) {
        expect(z.target(dash, pos, 10, 1440, sz)).toBe(17);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('applies the manual offset and jumps on a seek', () => {
    const z = new SmartZoom();
    const a = z.update(aug31, 1_000_000, 10, 1 / 60, 1440, sz);
    z.shift(1);
    expect(z.target(aug31, 1_000_000, 10, 1440, sz)).toBeCloseTo(Math.min(a + 1, maxZoomForRate(lookAheadSpeed(aug31, 1_000_000, 10), 10, 1440, sampleAt(aug31, 1_000_000).lat)), 6);
    const far = z.update(aug31, 5_000_000, 10, 1 / 60, 1440, sz);
    expect(far).toBe(z.target(aug31, 5_000_000, 10, 1440, sz));
  });
});
