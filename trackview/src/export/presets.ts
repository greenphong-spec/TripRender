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
  /**
   * Phone scale (§18): the map is drawn at w/dpr × h/dpr CSS pixels with this pixel ratio, as on the phone,
   * so lines, labels and the marker keep their on-screen size. Absent = pixel ratio 1 (§13.1).
   */
  dpr?: number;
}

/** Phone screens for the phone view and phone-scale videos (§18): CSS size × pixel ratio = video size. */
export interface PhoneDevice {
  id: string;
  label: string;
  w: number;
  h: number;
  dpr: number;
}

export const PHONE_DEVICES: PhoneDevice[] = [
  { id: 'p916', label: 'Phone 9:16', w: 360, h: 640, dpr: 3 }, // 1080×1920
  { id: 'p209', label: 'Android 20:9', w: 432, h: 960, dpr: 2.5 }, // 1080×2400
  { id: 'p195', label: 'iPhone 19.5:9', w: 390, h: 844, dpr: 3 }, // 1170×2532
];
export const DEFAULT_PHONE_DEVICE = 'p916';

export function phoneDevice(id: string): PhoneDevice {
  return PHONE_DEVICES.find((d) => d.id === id) ?? PHONE_DEVICES.find((d) => d.id === DEFAULT_PHONE_DEVICE)!;
}

/** Video size of a phone screen (rounded to even pixels for the encoder). */
export function phoneVideoSize(d: PhoneDevice): { w: number; h: number } {
  const even = (n: number) => 2 * Math.round(n / 2);
  return { w: even(d.w * d.dpr), h: even(d.h * d.dpr) };
}

/** Id of the export resolution that matches a phone screen. */
export const phoneResolutionId = (deviceId: string) => `phone-${deviceId}`;

export const RESOLUTIONS: Resolution[] = [
  { id: '720p', label: '1280×720 (HD)', w: 1280, h: 720 },
  { id: '1080p', label: '1920×1080 (Full HD)', w: 1920, h: 1080 },
  { id: '2160p', label: '3840×2160 (4K)', w: 3840, h: 2160 },
  { id: 'vertical', label: '1080×1920 (vertical, phone)', w: 1080, h: 1920 },
  { id: 'square', label: '1080×1080 (square)', w: 1080, h: 1080 },
  ...PHONE_DEVICES.map((d) => {
    const { w, h } = phoneVideoSize(d);
    return { id: phoneResolutionId(d.id), label: `${w}×${h} phone scale (${d.label})`, w, h, dpr: w / d.w };
  }),
];

/** Overlay size factor of a phone-scale video, relative to its pixel ratio (§18.4). */
export const PHONE_OVERLAY_SCALE = 0.75;

/** Scale of the burned-in overlays (§13.5: shorter side / 1080; phone scale §18.4). */
export function overlayScale(r: Resolution): number {
  return r.dpr ? r.dpr * PHONE_OVERLAY_SCALE : Math.min(r.w, r.h) / 1080;
}

/** CSS px → output px for the marker and the start/end points (phone scale: the pixel ratio). */
export function markerScale(r: Resolution): number {
  return r.dpr ?? Math.min(r.w, r.h) / 1080;
}
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
