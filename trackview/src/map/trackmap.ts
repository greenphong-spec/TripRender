import {
  AttributionControl, Map as MapLibreMap, Marker, Popup, setWorkerUrl,
  type GeoJSONSource, type LngLatBoundsLike, type MapLayerMouseEvent, type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 ships its tile worker as a separate module; let Vite bundle it and pass the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Sample } from '../model/interpolate';
import type { Track } from '../model/types';
import type { MapStyleId } from '../settings';
import { BLANK_STYLE, MAP_STYLES } from './styles';

setWorkerUrl(workerUrl);

const CHUNK = 32; // points per line feature; travelled chunks are recoloured via feature-state
const STYLE_TIMEOUT_MS = 10_000;
const DEFAULT_VIEW = { center: [106.0, 16.0] as [number, number], zoom: 4.6 }; // Vietnam
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: 'FeatureCollection', features: [] };

function el(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

export interface TrackMapEvents {
  onUserPan(): void;
  onViewChange(view: { lng: number; lat: number; zoom: number }): void;
  onOffline(offline: boolean): void;
}

export class TrackMap {
  readonly map: MapLibreMap;
  private track: Track | null = null;
  private chunkStart: Int32Array = new Int32Array(0);
  private chunkEnd: Int32Array = new Int32Array(0);
  private doneCount = 0;
  private styleReady = false;
  private styleTimer = 0;
  private lastSample: Sample | null = null;

  private cur = new Marker({ element: el('mk-cur') });
  private start = new Marker({ element: el('mk-start') });
  private end = new Marker({ element: el('mk-end') });
  private hover = new Marker({ element: el('mk-hover') });
  private heading = el('heading');
  private popup = new Popup({ closeButton: false, offset: 10 });

  constructor(container: HTMLElement, styleId: MapStyleId, view: { lng: number; lat: number; zoom: number } | null, private events: TrackMapEvents) {
    this.map = new MapLibreMap({
      container,
      style: MAP_STYLES[styleId],
      center: view ? [view.lng, view.lat] : DEFAULT_VIEW.center,
      zoom: view ? view.zoom : DEFAULT_VIEW.zoom,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new AttributionControl({ compact: false }), 'bottom-left');
    this.cur.getElement().appendChild(this.heading);
    this.armStyleTimeout();

    this.map.on('style.load', () => {
      this.styleReady = true;
      clearTimeout(this.styleTimer);
      this.addTrackLayers();
    });
    this.map.on('error', (e) => {
      if (!this.styleReady) this.useBlankStyle();
      else if ((e as unknown as { sourceId?: string }).sourceId) this.events.onOffline(true);
    });
    this.map.on('dragstart', () => this.events.onUserPan());
    this.map.on('moveend', () => {
      const c = this.map.getCenter();
      this.events.onViewChange({ lng: c.lng, lat: c.lat, zoom: this.map.getZoom() });
    });
    this.map.on('click', 'trk-wpt', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const box = document.createElement('div');
      box.className = 'wpt-pop';
      const b = document.createElement('b');
      b.textContent = String(f.properties.name || 'Waypoint');
      const s = document.createElement('span');
      s.textContent = String(f.properties.desc || '');
      box.append(b, s);
      this.popup.setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(box).addTo(this.map);
    });
    this.map.on('mouseenter', 'trk-wpt', () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', 'trk-wpt', () => (this.map.getCanvas().style.cursor = ''));
  }

  setStyle(id: MapStyleId): void {
    this.styleReady = false;
    this.events.onOffline(false);
    this.armStyleTimeout();
    this.map.setStyle(MAP_STYLES[id] as string | StyleSpecification, { diff: false });
  }

  private armStyleTimeout() {
    clearTimeout(this.styleTimer);
    this.styleTimer = window.setTimeout(() => {
      if (!this.styleReady) this.useBlankStyle();
    }, STYLE_TIMEOUT_MS);
  }

  private useBlankStyle() {
    clearTimeout(this.styleTimer);
    this.events.onOffline(true);
    this.map.setStyle(BLANK_STYLE, { diff: false });
  }

  setTrack(track: Track | null): void {
    this.track = track;
    this.popup.remove();
    this.hover.remove();
    this.lastSample = null;
    if (!track) {
      [this.cur, this.start, this.end].forEach((m) => m.remove());
      this.chunkStart = new Int32Array(0);
      this.chunkEnd = new Int32Array(0);
      this.addTrackLayers();
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

    this.start.setLngLat([track.lon[0], track.lat[0]]).addTo(this.map);
    this.end.setLngLat([track.lon[track.n - 1], track.lat[track.n - 1]]).addTo(this.map);
    this.cur.setLngLat([track.lon[0], track.lat[0]]).addTo(this.map);
    this.addTrackLayers();
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
  private addTrackLayers(): void {
    if (!this.styleReady) return;
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
    if (this.lastSample) this.setProgress(this.lastSample, false);
  }

  /** Move the marker and recolour the travelled part of the track. */
  setProgress(s: Sample, playing: boolean, follow = false): void {
    const t = this.track;
    if (!t) return;
    this.lastSample = s;
    this.cur.setLngLat([s.lon, s.lat]);
    this.cur.getElement().classList.toggle('playing', playing);
    this.heading.hidden = !Number.isFinite(s.bearing);
    if (Number.isFinite(s.bearing)) this.cur.getElement().style.setProperty('--heading', `${s.bearing}deg`);

    if (!this.styleReady || !this.map.getSource('trk')) return;

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

    if (follow && playing) this.keepInView(s);
  }

  private keepInView(s: Sample) {
    if (this.map.isMoving()) return;
    const p = this.map.project([s.lon, s.lat]);
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    if (p.x < w * 0.2 || p.x > w * 0.8 || p.y < h * 0.2 || p.y > h * 0.8) {
      this.map.easeTo({ center: [s.lon, s.lat], duration: 600 });
    }
  }

  setHover(s: Sample | null): void {
    if (!s || !this.track) this.hover.remove();
    else this.hover.setLngLat([s.lon, s.lat]).addTo(this.map);
  }

  fit(leftInset: number): void {
    const t = this.track;
    if (!t) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < t.n; i++) {
      minX = Math.min(minX, t.lon[i]); maxX = Math.max(maxX, t.lon[i]);
      minY = Math.min(minY, t.lat[i]); maxY = Math.max(maxY, t.lat[i]);
    }
    const bounds: LngLatBoundsLike = [[minX, minY], [maxX, maxY]];
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const pad = Math.min(60, w / 8, h / 8);
    const left = leftInset + pad < w * 0.6 ? leftInset + pad : pad;
    this.map.fitBounds(bounds, { padding: { top: pad, bottom: pad, left, right: pad + 60 }, maxZoom: 16, duration: 0 });
  }

  zoomBy(delta: number): void {
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: 250 });
  }

  resize(): void {
    this.map.resize();
  }
}
