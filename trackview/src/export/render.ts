import { LngLat, Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import { angleDiff, ViewSmoother } from '../map/camera';
import { drawMarker, markerPose, prepareSprite, type MarkerSprite } from '../map/marker';
import { SmartZoom, smartZoomAvailable } from '../map/smartzoom';
import { BLANK_STYLE, MAP_STYLES, STYLE_ATTRIBUTION } from '../map/styles';
import { TrackLayers, trackBounds } from '../map/tracklayers';
import { curveAt, type ZoomKnot } from '../map/zoomcurve';
import { sampleAt } from '../model/interpolate';
import type { Track } from '../model/types';
import type { ExportOptions, MapStyleId, MarkerSettings, SmartZoomSettings, Units } from '../settings';
import { Overlays } from './overlays';
import { resolutionById, TILE_WAIT_MS } from './presets';
import type { FrameInfo, Plan } from './timeline';

// Frame-by-frame renderer on its own hidden map (§13.1). The visible map is never touched.

const STYLE_TIMEOUT_MS = 10_000;
const HEADING_UP_Y = 0.65;
const KEEP_BOX = 0.2; // keep the marker inside the middle 60 %
const KEEP_PAN_SEC = 0.6;

type Pad = { top: number; bottom: number; left: number; right: number };

interface Cam {
  lon: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
  padding: Pad;
}

export interface RenderSetup {
  track: Track;
  units: Units;
  marker: MarkerSettings;
  smart: SmartZoomSettings;
  /** Zoom curve of the track (§16); with Zoom: Smart the video reads the zoom from it. */
  curve: ZoomKnot[] | null;
  opts: ExportOptions;
  from: number;
  to: number;
}

export class ExportRenderer {
  readonly W: number;
  readonly H: number;
  readonly canvas: HTMLCanvasElement;
  /** False when the online style could not be loaded: plain background (§13.7). */
  styleOk = true;
  /** Frames rendered before all tiles arrived. */
  missingFrames = 0;

  private ctx: CanvasRenderingContext2D;
  private container: HTMLDivElement;
  private map!: MapLibreMap;
  private layers!: TrackLayers;
  private setup!: RenderSetup;
  private sprite!: MarkerSprite;
  private overlays!: Overlays;
  private overview!: Cam;
  private camSmooth = new ViewSmoother(0.3, 1.0);
  private markerSmooth = new ViewSmoother(0, 0.5);
  private smartZoom = new SmartZoom();
  /** Zoom of the follow camera for the current frame (fixed, or smart zoom §15.6). */
  private zoomNow = NaN;
  private flip = false;
  private keep: { lon: number; lat: number; pan: null | { from: [number, number]; to: [number, number]; t0: number } } | null = null;
  private wake: (() => void) | null = null;
  private cancelled = false;

  private constructor(resolution: string, private mapStyle: MapStyleId) {
    const res = resolutionById(resolution);
    this.W = res.w;
    this.H = res.h;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d')!;
    this.container = document.createElement('div');
    this.container.className = 'export-map';
    this.container.style.width = `${this.W}px`;
    this.container.style.height = `${this.H}px`;
    document.body.append(this.container);
  }

  /** Create the hidden map at the output size; the slow part, so it is kept while only options change. */
  static async create(resolution: string, mapStyle: MapStyleId): Promise<ExportRenderer> {
    const r = new ExportRenderer(resolution, mapStyle);
    try {
      await r.init();
    } catch (err) {
      r.destroy();
      throw err;
    }
    return r;
  }

  private async init() {
    this.map = new MapLibreMap({
      container: this.container,
      style: MAP_STYLES[this.mapStyle] as string | StyleSpecification,
      center: [0, 0],
      zoom: 2,
      pixelRatio: 1,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    this.styleOk = await new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => resolve(false), STYLE_TIMEOUT_MS);
      this.map.once('style.load', () => { clearTimeout(timer); resolve(true); });
      this.map.on('error', () => {
        if (!this.map.isStyleLoaded()) { clearTimeout(timer); resolve(false); }
      });
    });
    if (!this.styleOk) {
      this.map.setStyle(BLANK_STYLE, { diff: false });
      await new Promise((r) => this.map.once('style.load', r));
    }
    // Raster tiles fade in by default; a video frame must show them fully.
    for (const layer of this.map.getStyle().layers) {
      if (layer.type === 'raster') this.map.setPaintProperty(layer.id, 'raster-fade-duration', 0);
    }
    this.layers = new TrackLayers(this.map);
  }

  /** Apply track, range, marker and overlay options. */
  async configure(setup: RenderSetup): Promise<void> {
    const { track, opts, from, to } = setup;
    if (!this.setup || this.setup.track !== track) {
      this.layers.setTrack(track);
      this.layers.add();
    }
    this.setup = setup;
    const scale = Math.min(this.W, this.H) / 1080;
    this.sprite = await prepareSprite(setup.marker, scale);
    const attribution = this.styleOk ? STYLE_ATTRIBUTION[this.mapStyle] : '';
    this.overlays = new Overlays(track, setup.units, opts, this.W, this.H, from, to, attribution);

    // Whole-track (or range) overview, clear of the info card and the chart strip.
    const p = Math.round(Math.min(this.W, this.H) * 0.08);
    const landscape = this.W > this.H;
    const cardW = opts.infoCard && landscape ? Math.round(320 * scale) : 0;
    const cardH = opts.infoCard && !landscape ? Math.round(300 * scale) : 0;
    const padding = { top: p + cardH, bottom: p + this.overlays.stripH, left: p + cardW, right: p };
    this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    const c = this.map.cameraForBounds(trackBounds(track, from, to), { padding, maxZoom: 17 });
    const center = c?.center ? LngLat.convert(c.center) : new LngLat(track.lon[0], track.lat[0]);
    this.overview = { lon: center.lng, lat: center.lat, zoom: c?.zoom ?? opts.zoom, bearing: 0, pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } };
    this.reset();
  }

  /** Forget camera state; call before a new render pass. */
  reset(): void {
    this.camSmooth.reset();
    this.markerSmooth.reset();
    this.smartZoom.reset();
    this.keep = null;
    this.flip = false;
    this.missingFrames = 0;
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
    this.wake?.();
  }

  private followCam(pos: number, rate: number, t: number): Cam {
    const { track, opts } = this.setup;
    const base = { top: 0, bottom: this.overlays.stripH, left: 0, right: 0 };
    if (opts.camera === 'overview') return this.overview;
    if (opts.camera === 'keep') {
      const s = sampleAt(track, pos);
      if (!this.keep) this.keep = { lon: s.lon, lat: s.lat, pan: null };
      const k = this.keep;
      if (k.pan) {
        const f = Math.min(1, (t - k.pan.t0) / KEEP_PAN_SEC);
        const e = f * f * (3 - 2 * f);
        k.lon = k.pan.from[0] + (k.pan.to[0] - k.pan.from[0]) * e;
        k.lat = k.pan.from[1] + (k.pan.to[1] - k.pan.from[1]) * e;
        if (f >= 1) k.pan = null;
      }
      return { lon: k.lon, lat: k.lat, zoom: opts.zoom, bearing: 0, pitch: 0, padding: base };
    }
    const v = this.camSmooth.at(track, pos, rate);
    if (opts.camera === 'heading') {
      const availH = this.H - this.overlays.stripH;
      return {
        lon: v.lon, lat: v.lat, zoom: this.zoomNow,
        bearing: Number.isFinite(v.bearing) ? v.bearing : 0,
        pitch: opts.tilt,
        padding: { ...base, top: availH * (HEADING_UP_Y - 0.5) * 2 },
      };
    }
    return { lon: v.lon, lat: v.lat, zoom: this.zoomNow, bearing: 0, pitch: 0, padding: base };
  }

  /** Start a pan when the marker leaves the middle of the frame; cut when it is far outside. */
  private updateKeep(x: number, y: number, lon: number, lat: number, t: number) {
    const k = this.keep;
    if (!k || k.pan) return;
    const h = this.H - this.overlays.stripH;
    const outside = x < 0 || x > this.W || y < 0 || y > h;
    if (outside) {
      k.lon = lon;
      k.lat = lat;
    } else if (x < this.W * KEEP_BOX || x > this.W * (1 - KEEP_BOX) || y < h * KEEP_BOX || y > h * (1 - KEEP_BOX)) {
      k.pan = { from: [k.lon, k.lat], to: [lon, lat], t0: t };
    }
  }

  private blend(a: Cam, b: Cam, f: number): Cam {
    const l = (x: number, y: number) => x + (y - x) * f;
    return {
      lon: l(a.lon, b.lon),
      lat: l(a.lat, b.lat),
      zoom: l(a.zoom, b.zoom),
      bearing: a.bearing + angleDiff(a.bearing, b.bearing) * f,
      pitch: l(a.pitch, b.pitch),
      padding: {
        top: l(a.padding.top, b.padding.top),
        bottom: l(a.padding.bottom, b.padding.bottom),
        left: l(a.padding.left, b.padding.left),
        right: l(a.padding.right, b.padding.right),
      },
    };
  }

  /** Render one frame into `canvas`. */
  async renderFrame(fi: FrameInfo, plan: Pick<Plan, 'rate' | 'fps'>): Promise<void> {
    const { track, opts } = this.setup;
    const s = sampleAt(track, fi.pos);
    const smart = opts.zoomMode === 'smart' && (opts.camera === 'north' || opts.camera === 'heading') && smartZoomAvailable(track);
    const curve = this.setup.curve;
    const z = !smart ? NaN
      : curve ? curveAt(curve, fi.pos)
      : this.smartZoom.update(track, fi.pos, plan.rate, 1 / plan.fps, this.W, this.setup.smart);
    this.zoomNow = Number.isFinite(z) ? z : opts.zoom;
    let cam = this.followCam(fi.pos, plan.rate, fi.t);
    if (fi.follow < 1) cam = this.blend(this.overview, cam, fi.follow);
    this.map.jumpTo({ center: [cam.lon, cam.lat], zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch, padding: cam.padding });
    this.layers.setProgress(s);
    if (!(await this.settle())) this.missingFrames++;

    const ctx = this.ctx;
    ctx.drawImage(this.map.getCanvas(), 0, 0, this.W, this.H);

    const scale = Math.min(this.W, this.H) / 1080;
    const pt = (lon: number, lat: number) => this.map.project([lon, lat]);
    const a = pt(track.lon[0], track.lat[0]);
    const b = pt(track.lon[track.n - 1], track.lat[track.n - 1]);
    drawEndpoints(ctx, a.x, a.y, b.x, b.y, scale);

    const p = pt(s.lon, s.lat);
    if (fi.phase === 'main' && this.setup.opts.camera === 'keep') this.updateKeep(p.x, p.y, s.lon, s.lat, fi.t);
    const screenDeg = this.markerSmooth.at(track, fi.pos, plan.rate).bearing - this.map.getBearing();
    const pose = markerPose(this.setup.marker, screenDeg, this.flip);
    this.flip = pose.flip;
    drawMarker(ctx, this.sprite, p.x, p.y, pose, screenDeg, scale);

    this.overlays.draw(ctx, s, fi.pos);
  }

  /**
   * Draw the map synchronously until every tile and source in view has loaded (or the wait times out).
   * Event-driven rather than requestAnimationFrame, so it keeps going in a background window.
   */
  private async settle(): Promise<boolean> {
    const m = this.map;
    const deadline = performance.now() + TILE_WAIT_MS;
    for (;;) {
      if (this.cancelled) return true;
      // Drawing requests the tiles the view needs; draws are costly, so only draw again once they are all in.
      m.redraw();
      if (m.loaded()) {
        // Symbol placement may need a few more passes.
        for (let i = 0; i < 4 && (m as unknown as { _placementDirty?: boolean })._placementDirty; i++) m.redraw();
        return true;
      }
      while (!this.cancelled && !(m.isStyleLoaded() && m.areTilesLoaded())) {
        const left = deadline - performance.now();
        if (left <= 0) return false;
        await this.nextMapEvent(left);
      }
      if (performance.now() > deadline) return false;
    }
  }

  /** Resolve on the next tile / source event of the export map, or after `ms`. */
  private nextMapEvent(ms: number): Promise<void> {
    const m = this.map;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        m.off('data', done);
        m.off('error', done);
        this.wake = null;
        resolve();
      };
      const timer = window.setTimeout(done, ms);
      m.on('data', done);
      m.on('error', done);
      this.wake = done;
    });
  }

  destroy(): void {
    this.cancel();
    try {
      this.map?.remove();
    } catch {
      /* already gone */
    }
    this.container.remove();
  }
}

function drawEndpoints(ctx: CanvasRenderingContext2D, sx: number, sy: number, ex: number, ey: number, k: number) {
  const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
  ctx.shadowBlur = 2 * k;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(sx, sy, 7 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(ex - 6.5 * k, ey - 6.5 * k, 13 * k, 13 * k);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = css('--start');
  ctx.beginPath();
  ctx.arc(sx, sy, 4 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css('--end');
  ctx.fillRect(ex - 4.5 * k, ey - 4.5 * k, 9 * k, 9 * k);
  ctx.restore();
}
