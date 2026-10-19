import { haversine } from '../model/geo';
import type { Format, RawPoint, RawTrack, Waypoint } from '../model/types';
import { parseTime } from './gpx';
import { child, childText, descendants, firstDescendant, parseXml, type XNode } from './xml';

/** "lon,lat[,alt]" tuples separated by whitespace. */
function parseCoordinates(text: string): RawPoint[] {
  const out: RawPoint[] = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const [lon, lat, alt] = tuple.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ lat, lon, ele: Number.isFinite(alt) ? alt : null, t: null, speed: null, course: null });
  }
  return out;
}

function arrayData(track: XNode, name: string): number[] | null {
  for (const d of descendants(track, 'SimpleArrayData')) {
    if (d.attrs.name !== name) continue;
    return d.children.filter((c) => c.name === 'value').map((v) => {
      const x = Number(v.text.trim());
      return v.text.trim() !== '' && Number.isFinite(x) ? x : NaN;
    });
  }
  return null;
}

function parseGxTrack(track: XNode): RawPoint[] {
  const whens: (number | null)[] = [];
  const coords: RawPoint[] = [];
  for (const c of track.children) {
    if (c.name === 'when') whens.push(parseTime(c.text.trim()));
    else if (c.name === 'coord') {
      const [lon, lat, alt] = c.text.trim().split(/\s+/).map(Number);
      coords.push({
        lat, lon,
        ele: Number.isFinite(alt) ? alt : null,
        t: null, speed: null, course: null,
      });
    }
  }
  const speed = arrayData(track, 'speed');
  const course = arrayData(track, 'course');
  // Geo Tracker stores course in radians; treat the whole array as radians if it fits in [0, 2π].
  const courseRad = !!course && course.every((v) => Number.isNaN(v) || (v >= 0 && v <= 2 * Math.PI + 0.01));

  const out: RawPoint[] = [];
  coords.forEach((p, i) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    p.t = whens[i] ?? null;
    const s = speed?.[i];
    if (s !== undefined && !Number.isNaN(s)) p.speed = s;
    const c = course?.[i];
    if (c !== undefined && !Number.isNaN(c)) p.course = courseRad ? (c * 180) / Math.PI : c;
    out.push(p);
  });
  return out;
}

/** Dashcam exports: "Start: 2026-09-19 08:41:09   End: 2026-09-19 09:19:24   (camera time, Asia/Saigon)". */
const CAMERA_OFFSET = '+07:00';
function timeHintFromText(text: string): { start: number; end: number } | undefined {
  const m = /Start:\s*(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d).*?End:\s*(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/s.exec(text);
  if (!m) return undefined;
  const start = Date.parse(`${m[1]}T${m[2]}${CAMERA_OFFSET}`);
  const end = Date.parse(`${m[3]}T${m[4]}${CAMERA_OFFSET}`);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : undefined;
}

function statedStatsFromText(text: string): RawTrack['statedStats'] {
  const max = /Max speed:\s*([\d.]+)\s*km\/h/i.exec(text);
  const avg = /Average:\s*([\d.]+)\s*km\/h/i.exec(text);
  if (!max && !avg) return undefined;
  return { maxKmh: max ? Number(max[1]) : undefined, avgKmh: avg ? Number(avg[1]) : undefined };
}

export function parseKml(text: string, format: Format = 'kml'): RawTrack {
  const root = parseXml(text);
  if (root.name !== 'kml') throw new Error('Not a KML file');
  const doc = firstDescendant(root, 'Document') ?? root;

  const placemarks = [...descendants(root, 'Placemark')];
  const gxTracks = placemarks.flatMap((p) => [...descendants(p, 'Track')]);

  let segments: RawPoint[][];
  if (gxTracks.length) {
    segments = gxTracks.map(parseGxTrack);
  } else {
    segments = placemarks.flatMap((p) =>
      [...descendants(p, 'LineString')].map((ls) => parseCoordinates(childText(ls, 'coordinates') ?? '')),
    );
  }
  segments = segments.filter((s) => s.length > 0);

  const waypoints: Waypoint[] = [];
  for (const p of placemarks) {
    if (firstDescendant(p, 'LineString') || firstDescendant(p, 'Track')) continue;
    const pt = firstDescendant(p, 'Point');
    if (!pt) continue;
    const c = parseCoordinates(childText(pt, 'coordinates') ?? '')[0];
    if (!c) continue;
    const ts = child(p, 'TimeStamp');
    waypoints.push({
      name: childText(p, 'name') ?? '',
      lat: c.lat,
      lon: c.lon,
      ele: c.ele,
      t: ts ? parseTime(childText(ts, 'when')) : null,
      desc: childText(p, 'description') ?? '',
    });
  }

  // Drop "Start"/"End" pins that only duplicate the track's first and last point.
  const first = segments[0]?.[0];
  const lastSeg = segments[segments.length - 1];
  const last = lastSeg?.[lastSeg.length - 1];
  const near = (w: Waypoint, p?: RawPoint) => !!p && haversine(w.lat, w.lon, p.lat, p.lon) < 5;
  const pins = waypoints.filter(
    (w) => !((/^start$/i.test(w.name) && near(w, first)) || (/^end$/i.test(w.name) && near(w, last))),
  );

  const description = childText(doc, 'description') ?? '';
  let timeHint = timeHintFromText(description);
  if (!timeHint) {
    const span = child(doc, 'TimeSpan');
    const start = span ? parseTime(childText(span, 'begin')) : null;
    const end = span ? parseTime(childText(span, 'end')) : null;
    if (start !== null && end !== null && end > start) timeHint = { start, end };
  }

  return {
    name: childText(doc, 'name') ?? '',
    creator: '',
    format,
    segments,
    waypoints: pins,
    timeHint,
    statedStats: statedStatsFromText(description),
  };
}
