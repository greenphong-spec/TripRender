import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Sample } from '../model/interpolate';
import type { Track } from '../model/types';

const CHUNK = 32; // points per line feature; travelled chunks are recoloured via feature-state
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

/**
 * Track line (travelled / remaining) and waypoint layers on a MapLibre map.
 * Shared by the visible map and the video export map.
 */
export class TrackLayers {
  private track: Track | null = null;
  private chunkStart: Int32Array = new Int32Array(0);
  private chunkEnd: Int32Array = new Int32Array(0);
  private doneCount = 0;
  private lastSample: Sample | null = null;

  constructor(private map: MapLibreMap) {}

  setTrack(track: Track | null): void {
    this.track = track;
    this.lastSample = null;
    if (!track) {
      this.chunkStart = new Int32Array(0);
      this.chunkEnd = new Int32Array(0);
      return;
    }
    // Split each segment into short line chunks that share their end vertex.
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < track.n; ) {
      let segEnd = i;
      while (segEnd + 1 < track.n && track.seg[segEnd + 1] === track.seg[i]) segEnd++;
      for (let s = i; s < segEnd; s += CHUNK) {
        starts.push(s);
        ends.push(Math.min(s + CHUNK, segEnd));
      }
      i = segEnd + 1;
    }
    this.chunkStart = Int32Array.from(starts);
    this.chunkEnd = Int32Array.from(ends);
  }

  private trackData(): FC {
    const t = this.track;
    if (!t) return EMPTY;
    const features: GeoJSON.Feature[] = [];
    for (let c = 0; c < this.chunkStart.length; c++) {
      const coords: [number, number][] = [];
      for (let i = this.chunkStart[c]; i <= this.chunkEnd[c]; i++) coords.push([t.lon[i], t.lat[i]]);
      features.push({ type: 'Feature', id: c, properties: {}, geometry: { type: 'LineString', coordinates: coords } });
    }
    return { type: 'FeatureCollection', features };
  }

  private waypointData(): FC {
    return {
      type: 'FeatureCollection',
      features: (this.track?.waypoints ?? []).map((w) => ({
        type: 'Feature',
        properties: { name: w.name, desc: w.desc },
        geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
      })),
    };
  }

  /** (Re)create sources and layers; needed after every style change. */
  add(): void {
    const m = this.map;
    for (const id of ['trk-wpt', 'trk-head', 'trk-line']) if (m.getLayer(id)) m.removeLayer(id);
    for (const id of ['trk', 'trk-head', 'trk-wpt']) if (m.getSource(id)) m.removeSource(id);

    m.addSource('trk', { type: 'geojson', data: this.trackData(), tolerance: 0.2 });
    m.addSource('trk-head', { type: 'geojson', data: EMPTY, tolerance: 0 });
    m.addSource('trk-wpt', { type: 'geojson', data: this.waypointData() });
    const done = ['boolean', ['feature-state', 'done'], false];
    m.addLayer({
      id: 'trk-line',
      type: 'line',
      source: 'trk',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['case', done, css('--accent'), css('--remaining')] as never,
        'line-width': ['case', done, 4.5, 3.5] as never,
      },
    });
    m.addLayer({
      id: 'trk-head',
      type: 'line',
      source: 'trk-head',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': css('--accent'), 'line-width': 4.5 },
    });
    m.addLayer({
      id: 'trk-wpt',
      type: 'circle',
      source: 'trk-wpt',
      paint: {
        'circle-radius': 5,
        'circle-color': css('--waypoint'),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    // Feature-state was lost with the old source: re-apply the current progress.
    this.doneCount = 0;
    if (this.lastSample) this.setProgress(this.lastSample);
  }

  /** Recolour the travelled part of the track up to the sample. */
  setProgress(s: Sample): void {
    const t = this.track;
    this.lastSample = s;
    if (!t || !this.map.getSource('trk')) return;

    // Chunks entirely behind the marker are "done".
    const reached = s.f > 0 && !s.pause ? s.i + 1 : s.i;
    let lo = 0;
    let hi = this.chunkEnd.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.chunkEnd[mid] <= s.i) lo = mid + 1;
      else hi = mid;
    }
    const doneCount = lo;
    if (doneCount !== this.doneCount) {
      const [a, b, v] = doneCount > this.doneCount ? [this.doneCount, doneCount, true] : [doneCount, this.doneCount, false];
      for (let c = a; c < b; c++) this.map.setFeatureState({ source: 'trk', id: c }, { done: v });
      this.doneCount = doneCount;
    }

    // Partial line from the start of the current chunk up to the marker.
    const head: [number, number][] = [];
    const c = doneCount;
    if (c < this.chunkStart.length && this.chunkStart[c] <= s.i && t.seg[this.chunkStart[c]] === t.seg[s.i]) {
      for (let i = this.chunkStart[c]; i <= s.i; i++) head.push([t.lon[i], t.lat[i]]);
      if (reached > s.i) head.push([s.lon, s.lat]);
    }
    (this.map.getSource('trk-head') as GeoJSONSource).setData(
      head.length >= 2 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: head } } : EMPTY,
    );
  }
}

/** Bounding box of the track (or the points between two playback positions). */
export function trackBounds(track: Track, from = 0, to = Infinity): [[number, number], [number, number]] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < track.n; i++) {
    if (track.playT[i] < from || track.playT[i] > to) continue;
    minX = Math.min(minX, track.lon[i]); maxX = Math.max(maxX, track.lon[i]);
    minY = Math.min(minY, track.lat[i]); maxY = Math.max(maxY, track.lat[i]);
  }
  if (!Number.isFinite(minX)) return trackBounds(track);
  return [[minX, minY], [maxX, maxY]];
}
