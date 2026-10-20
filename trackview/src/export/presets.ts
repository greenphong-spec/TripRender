// Video export presets (§13.2, §13.5). Edit these lists to add, remove or re-order options;
// the export dialog builds its controls from them.

/** Speed presets: video time × rate = track time. Realtime is the slowest (no slow motion). */
export const RATE_PRESETS: { rate: number; label: string }[] = [
  { rate: 1, label: 'Realtime' },
  { rate: 2, label: '×2' },
  { rate: 4, label: '×4' },
  { rate: 10, label: '×10' },
  { rate: 30, label: '×30' },
  { rate: 60, label: '×60' },
];
export const DEFAULT_RATE = 10;

export interface Resolution {
  id: string;
  label: string;
  w: number;
  h: number;
}

export const RESOLUTIONS: Resolution[] = [
  { id: '720p', label: '1280×720 (HD)', w: 1280, h: 720 },
  { id: '1080p', label: '1920×1080 (Full HD)', w: 1920, h: 1080 },
  { id: '2160p', label: '3840×2160 (4K)', w: 3840, h: 2160 },
  { id: 'vertical', label: '1080×1920 (vertical, phone)', w: 1080, h: 1920 },
  { id: 'square', label: '1080×1080 (square)', w: 1080, h: 1080 },
];
export const DEFAULT_RESOLUTION = '1080p';
export const FRAME_RATES = [30, 60];

/** Bits per second at 1920×1080, 30 fps; scaled by pixel count and frame rate. */
export const BASE_BITRATE = { standard: 8e6, high: 16e6 };

export function bitrateFor(quality: keyof typeof BASE_BITRATE, w: number, h: number, fps: number): number {
  return Math.round(BASE_BITRATE[quality] * ((w * h) / (1920 * 1080)) * (fps / 30));
}

export function resolutionById(id: string): Resolution {
  return RESOLUTIONS.find((r) => r.id === id) ?? RESOLUTIONS.find((r) => r.id === DEFAULT_RESOLUTION)!;
}

// Intro / outro overview shots (§13.3), in video seconds.
export const INTRO_HOLD_SEC = 2;
export const INTRO_FLY_SEC = 1.5;
export const OUTRO_FLY_SEC = 1.5;
export const OUTRO_HOLD_SEC = 2;

export const FIT_MIN_SEC = 10;
export const LONG_VIDEO_SEC = 30 * 60; // warn above this
export const TILE_WAIT_MS = 10_000; // per frame (§13.7)
export const ZOOM_MIN = 3;
export const ZOOM_MAX = 18;
