export interface RawPoint {
  lat: number;
  lon: number;
  ele: number | null; // metres
  t: number | null; // epoch ms, UTC
  speed: number | null; // recorded, m/s
  course: number | null; // recorded, degrees
}

export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
  ele: number | null;
  t: number | null;
  desc: string;
}

export type Format = 'gpx' | 'kml' | 'kmz';

/** Parser output: geometry and attributes exactly as found in the file. */
export interface RawTrack {
  name: string;
  creator: string;
  format: Format;
  segments: RawPoint[][];
  waypoints: Waypoint[];
  /** Start/end time when there are no per-point times (e.g. dashcam export). */
  timeHint?: { start: number; end: number };
  /** Summary values stated in the file's description, km/h. */
  statedStats?: { maxKmh?: number; avgKmh?: number };
}

export type Timing = 'timed' | 'estimated' | 'untimed';

export interface Pause {
  /** Index of the last point before the pause; the next point is index + 1. */
  index: number;
  realMs: number;
  playStart: number;
  playEnd: number;
  segmentBreak: boolean;
}

export interface TrackStats {
  distance: number; // metres
  duration: number; // ms of playback timeline
  movingMs: number | null;
  totalMs: number | null;
  avgSpeed: number | null; // m/s
  maxSpeed: number | null; // m/s
  eleMin: number | null;
  eleMax: number | null;
  eleGain: number | null;
}

/** Cleaned track with per-point derived arrays, all aligned by index. */
export interface Track {
  name: string;
  fileName: string;
  format: Format;
  creator: string;
  timing: Timing;
  n: number;
  segmentCount: number;
  lat: Float64Array;
  lon: Float64Array;
  ele: Float64Array; // NaN when missing
  hasEle: boolean;
  t: Float64Array; // epoch ms; NaN when untimed
  seg: Int32Array;
  course: Float64Array; // degrees; NaN when not recorded
  dist: Float64Array; // cumulative metres, not bridging segment breaks
  speed: Float64Array; // m/s; NaN when unknown
  hasSpeed: boolean;
  speedSource: 'recorded' | 'derived' | 'none';
  playT: Float64Array; // playback timeline, ms from 0
  pauses: Pause[];
  waypoints: Waypoint[];
  spikesRemoved: number;
  stats: TrackStats;
  statedStats?: { maxKmh?: number; avgKmh?: number };
}
