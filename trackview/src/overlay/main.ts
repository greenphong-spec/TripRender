import '../styles/tokens.css';
import { setWorkerUrl } from 'maplibre-gl';
// MapLibre 6 ships its tile worker as a separate module (see trackmap.ts).
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { ExportRenderer } from '../export/render';
import { buildTrack } from '../model/build';
import type { Track } from '../model/types';
import { parseTrackFile } from '../parse';
import {
  DEFAULT_EXPORT, DEFAULT_MARKER, DEFAULT_SMART, DEFAULTS,
  type ExportOptions, type MapStyleId, type MarkerSettings, type SmartZoomSettings, type VideoCamera,
} from '../settings';

// Headless overlay renderer (§19): the video-export map driven frame by frame from outside,
// for tools that composite the map onto other footage (dashvid). Driven by tools/overlay-render.mjs.

setWorkerUrl(workerUrl);

export interface OverlayJob {
  fileName: string;
  /** Track file content, base64 (GPX / KML / KMZ). */
  data: string;
  /** Output size in pixels. */
  width: number;
  height: number;
  /** Map pixel ratio (§18.4): lines, labels and the marker are drawn this many times larger. */
  dpr?: number;
  mapStyle?: MapStyleId;
  camera?: VideoCamera;
  tilt?: number;
  /** Zoom when smart zoom is off. */
  zoom?: number;
  /** Zoom from speed (§15), computed for each frame's rate. */
  smartZoom?: boolean;
  smart?: Partial<SmartZoomSettings>;
  marker?: Partial<MarkerSettings>;
}

export interface OverlayFrame {
  /** Track time to show, epoch ms (UTC). */
  t: number;
  /** Track seconds per video second: drives camera smoothing and smart zoom. */
  rate: number;
  fps: number;
}

export interface OverlayInfo {
  start: number;
  end: number;
  points: number;
  styleOk: boolean;
  missingFrames: number;
}

let track: Track | null = null;
let renderer: ExportRenderer | null = null;
let setup: Parameters<ExportRenderer['configure']>[0] | null = null;
let frameNo = 0;

function info(): OverlayInfo {
  return {
    start: track ? track.t[0] : NaN,
    end: track ? track.t[track.n - 1] : NaN,
    points: track?.n ?? 0,
    styleOk: renderer?.styleOk ?? false,
    missingFrames: renderer?.missingFrames ?? 0,
  };
}

async function load(job: OverlayJob): Promise<OverlayInfo> {
  renderer?.destroy();
  renderer = null;
  const bytes = Uint8Array.from(atob(job.data), (c) => c.charCodeAt(0));
  const raw = parseTrackFile(job.fileName, bytes);
  // Pauses are kept at their real length, so the playback position is simply time since the first point.
  track = buildTrack(raw, job.fileName, { ...DEFAULTS, skipPauses: false });
  if (track.timing !== 'timed') throw new Error('The overlay renderer needs a track with a time on every point');

  const even = (n: number) => 2 * Math.round(n / 2);
  const w = even(job.width), h = even(job.height);
  renderer = await ExportRenderer.create(
    { id: 'overlay', label: `${w}×${h}`, w, h, dpr: job.dpr && job.dpr !== 1 ? job.dpr : undefined },
    job.mapStyle ?? 'streets',
  );
  const opts: ExportOptions = {
    ...DEFAULT_EXPORT,
    camera: job.camera ?? 'heading',
    tilt: job.tilt ?? 0,
    zoom: job.zoom ?? 16,
    zoomMode: job.smartZoom === false ? 'fixed' : 'smart',
    intro: false,
    outro: false,
    infoCard: false,
    chart: false,
    title: 'off',
  };
  setup = {
    track,
    units: 'metric',
    marker: { ...DEFAULT_MARKER, ...job.marker },
    smart: { ...DEFAULT_SMART, enabled: true, ...job.smart },
    curve: null,
    opts,
    from: 0,
    to: track.stats.duration,
  };
  await renderer.configure(setup);
  frameNo = 0;
  return info();
}

/** Start a new clip: forget camera smoothing and zoom easing. */
function reset(): void {
  renderer?.reset();
  frameNo = 0;
}

/** Switch the camera between clips (e.g. 'overview' for a whole-route shot); also resets. */
async function camera(cam: VideoCamera): Promise<void> {
  if (!renderer || !setup) throw new Error('load() first');
  if (setup.opts.camera !== cam) {
    setup = { ...setup, opts: { ...setup.opts, camera: cam } };
    await renderer.configure(setup);
  }
  reset();
}

/** Render one frame; returns it as a PNG data URL. */
async function frame(f: OverlayFrame): Promise<string> {
  if (!track || !renderer) throw new Error('load() first');
  const pos = Math.min(Math.max(0, f.t - track.t[0]), track.stats.duration);
  await renderer.renderFrame({ pos, phase: 'main', follow: 1, t: frameNo / f.fps }, { rate: f.rate > 0 ? f.rate : 1, fps: f.fps });
  frameNo++;
  return renderer.canvas.toDataURL('image/png');
}

declare global {
  interface Window {
    trackviewOverlay: {
      load: typeof load; reset: typeof reset; camera: typeof camera; frame: typeof frame; info: typeof info; ready: boolean;
    };
  }
}

window.trackviewOverlay = { load, reset, camera, frame, info, ready: true };
