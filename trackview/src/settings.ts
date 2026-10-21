import { DEFAULT_RATE, DEFAULT_RESOLUTION } from './export/presets';

export type Units = 'metric' | 'imperial';
export type MapStyleId = 'light' | 'streets' | 'satellite';

/** Camera while playing on screen (§13.4); the video adds 'overview'. */
export type CameraMode = 'off' | 'north' | 'heading' | 'keep';
export type VideoCamera = Exclude<CameraMode, 'off'> | 'overview';

export type MarkerKind = 'dot' | 'arrow' | 'icon' | 'image';
export type MarkerIcon = 'car' | 'motorbike' | 'bicycle' | 'walker' | 'truck' | 'boat';
export type MarkerRotation = 'rotate' | 'flip' | 'fixed';

/** Position marker (§14). */
export interface MarkerSettings {
  kind: MarkerKind;
  icon: MarkerIcon;
  sizePx: number;
  color: string;
  halo: boolean;
  rotation: MarkerRotation;
  imageFrontDeg: number; // which way the imported picture faces: 0 = up, 90 = right
  imageDataUrl: string | null;
}

/** Smart zoom (§15): zoom from speed between a near and a far zoom. Null speeds = Auto from the track average. */
export interface SmartZoomSettings {
  enabled: boolean;
  near: number;
  far: number;
  slowKmh: number | null;
  fastKmh: number | null;
}

/** Video export options (§13); From/To are per track and not saved. */
export interface ExportOptions {
  rateMode: 'preset' | 'fit';
  rate: number;
  targetSec: number;
  camera: VideoCamera;
  tilt: number;
  zoom: number;
  zoomMode: 'fixed' | 'smart';
  intro: boolean;
  outro: boolean;
  resolution: string; // id in RESOLUTIONS
  fps: number;
  quality: 'standard' | 'high';
  mapStyle: MapStyleId | 'current';
  infoCard: boolean;
  chart: boolean;
  title: 'off' | 'file' | 'custom';
  titleText: string;
  timeShown: 'elapsed' | 'clock' | 'both';
}

export interface Settings {
  units: Units;
  mapStyle: MapStyleId;
  skipPauses: boolean;
  pauseThresholdSec: number;
  removeSpikes: boolean;
  spikeDistanceM: number;
  estimatedSpeed: 'derived' | 'hidden';
  camera: CameraMode;
  smart: SmartZoomSettings;
  marker: MarkerSettings;
  export: ExportOptions;
  rate: number;
  view: { lng: number; lat: number; zoom: number } | null;
}

/** Settings that change how a track is built (changing them rebuilds the track). */
export type BuildSettings = Pick<
  Settings,
  'skipPauses' | 'pauseThresholdSec' | 'removeSpikes' | 'spikeDistanceM' | 'estimatedSpeed'
>;

export const DEFAULT_SMART: SmartZoomSettings = {
  enabled: false,
  near: 17,
  far: 13,
  slowKmh: null,
  fastKmh: null,
};

export const DEFAULT_MARKER: MarkerSettings = {
  kind: 'icon',
  icon: 'car',
  sizePx: 24,
  color: '#d2401e',
  halo: true,
  rotation: 'rotate',
  imageFrontDeg: 0,
  imageDataUrl: null,
};

export const DEFAULT_EXPORT: ExportOptions = {
  rateMode: 'preset',
  rate: DEFAULT_RATE,
  targetSec: 60,
  camera: 'north',
  tilt: 0,
  zoom: 14,
  zoomMode: 'fixed',
  intro: true,
  outro: true,
  resolution: DEFAULT_RESOLUTION,
  fps: 30,
  quality: 'standard',
  mapStyle: 'current',
  infoCard: true,
  chart: true,
  title: 'off',
  titleText: '',
  timeShown: 'both',
};

export const DEFAULTS: Settings = {
  units: 'metric',
  mapStyle: 'light',
  skipPauses: true,
  pauseThresholdSec: 60,
  removeSpikes: true,
  spikeDistanceM: 50,
  estimatedSpeed: 'derived',
  camera: 'keep',
  smart: DEFAULT_SMART,
  marker: DEFAULT_MARKER,
  export: DEFAULT_EXPORT,
  rate: 120,
  view: null,
};

const KEY = 'trackview.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings> & { follow?: boolean };
      const s: Settings = {
        ...DEFAULTS,
        ...saved,
        marker: { ...DEFAULT_MARKER, ...saved.marker },
        smart: { ...DEFAULT_SMART, ...saved.smart },
        export: { ...DEFAULT_EXPORT, ...saved.export },
      };
      // v0.1 had a follow on/off toggle (§13.4).
      if (!saved.camera && saved.follow !== undefined) s.camera = saved.follow ? 'keep' : 'off';
      delete (s as { follow?: boolean }).follow;
      return s;
    }
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false; // unavailable or full (a large imported marker image)
  }
}
