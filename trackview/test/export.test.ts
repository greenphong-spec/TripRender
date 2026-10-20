import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RATE_PRESETS } from '../src/export/presets';
import { fitRate, frameAt, makePlan, parseClock } from '../src/export/timeline';
import { angleDiff, isMoving, travelBearing, ViewSmoother } from '../src/map/camera';
import { markerPose } from '../src/map/marker';
import { buildTrack } from '../src/model/build';
import { haversine } from '../src/model/geo';
import { sampleAt } from '../src/model/interpolate';
import { parseTrackFile } from '../src/parse';
import { DEFAULT_MARKER, DEFAULTS, type MarkerSettings } from '../src/settings';

const DIR = join(__dirname, '..', '..', 'example_GPSfiles');

function load(name: string) {
  return buildTrack(parseTrackFile(name, new Uint8Array(readFileSync(join(DIR, name)))), name, DEFAULTS);
}

const base = { from: 0, rateMode: 'preset' as const, rate: 1, targetSec: 60, fps: 30, intro: false, outro: false };

describe('video timeline (§13.2, §13.3)', () => {
  it('has the speed presets of §13.10, realtime the slowest', () => {
    expect(RATE_PRESETS.map((p) => p.rate)).toEqual([1, 2, 4, 10, 30, 60]);
    expect(Math.min(...RATE_PRESETS.map((p) => p.rate))).toBe(1);
  });

  it('Apr 15 KML at realtime gives a ~2 min video, ±1 frame', () => {
    const t = load('Apr_15,_2022_11_14_28.kml');
    const dur = t.stats.duration;
    const plan = makePlan({ ...base, to: dur });
    expect(plan.rate).toBe(1);
    expect(Math.abs(plan.main - (dur / 1000) * 30)).toBeLessThanOrEqual(1);
    expect(plan.seconds).toBeGreaterThan(100);
    expect(plan.seconds).toBeLessThan(130);
    expect(frameAt(plan, 0).pos).toBe(0);
    expect(frameAt(plan, plan.total - 1).pos).toBeCloseTo(dur, -2);
  });

  it('Aug 31 GPX fit to 60 s runs at about ×208 and lasts 60 s plus intro/outro', () => {
    const t = load('Aug_31,_2026_15_20_59.gpx');
    const plan = makePlan({ ...base, to: t.stats.duration, rateMode: 'fit', targetSec: 60, intro: true, outro: true });
    expect(Math.round(plan.rate)).toBeGreaterThanOrEqual(205);
    expect(Math.round(plan.rate)).toBeLessThanOrEqual(211);
    expect(plan.main).toBe(60 * 30 + 1);
    expect(plan.introHold + plan.introFly + plan.outroFly + plan.outroHold).toBe(7 * 30);
    // The 11 h 47 min pause is collapsed to 1 s of track time: under 1/200 s of video.
    const longest = t.pauses.reduce((a, p) => (p.realMs > a.realMs ? p : a));
    expect(longest.realMs).toBeGreaterThan(11 * 3600_000);
    expect((longest.playEnd - longest.playStart) / plan.rate / 1000).toBeLessThan(0.01);
  });

  it('never goes slower than realtime', () => {
    expect(fitRate(120_000, 600)).toBe(1);
    expect(makePlan({ ...base, to: 120_000, rateMode: 'fit', targetSec: 600 }).rate).toBe(1);
  });

  it('intro holds the overview, flies in, then follows; outro mirrors it', () => {
    const plan = makePlan({ ...base, from: 10_000, to: 70_000, rate: 10, intro: true, outro: true });
    expect(frameAt(plan, 0)).toMatchObject({ phase: 'intro-hold', follow: 0, pos: 10_000 });
    const fly = Array.from({ length: plan.introFly }, (_, j) => frameAt(plan, plan.introHold + j));
    expect(fly.every((f) => f.phase === 'intro-fly' && f.pos === 10_000)).toBe(true);
    for (let j = 1; j < fly.length; j++) expect(fly[j].follow).toBeGreaterThan(fly[j - 1].follow);
    const firstMain = frameAt(plan, plan.introHold + plan.introFly);
    expect(firstMain).toMatchObject({ phase: 'main', follow: 1, pos: 10_000 });
    const lastMain = frameAt(plan, plan.introHold + plan.introFly + plan.main - 1);
    expect(lastMain.pos).toBe(70_000);
    expect(frameAt(plan, plan.total - 1)).toMatchObject({ phase: 'outro-hold', follow: 0, pos: 70_000 });
    // Range: 60 s of track at ×10 = 6 s of video.
    expect(plan.main).toBe(6 * 30 + 1);
  });

  it('parses min:sec and h:mm:ss', () => {
    expect(parseClock('1:30')).toBe(90);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('45')).toBe(45);
    expect(parseClock('abc')).toBeNaN();
  });
});

describe('camera smoothing (§13.4)', () => {
  const t = load('Aug_24,_2026_08_07_19.kml');
  const end = t.stats.duration;

  it('keeps the camera on the marker with no lag at ×10', () => {
    const cam = new ViewSmoother(0.3, 1.0);
    const offsets: number[] = [];
    for (let pos = 0; pos <= end; pos += 2000) {
      const v = cam.at(t, pos, 10);
      const s = sampleAt(t, pos);
      offsets.push(haversine(v.lat, v.lon, s.lat, s.lon));
    }
    offsets.sort((a, b) => a - b);
    expect(offsets[Math.floor(offsets.length / 2)]).toBeLessThan(10);
    expect(offsets[Math.floor(offsets.length * 0.95)]).toBeLessThan(40);
  });

  it('points the heading along the direction of travel', () => {
    const cam = new ViewSmoother(0.3, 1.0);
    const diffs: number[] = [];
    for (let pos = 0; pos <= end; pos += 2000) {
      const s = sampleAt(t, pos);
      const v = cam.at(t, pos, 10);
      const raw = travelBearing(t, s);
      if (isMoving(s) && Number.isFinite(raw)) diffs.push(Math.abs(angleDiff(raw, v.bearing)));
    }
    diffs.sort((a, b) => a - b);
    expect(diffs.length).toBeGreaterThan(50);
    expect(diffs[Math.floor(diffs.length / 2)]).toBeLessThan(15);
  });

  it('holds the heading while stopped', () => {
    const cam = new ViewSmoother(0.3, 1.0);
    let held = 0;
    let prev = NaN;
    let wasStopped = false;
    for (let pos = 0; pos <= end; pos += 250) {
      const s = sampleAt(t, pos);
      const b = cam.at(t, pos, 10).bearing;
      if (!isMoving(s) && wasStopped && Number.isFinite(prev)) {
        expect(b).toBe(prev);
        held++;
      }
      wasStopped = !isMoving(s);
      prev = b;
    }
    expect(held).toBeGreaterThan(0);
  });

  it('cuts at a segment break instead of panning', () => {
    const a = load('Aug_31,_2026_15_20_59.gpx');
    const brk = a.pauses.find((p) => p.segmentBreak)!;
    const cam = new ViewSmoother(0.3, 1.0);
    for (const pos of [brk.playStart - 100, brk.playEnd + 100]) {
      const v = cam.at(a, pos, 200);
      const s = sampleAt(a, pos);
      expect(haversine(v.lat, v.lon, s.lat, s.lon)).toBeLessThan(50);
    }
  });
});

describe('marker pose (§14.3)', () => {
  const ms = (p: Partial<MarkerSettings>): MarkerSettings => ({ ...DEFAULT_MARKER, ...p });

  it('defaults to the car icon, 24 px, rotating', () => {
    expect(DEFAULT_MARKER).toMatchObject({ kind: 'icon', icon: 'car', sizePx: 24, rotation: 'rotate', halo: true });
  });

  it('rotates built-in shapes to the direction of travel', () => {
    expect(markerPose(ms({ kind: 'arrow' }), 135)).toEqual({ rotate: 135, flip: false });
  });

  it('accounts for which way an imported image faces', () => {
    const right = ms({ kind: 'image', rotation: 'rotate', imageFrontDeg: 90 });
    expect(markerPose(right, 90).rotate).toBe(0); // travelling east: unchanged
    expect(markerPose(right, 0).rotate).toBe(-90); // travelling north: turned up
  });

  it('flips a side-view image instead of rotating it', () => {
    const side = ms({ kind: 'image', rotation: 'flip', imageFrontDeg: 90 });
    expect(markerPose(side, 80)).toEqual({ rotate: 0, flip: false });
    expect(markerPose(side, 260)).toEqual({ rotate: 0, flip: true });
    // Straight north or south: keep the last choice.
    expect(markerPose(side, 0, true).flip).toBe(true);
    expect(markerPose(side, 180, false).flip).toBe(false);
  });

  it('never turns a fixed marker or the dot', () => {
    expect(markerPose(ms({ rotation: 'fixed' }), 123)).toEqual({ rotate: 0, flip: false });
    expect(markerPose(ms({ kind: 'dot' }), 123)).toEqual({ rotate: 0, flip: false });
  });
});
