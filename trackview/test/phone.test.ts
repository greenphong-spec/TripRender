import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markerScale, overlayScale, PHONE_DEVICES, PHONE_OVERLAY_SCALE, phoneDevice, phoneResolutionId, RESOLUTIONS, resolutionById,
} from '../src/export/presets';
import { DEFAULT_PHONE, DEFAULTS, loadSettings } from '../src/settings';

describe('phone view and phone-scale video (§18)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the existing resolutions unchanged (pixel ratio 1, scale = shorter side / 1080)', () => {
    const old = RESOLUTIONS.filter((r) => !r.id.startsWith('phone-'));
    expect(old.map((r) => [r.id, r.w, r.h])).toEqual([
      ['720p', 1280, 720], ['1080p', 1920, 1080], ['2160p', 3840, 2160], ['vertical', 1080, 1920], ['square', 1080, 1080],
    ]);
    for (const r of old) {
      expect(r.dpr).toBeUndefined();
      expect(overlayScale(r)).toBe(Math.min(r.w, r.h) / 1080);
      expect(markerScale(r)).toBe(Math.min(r.w, r.h) / 1080);
    }
  });

  it('has one phone-scale resolution per phone: CSS size × pixel ratio, even sizes', () => {
    for (const d of PHONE_DEVICES) {
      const r = resolutionById(phoneResolutionId(d.id));
      expect(r.id).toBe(`phone-${d.id}`);
      expect(r.w % 2).toBe(0);
      expect(r.h % 2).toBe(0);
      expect(r.w / r.dpr!).toBeCloseTo(d.w, 6);
      expect(Math.abs(r.h / r.dpr! - d.h)).toBeLessThan(1);
      expect(markerScale(r)).toBe(r.dpr);
      expect(overlayScale(r)).toBeCloseTo(r.dpr! * PHONE_OVERLAY_SCALE, 9);
    }
    expect(resolutionById('phone-p916')).toMatchObject({ w: 1080, h: 1920, dpr: 3 });
    expect(resolutionById('phone-p209')).toMatchObject({ w: 1080, h: 2400, dpr: 2.5 });
    expect(resolutionById('phone-p195')).toMatchObject({ w: 1170, h: 2532, dpr: 3 });
  });

  it('falls back to the default phone for an unknown id', () => {
    expect(phoneDevice('nope').id).toBe(DEFAULT_PHONE.device);
  });

  it('is off by default, and older saved settings load with the default phone view', () => {
    expect(DEFAULTS.phone).toEqual({ enabled: false, device: 'p916', overlays: true });
    const saved = { ...DEFAULTS } as Partial<typeof DEFAULTS>;
    delete saved.phone;
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem: () => {} });
    expect(loadSettings().phone).toEqual(DEFAULT_PHONE);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ ...saved, phone: { enabled: true } }), setItem: () => {} });
    expect(loadSettings().phone).toEqual({ ...DEFAULT_PHONE, enabled: true });
  });
});
