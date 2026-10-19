import type { BuildSettings } from '../settings';
import { haversine } from './geo';
import { removeSpikes } from './spikes';
import type { Pause, RawPoint, RawTrack, Timing, Track, TrackStats } from './types';

const MAX_SPEED = 250 / 3.6; // m/s; faster derived speeds are treated as glitches
const UNTIMED_SPEED = 50 / 3.6; // nominal m/s used to build a timeline from distance
const PAUSE_PLAY_MS = 1000; // a collapsed pause lasts this long on the playback timeline
const GAIN_HYSTERESIS = 3; // metres

const validCoord = (p: RawPoint) =>
  Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** Fill missing times inside a segment by linear interpolation over the point index. */
function fillTimes(seg: RawPoint[]): void {
  const known = seg.map((p, i) => (p.t !== null ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return;
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].t !== null) continue;
    const next = known.find((k) => k > i);
    const prev = [...known].reverse().find((k) => k < i);
    if (prev === undefined) seg[i].t = seg[next!].t;
    else if (next === undefined) seg[i].t = seg[prev].t;
    else seg[i].t = seg[prev].t! + ((seg[next].t! - seg[prev].t!) * (i - prev)) / (next - prev);
  }
}

/** Sort by time (stable) and merge points that share a timestamp, keeping the last one. */
function sortAndMerge(seg: RawPoint[]): RawPoint[] {
  const sorted = seg.map((p, i) => ({ p, i })).sort((a, b) => a.p.t! - b.p.t! || a.i - b.i).map((x) => x.p);
  const out: RawPoint[] = [];
  for (const p of sorted) {
    if (out.length && out[out.length - 1].t === p.t) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

function interpolateNaN(a: Float64Array, seg: Int32Array): void {
  const n = a.length;
  let i = 0;
  while (i < n) {
    if (!Number.isNaN(a[i])) { i++; continue; }
    let j = i;
    while (j < n && Number.isNaN(a[j]) && seg[j] === seg[i]) j++;
    const left = i > 0 && seg[i - 1] === seg[i] ? a[i - 1] : NaN;
    const right = j < n && seg[j] === seg[i] ? a[j] : NaN;
    for (let k = i; k < j; k++) {
      if (!Number.isNaN(left) && !Number.isNaN(right)) a[k] = left + ((right - left) * (k - i + 1)) / (j - i + 1);
      else a[k] = Number.isNaN(left) ? right : left;
    }
    i = j;
  }
}

export function buildTrack(raw: RawTrack, fileName: string, s: BuildSettings): Track {
  let segs = raw.segments.map((seg) => seg.filter(validCoord).map((p) => ({ ...p }))).filter((seg) => seg.length);
  const total = segs.reduce((sum, seg) => sum + seg.length, 0);
  if (!total) throw new Error('The file contains no track points');

  const withTime = segs.reduce((sum, seg) => sum + seg.filter((p) => p.t !== null).length, 0);
  const timing: Timing = withTime / total >= 0.9 ? 'timed' : raw.timeHint ? 'estimated' : 'untimed';

  if (timing === 'timed') {
    segs.forEach(fillTimes);
    segs = segs.map(sortAndMerge).sort((a, b) => a[0].t! - b[0].t!);
  } else {
    segs.forEach((seg) => seg.forEach((p) => (p.t = null)));
    if (timing === 'estimated') {
      // Spread the known start..end evenly over the points (dashcam logs are ~1 Hz).
      const { start, end } = raw.timeHint!;
      const step = total > 1 ? (end - start) / (total - 1) : 0;
      let k = 0;
      segs.forEach((seg) => seg.forEach((p) => (p.t = start + step * k++)));
    }
  }

  let spikesRemoved = 0;
  if (s.removeSpikes) {
    segs = segs.map((seg) => {
      const r = removeSpikes(seg, s.spikeDistanceM, timing === 'timed');
      spikesRemoved += r.removed;
      return r.points;
    });
  }

  const n = segs.reduce((sum, seg) => sum + seg.length, 0);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const ele = new Float64Array(n);
  const t = new Float64Array(n);
  const seg = new Int32Array(n);
  const course = new Float64Array(n);
  const speedRec = new Float64Array(n);
  let k = 0;
  segs.forEach((points, si) => {
    for (const p of points) {
      lat[k] = p.lat;
      lon[k] = p.lon;
      ele[k] = p.ele ?? NaN;
      t[k] = p.t ?? NaN;
      seg[k] = si;
      course[k] = p.course ?? NaN;
      speedRec[k] = p.speed ?? NaN;
      k++;
    }
  });

  // Elevation that is always 0 (dashcam) means "not recorded".
  let hasEle = false;
  for (let i = 0; i < n; i++) if (Number.isFinite(ele[i]) && ele[i] !== 0) { hasEle = true; break; }
  if (!hasEle) ele.fill(NaN);

  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    dist[i] = dist[i - 1] + (seg[i] === seg[i - 1] ? haversine(lat[i - 1], lon[i - 1], lat[i], lon[i]) : 0);
  }

  // Speed: recorded if (nearly) always present, otherwise derived from position and time.
  const speed = new Float64Array(n).fill(NaN);
  let speedSource: Track['speedSource'] = 'none';
  const speedAllowed = timing === 'timed' || (timing === 'estimated' && s.estimatedSpeed === 'derived');
  if (speedAllowed) {
    const recorded = speedRec.reduce((c, v) => c + (Number.isFinite(v) ? 1 : 0), 0);
    const useRecorded = timing === 'timed' && recorded / n >= 0.9;
    speedSource = useRecorded ? 'recorded' : 'derived';
    for (let i = 0; i < n; i++) {
      if (useRecorded && Number.isFinite(speedRec[i])) { speed[i] = speedRec[i]; continue; }
      let lo = i;
      let hi = i;
      while (lo > i - 2 && lo > 0 && seg[lo - 1] === seg[i]) lo--;
      while (hi < i + 2 && hi < n - 1 && seg[hi + 1] === seg[i]) hi++;
      const dt = (t[hi] - t[lo]) / 1000;
      if (dt > 0) speed[i] = (dist[hi] - dist[lo]) / dt;
    }
    for (let i = 0; i < n; i++) if (!(speed[i] >= 0 && speed[i] <= MAX_SPEED)) speed[i] = NaN;
    interpolateNaN(speed, seg);
  }
  const hasSpeed = speed.some((v) => Number.isFinite(v));
  if (!hasSpeed) speedSource = 'none';

  // Playback timeline with pauses collapsed.
  const playT = new Float64Array(n);
  const pauses: Pause[] = [];
  const threshold = s.pauseThresholdSec * 1000;
  let movingMs = 0;
  for (let i = 1; i < n; i++) {
    const segmentBreak = seg[i] !== seg[i - 1];
    let step: number;
    if (timing === 'untimed') {
      step = segmentBreak ? PAUSE_PLAY_MS : ((dist[i] - dist[i - 1]) / UNTIMED_SPEED) * 1000;
      if (segmentBreak) pauses.push({ index: i - 1, realMs: 0, playStart: playT[i - 1], playEnd: playT[i - 1] + step, segmentBreak });
    } else {
      const dt = Math.max(0, t[i] - t[i - 1]);
      const isPause = segmentBreak || dt > threshold;
      step = isPause && s.skipPauses ? PAUSE_PLAY_MS : dt;
      if (isPause) pauses.push({ index: i - 1, realMs: dt, playStart: playT[i - 1], playEnd: playT[i - 1] + step, segmentBreak });
      else movingMs += dt;
    }
    playT[i] = playT[i - 1] + step;
  }

  let maxSpeed: number | null = null;
  if (hasSpeed) for (let i = 0; i < n; i++) if (Number.isFinite(speed[i]) && (maxSpeed === null || speed[i] > maxSpeed)) maxSpeed = speed[i];

  let eleMin: number | null = null;
  let eleMax: number | null = null;
  let eleGain: number | null = null;
  if (hasEle) {
    let ref = NaN;
    eleGain = 0;
    for (let i = 0; i < n; i++) {
      const e = ele[i];
      if (!Number.isFinite(e)) continue;
      eleMin = eleMin === null ? e : Math.min(eleMin, e);
      eleMax = eleMax === null ? e : Math.max(eleMax, e);
      if (Number.isNaN(ref) || e < ref - GAIN_HYSTERESIS) ref = e;
      else if (e > ref + GAIN_HYSTERESIS) { eleGain += e - ref; ref = e; }
    }
  }

  const timedish = timing !== 'untimed';
  const stats: TrackStats = {
    distance: dist[n - 1],
    duration: playT[n - 1],
    movingMs: timedish ? movingMs : null,
    totalMs: timedish ? t[n - 1] - t[0] : null,
    avgSpeed: hasSpeed && movingMs > 0 ? dist[n - 1] / (movingMs / 1000) : null,
    maxSpeed,
    eleMin,
    eleMax,
    eleGain,
  };

  return {
    name: raw.name || fileName,
    fileName,
    format: raw.format,
    creator: raw.creator,
    timing,
    n,
    segmentCount: segs.length,
    lat, lon, ele, hasEle, t, seg, course, dist, speed, hasSpeed, speedSource,
    playT,
    pauses,
    waypoints: raw.waypoints,
    spikesRemoved,
    stats,
    statedStats: raw.statedStats,
  };
}
