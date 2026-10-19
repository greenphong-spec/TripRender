export type Units = 'metric' | 'imperial';
export type MapStyleId = 'light' | 'streets' | 'satellite';

export interface Settings {
  units: Units;
  mapStyle: MapStyleId;
  skipPauses: boolean;
  pauseThresholdSec: number;
  removeSpikes: boolean;
  spikeDistanceM: number;
  estimatedSpeed: 'derived' | 'hidden';
  follow: boolean;
  rate: number;
  view: { lng: number; lat: number; zoom: number } | null;
}

/** Settings that change how a track is built (changing them rebuilds the track). */
export type BuildSettings = Pick<
  Settings,
  'skipPauses' | 'pauseThresholdSec' | 'removeSpikes' | 'spikeDistanceM' | 'estimatedSpeed'
>;

export const DEFAULTS: Settings = {
  units: 'metric',
  mapStyle: 'light',
  skipPauses: true,
  pauseThresholdSec: 60,
  removeSpikes: true,
  spikeDistanceM: 50,
  estimatedSpeed: 'derived',
  follow: true,
  rate: 120,
  view: null,
};

const KEY = 'trackview.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
