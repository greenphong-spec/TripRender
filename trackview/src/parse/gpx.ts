import type { RawPoint, RawTrack, Waypoint } from '../model/types';
import { child, childText, descendants, parseXml, type XNode } from './xml';

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export const parseTime = (s: string | undefined): number | null => {
  if (!s) return null;
  const v = Date.parse(s);
  return Number.isFinite(v) ? v : null;
};

function readPoint(p: XNode): RawPoint | null {
  const lat = num(p.attrs.lat);
  const lon = num(p.attrs.lon);
  if (lat === null || lon === null) return null;
  let ele: number | null = null;
  let t: number | null = null;
  let speed: number | null = null;
  let course: number | null = null;
  for (const c of p.children) {
    switch (c.name) {
      case 'ele': ele = num(c.text.trim()); break;
      case 'time': t = parseTime(c.text.trim()); break;
      case 'speed': speed = num(c.text.trim()); break; // GPX 1.0
      case 'course': course = num(c.text.trim()); break; // GPX 1.0, degrees
      case 'extensions':
        for (const e of descendants(c, 'speed')) speed ??= num(e.text.trim()); // Garmin TrackPointExtension
        for (const e of descendants(c, 'course')) course ??= num(e.text.trim());
        for (const m of descendants(c, 'meta')) {
          // Geo Tracker: s = speed (m/s), c = course (radians)
          speed ??= num(m.attrs.s);
          const rad = num(m.attrs.c);
          if (course === null && rad !== null) course = (rad * 180) / Math.PI;
        }
        break;
    }
  }
  return { lat, lon, ele, t, speed, course };
}

function readWaypoint(w: XNode): Waypoint | null {
  const lat = num(w.attrs.lat);
  const lon = num(w.attrs.lon);
  if (lat === null || lon === null) return null;
  return {
    name: childText(w, 'name') ?? '',
    lat,
    lon,
    ele: num(childText(w, 'ele')),
    t: parseTime(childText(w, 'time')),
    desc: childText(w, 'desc') ?? '',
  };
}

export function parseGpx(text: string): RawTrack {
  const root = parseXml(text);
  if (root.name !== 'gpx') throw new Error('Not a GPX file');

  const segments: RawPoint[][] = [];
  const trks = root.children.filter((c) => c.name === 'trk');
  for (const trk of trks) {
    for (const seg of trk.children) {
      if (seg.name !== 'trkseg') continue;
      const pts = seg.children.filter((c) => c.name === 'trkpt').map(readPoint);
      const valid = pts.filter((p): p is RawPoint => p !== null);
      if (valid.length) segments.push(valid);
    }
  }
  if (!segments.length) {
    // Fall back to routes when the file has no tracks.
    for (const rte of root.children.filter((c) => c.name === 'rte')) {
      const valid = rte.children
        .filter((c) => c.name === 'rtept')
        .map(readPoint)
        .filter((p): p is RawPoint => p !== null);
      if (valid.length) segments.push(valid);
    }
  }

  const waypoints = root.children
    .filter((c) => c.name === 'wpt')
    .map(readWaypoint)
    .filter((w): w is Waypoint => w !== null);

  const meta = child(root, 'metadata');
  const name = (meta && childText(meta, 'name')) || (trks[0] && childText(trks[0], 'name')) || '';

  return { name, creator: root.attrs.creator ?? '', format: 'gpx', segments, waypoints };
}
