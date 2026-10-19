import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTrack } from '../src/model/build';
import { sampleAt } from '../src/model/interpolate';
import { distValue, speedValue } from '../src/model/units';
import { parseTrackFile } from '../src/parse';
import { DEFAULTS } from '../src/settings';

const DIR = join(__dirname, '..', '..', 'example_GPSfiles');

function load(name: string, settings = DEFAULTS) {
  const raw = parseTrackFile(name, new Uint8Array(readFileSync(join(DIR, name))));
  return { raw, track: buildTrack(raw, name, settings) };
}

const km = (m: number) => m / 1000;
const kmh = (ms: number) => ms * 3.6;

describe('Aug 31 GPX (Geo Tracker)', () => {
  const { raw, track } = load('Aug_31,_2026_15_20_59.gpx');

  it('reads 3 segments and all points', () => {
    expect(raw.segments.map((s) => s.length)).toEqual([1817, 5703, 16]);
    expect(track.segmentCount).toBe(3);
    expect(track.n).toBeGreaterThanOrEqual(7531);
    expect(track.n).toBeLessThanOrEqual(7536);
    expect(track.timing).toBe('timed');
  });

  it('does not bridge segment breaks in distance', () => {
    expect(km(track.stats.distance)).toBeGreaterThan(149.6);
    expect(km(track.stats.distance)).toBeLessThan(150.6);
  });

  it('uses recorded speed, max about 115 km/h', () => {
    expect(track.speedSource).toBe('recorded');
    expect(kmh(track.stats.maxSpeed!)).toBeGreaterThan(110);
    expect(kmh(track.stats.maxSpeed!)).toBeLessThan(120);
  });

  it('collapses pauses: replay timeline about 3 h 28 min, done in ≤ 60 s at ×240', () => {
    const hours = track.stats.duration / 3_600_000;
    expect(hours).toBeGreaterThan(3.4);
    expect(hours).toBeLessThan(3.55);
    expect(track.stats.duration / 240 / 1000).toBeLessThanOrEqual(60);
    expect(track.pauses.some((p) => p.realMs > 11 * 3_600_000)).toBe(true);
  });

  it('keeps all 5 waypoints and removes no spikes', () => {
    expect(track.waypoints).toHaveLength(5);
    expect(track.spikesRemoved).toBe(0);
  });

  it('converts to imperial units', () => {
    expect(distValue(track.stats.distance, 'imperial')).toBeCloseTo(93.3, 0);
    expect(speedValue(track.stats.maxSpeed!, 'imperial')).toBeGreaterThan(69);
    expect(speedValue(track.stats.maxSpeed!, 'imperial')).toBeLessThan(74);
  });

  it('real time when skip pauses is off', () => {
    const t = buildTrack(raw, 'x', { ...DEFAULTS, skipPauses: false });
    expect(t.stats.duration).toBe(t.t[t.n - 1] - t.t[0]);
  });
});

describe('duplicate GPX files', () => {
  it('load identically', () => {
    const a = load('phan thiet sai gon cao toc 31.08.gpx').track;
    const b = load('phan thiet sai gon cao toc 31.08 (1).gpx').track;
    expect(a.n).toBe(b.n);
    expect(a.stats).toEqual(b.stats);
    expect(a.waypoints).toHaveLength(3);
  });
});

describe('GPS Visualizer KMZ (untimed)', () => {
  const { track } = load('20260908081016-52100-map.kmz');
  it('is untimed with 3 segments and ~150 km', () => {
    expect(track.timing).toBe('untimed');
    expect(track.segmentCount).toBe(3);
    expect(track.n).toBe(7536);
    expect(km(track.stats.distance)).toBeCloseTo(150.1, 0);
    expect(track.hasSpeed).toBe(false);
    expect(track.hasEle).toBe(true);
  });
  it('has the 3 stop waypoints with CDATA names', () => {
    expect(track.waypoints.map((w) => w.name)).toEqual(['Stop for ~2 min', 'Stop for ~11 h 58 min', 'Stop for ~14 min']);
  });
  it('builds a distance-based timeline at 50 km/h', () => {
    const expected = (track.stats.distance / (50 / 3.6)) * 1000 + 2 * 1000; // + 2 segment breaks
    expect(track.stats.duration).toBeCloseTo(expected, -2);
  });
});

describe('Geo Tracker KML/KMZ (gx:Track)', () => {
  it.each([
    ['Apr_15,_2022_11_14_28.kml', 112],
    ['Aug_24,_2026_08_07_19.kml', 362],
    ['Sep_13,_2026_11_26_19.kmz', 163],
  ])('%s: timed, recorded speed, %i points', (name, count) => {
    const { track } = load(name);
    expect(track.timing).toBe('timed');
    expect(track.speedSource).toBe('recorded');
    expect(track.n).toBe(count);
    expect(track.spikesRemoved).toBe(0);
    expect(track.course.some(Number.isFinite)).toBe(true);
  });

  it('Aug 24: the stop placemark is a waypoint, not a track point', () => {
    const { track } = load('Aug_24,_2026_08_07_19.kml');
    expect(track.waypoints).toHaveLength(1);
    expect(track.waypoints[0].t).toBe(Date.parse('2026-08-24T01:30:19Z'));
  });
});

describe('Dashcam KMZ (estimated time)', () => {
  const { track } = load('Front_20260919_084111_to_20260919_091911_part1_4.kmz');
  it('spreads the stated start/end time over the points', () => {
    expect(track.timing).toBe('estimated');
    expect(track.n).toBe(2189);
    expect(track.t[0]).toBe(Date.parse('2026-09-19T08:41:09+07:00'));
    expect(track.t[track.n - 1]).toBe(Date.parse('2026-09-19T09:19:24+07:00'));
    expect(km(track.stats.distance)).toBeCloseTo(22.44, 1);
  });
  it('treats all-zero altitude as missing and skips Start/End pins', () => {
    expect(track.hasEle).toBe(false);
    expect(track.waypoints).toHaveLength(0);
  });
  it('derives speed by default, hides it on request', () => {
    expect(track.speedSource).toBe('derived');
    expect(track.statedStats).toEqual({ maxKmh: 99, avgKmh: 35.2 });
    const hidden = buildTrack(load('Front_20260919_084111_to_20260919_091911_part1_4.kmz').raw, 'x', {
      ...DEFAULTS,
      estimatedSpeed: 'hidden',
    });
    expect(hidden.hasSpeed).toBe(false);
  });
});

describe('interpolation', () => {
  const { track } = load('Aug_31,_2026_15_20_59.gpx');
  it('starts at the first point and ends at the last', () => {
    const a = sampleAt(track, 0);
    const b = sampleAt(track, track.stats.duration);
    expect([a.lat, a.lon]).toEqual([track.lat[0], track.lon[0]]);
    expect([b.lat, b.lon]).toEqual([track.lat[track.n - 1], track.lon[track.n - 1]]);
    expect(b.dist).toBeCloseTo(track.stats.distance);
  });
  it('holds position inside the 11 h pause', () => {
    const p = track.pauses.find((x) => x.realMs > 11 * 3_600_000)!;
    const s = sampleAt(track, (p.playStart + p.playEnd) / 2);
    expect(s.pause).toBe(p);
    expect(s.lat).toBe(track.lat[p.index]);
    expect(s.clock).toBeGreaterThan(track.t[p.index]);
  });
  it('is monotonic in distance', () => {
    let last = -1;
    for (let pos = 0; pos <= track.stats.duration; pos += track.stats.duration / 500) {
      const d = sampleAt(track, pos).dist;
      expect(d).toBeGreaterThanOrEqual(last);
      last = d;
    }
  });
});
