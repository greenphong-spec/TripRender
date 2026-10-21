import {
  AttributionControl, Map as MapLibreMap, Marker, Popup, setWorkerUrl,
  type MapLayerMouseEvent, type StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 ships its tile worker as a separate module; let Vite bundle it and pass the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { Sample } from '../model/interpolate';
import type { Track } from '../model/types';
import { DEFAULT_SMART, type CameraMode, type MapStyleId, type MarkerSettings, type SmartZoomSettings } from '../settings';
import { ViewSmoother } from './camera';
import { MarkerView } from './marker';
import { SmartZoom, smartZoomAvailable } from './smartzoom';
import { BLANK_STYLE, MAP_STYLES } from './styles';
import { TrackLayers, trackBounds } from './tracklayers';

setWorkerUrl(workerUrl);

const STYLE_TIMEOUT_MS = 10_000;
const DEFAULT_VIEW = { center: [106.0, 16.0] as [number, number], zoom: 4.6 }; // Vietnam
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };
const HEADING_UP_Y = 0.65; // marker height in heading-up mode, as a fraction of the view (§13.4)

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
  private layers: TrackLayers;
  private styleReady = false;
  private styleTimer = 0;
  private camera: CameraMode = 'off';

  private markerView = new MarkerView();
  private cur: Marker;
  private start = new Marker({ element: el('mk-start') });
  private end = new Marker({ element: el('mk-end') });
  private hover = new Marker({ element: el('mk-hover') });
  private popup = new Popup({ closeButton: false, offset: 10 });
  private camSmooth = new ViewSmoother(0.3, 1.0);
  private markerSmooth = new ViewSmoother(0, 0.5);
  private smart = new SmartZoom();
  private smartSettings: SmartZoomSettings = DEFAULT_SMART;
  /** Zoom last set by smart zoom; a different map zoom on the next frame is a manual zoom (§15.5). */
  private autoZoom = NaN;
  private lastFrame = 0;

  constructor(container: HTMLElement, styleId: MapStyleId, view: { lng: number; lat: number; zoom: number } | null, marker: MarkerSettings, private events: TrackMapEvents) {
    this.map = new MapLibreMap({
      container,
      style: MAP_STYLES[styleId],
      center: view ? [view.lng, view.lat] : DEFAULT_VIEW.center,
      zoom: view ? view.zoom : DEFAULT_VIEW.zoom,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.layers = new TrackLayers(this.map);
    this.markerView.set(marker);
    this.cur = new Marker({ element: this.markerView.el });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new AttributionControl({ compact: false }), 'bottom-left');
    this.armStyleTimeout();

    this.map.on('style.load', () => {
      this.styleReady = true;
      clearTimeout(this.styleTimer);
      this.layers.add();
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
    this.camSmooth.reset();
    this.markerSmooth.reset();
    this.resetSmartZoom();
    this.layers.setTrack(track);
    if (!track) {
      [this.cur, this.start, this.end].forEach((m) => m.remove());
    } else {
      this.start.setLngLat([track.lon[0], track.lat[0]]).addTo(this.map);
      this.end.setLngLat([track.lon[track.n - 1], track.lat[track.n - 1]]).addTo(this.map);
      this.cur.setLngLat([track.lon[0], track.lat[0]]).addTo(this.map);
    }
    if (this.styleReady) this.layers.add();
  }

  setMarker(ms: MarkerSettings): void {
    this.markerView.set(ms);
  }

  setSmartZoom(sz: SmartZoomSettings): void {
    this.smartSettings = sz;
    this.autoZoom = NaN;
  }

  /** Smart zoom drives the zoom: on, a centred follow mode and a track with speed (§15.1). */
  get smartActive(): boolean {
    return this.smartSettings.enabled && (this.camera === 'north' || this.camera === 'heading') && smartZoomAvailable(this.track);
  }

  /** Forget the manual zoom offset (file load, fit). */
  private resetSmartZoom() {
    this.smart.reset();
    this.autoZoom = NaN;
  }

  /** Change the camera mode; leaving heading-up turns the map back to north up. */
  setCamera(mode: CameraMode): void {
    const was = this.camera;
    this.camera = mode;
    if (was !== 'heading' || mode === 'heading') return;
    const reset = () => this.map.easeTo({ bearing: 0, padding: NO_PADDING, duration: 400 });
    if (this.map.isMoving()) this.map.once('moveend', reset);
    else reset();
  }

  /** Move the marker, recolour the travelled part and move the camera while playing. */
  setProgress(s: Sample, pos: number, rate: number, playing: boolean): void {
    const t = this.track;
    if (!t) return;
    this.cur.setLngLat([s.lon, s.lat]);
    const heading = this.markerSmooth.at(t, pos, rate).bearing;
    if (this.styleReady) this.layers.setProgress(s);

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (playing && this.camera !== 'off' && !this.map.isZooming()) {
      if (this.camera === 'keep') this.keepInView(s);
      else {
        const v = this.camSmooth.at(t, pos, rate);
        const up = this.camera === 'heading';
        let zoom: number | undefined;
        if (this.smartActive) {
          // A wheel / button zoom since the last frame shifts the whole curve instead of stopping smart zoom.
          if (Number.isFinite(this.autoZoom) && Math.abs(this.map.getZoom() - this.autoZoom) > 1e-3) {
            this.smart.shift(this.map.getZoom() - this.autoZoom);
          }
          const z = this.smart.update(t, pos, rate, dt, this.map.getContainer().clientWidth, this.smartSettings);
          if (Number.isFinite(z)) zoom = z;
        }
        this.map.jumpTo({
          center: [v.lon, v.lat],
          zoom,
          bearing: up && Number.isFinite(v.bearing) ? v.bearing : up ? this.map.getBearing() : 0,
          padding: up ? { ...NO_PADDING, top: this.map.getContainer().clientHeight * (HEADING_UP_Y - 0.5) * 2 } : NO_PADDING,
        });
        this.autoZoom = zoom === undefined ? NaN : this.map.getZoom();
      }
    } else if (!playing) this.autoZoom = NaN;
    this.markerView.update(heading - this.map.getBearing(), playing);
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
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const pad = Math.min(60, w / 8, h / 8);
    const left = leftInset + pad < w * 0.6 ? leftInset + pad : pad;
    this.resetSmartZoom();
    this.map.setPadding(NO_PADDING);
    this.map.fitBounds(trackBounds(t), {
      padding: { top: pad, bottom: pad, left, right: pad + 60 }, maxZoom: 16, duration: 0, bearing: 0,
    });
  }

  zoomBy(delta: number): void {
    this.map.easeTo({ zoom: this.map.getZoom() + delta, duration: 250 });
  }

  resize(): void {
    this.map.resize();
  }
}
