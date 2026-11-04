import { Overlays } from '../export/overlays';
import { overlayScale, PHONE_DEVICES, phoneDevice, phoneResolutionId, resolutionById } from '../export/presets';
import { STYLE_ATTRIBUTION } from '../map/styles';
import type { Sample } from '../model/interpolate';
import type { Track } from '../model/types';
import type { PhoneViewSettings, Settings } from '../settings';

// Phone view (§18): the live map is shown in a phone-sized frame at the phone's CSS size, scaled down
// only when the window is too small. It is the same MapLibre map, so the camera, smart zoom, dragging
// and zooming behave as in the normal view. The video overlays are drawn over it with the export code.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MARGIN = 20; // free space around the frame (CSS px, before the bezel)
const BEZEL = 10;
const LABEL_H = 22;
const OVERLAY_MS = 66; // overlay redraw interval while playing (~15 per second)

export interface PhoneViewHost {
  settings(): Settings;
  track(): Track | null;
  update(phone: PhoneViewSettings): void;
  /** The frame size or the overlay strip changed: the map needs a resize / new camera inset. */
  onLayout(insetBottom: number): void;
}

export class PhoneView {
  private wrap = document.querySelector<HTMLElement>('.map-wrap')!;
  private mapEl = $('map');
  private canvas = document.createElement('canvas');
  private label = document.createElement('div');
  private overlays: Overlays | null = null;
  private overlayKey = '';
  private last: { s: Sample; pos: number } | null = null;
  private lastDraw = 0;
  private scale = 1;

  constructor(private host: PhoneViewHost) {
    this.canvas.className = 'phone-ov';
    this.label.className = 'phone-label mono';
    this.wrap.append(this.label);

    const sel = $<HTMLSelectElement>('pv-device');
    for (const d of PHONE_DEVICES) {
      const r = resolutionById(phoneResolutionId(d.id));
      sel.append(new Option(`${d.label} · ${d.w}×${d.h} (video ${r.w}×${r.h})`, d.id));
    }
    const patch = (p: Partial<PhoneViewSettings>) => host.update({ ...this.ps, ...p });
    $('pv-enabled').addEventListener('change', (e) => patch({ enabled: (e.target as HTMLInputElement).checked }));
    $('pv-overlays').addEventListener('change', (e) => patch({ overlays: (e.target as HTMLInputElement).checked }));
    sel.addEventListener('change', () => patch({ device: sel.value }));
    $('phone-btn').addEventListener('click', () => this.toggle());
    new ResizeObserver(() => this.layout()).observe(this.wrap);
  }

  private get ps(): PhoneViewSettings {
    return this.host.settings().phone;
  }

  get enabled(): boolean {
    return this.ps.enabled;
  }

  toggle(on = !this.ps.enabled): void {
    this.host.update({ ...this.ps, enabled: on });
  }

  /** Settings, track, units, map style or export overlay options changed. */
  apply(): void {
    const ps = this.ps;
    $<HTMLInputElement>('pv-enabled').checked = ps.enabled;
    $<HTMLInputElement>('pv-overlays').checked = ps.overlays;
    $<HTMLSelectElement>('pv-device').value = phoneDevice(ps.device).id;
    const btn = $('phone-btn');
    btn.classList.toggle('active', ps.enabled);
    btn.setAttribute('aria-pressed', String(ps.enabled));
    this.wrap.classList.toggle('phone-on', ps.enabled);
    this.overlayKey = '';
    this.layout();
  }

  /** Size and place the frame; the map keeps its own CSS size, only the transform scales it to fit. */
  private layout() {
    const ps = this.ps;
    const m = this.mapEl.style;
    if (!ps.enabled) {
      for (const p of ['width', 'height', 'transform'] as const) m[p] = '';
      this.canvas.remove();
      this.wrap.classList.remove('phone-ov-on');
      this.label.hidden = true;
      this.overlays = null;
      this.host.onLayout(0);
      return;
    }
    const d = phoneDevice(ps.device);
    const { clientWidth: ww, clientHeight: wh } = this.wrap;
    const room = 2 * (MARGIN + BEZEL);
    const k = Math.min(1, (ww - room) / d.w, (wh - room - LABEL_H) / d.h);
    this.scale = Math.max(0.1, k);
    m.width = `${d.w}px`;
    m.height = `${d.h}px`;
    m.transform = `translate(-50%, calc(-50% - ${LABEL_H / 2}px)) scale(${this.scale})`;
    const r = resolutionById(phoneResolutionId(d.id));
    this.label.hidden = false;
    this.label.textContent = `${d.label} · ${d.w}×${d.h} · video ${r.w}×${r.h} · ${Math.round(this.scale * 100)} %`;
    this.label.style.top = `${wh / 2 + (d.h * this.scale) / 2 + BEZEL + 4 - LABEL_H / 2}px`;
    this.ensureOverlays();
    this.draw(true);
  }

  /** Build the overlay renderer for the current options (or drop it when overlays are off). */
  private ensureOverlays() {
    const s = this.host.settings();
    const t = this.host.track();
    const on = s.phone.enabled && s.phone.overlays && !!t;
    this.wrap.classList.toggle('phone-ov-on', on);
    if (!on || !t) {
      this.canvas.remove();
      this.overlays = null;
      this.overlayKey = '';
      this.host.onLayout(0);
      return;
    }
    const d = phoneDevice(s.phone.device);
    const r = resolutionById(phoneResolutionId(d.id));
    const o = s.export;
    const key = JSON.stringify([d.id, s.units, s.mapStyle, o.infoCard, o.chart, o.title, o.titleText, o.timeShown, t.fileName, t.n, t.stats.duration]);
    if (key !== this.overlayKey || !this.overlays) {
      this.overlayKey = key;
      this.canvas.width = r.w;
      this.canvas.height = r.h;
      this.overlays = new Overlays(t, s.units, o, r.w, r.h, 0, t.stats.duration, STYLE_ATTRIBUTION[s.mapStyle], overlayScale(r));
    }
    if (this.canvas.parentElement !== this.mapEl) this.mapEl.append(this.canvas);
    this.host.onLayout(this.overlays.stripH / (r.dpr ?? 1));
  }

  /** New playback position; redraws the overlays at most ~15 times a second unless forced. */
  update(s: Sample, pos: number, force: boolean): void {
    this.last = { s, pos };
    this.draw(force);
  }

  private draw(force: boolean) {
    if (!this.overlays || !this.last) return;
    const now = performance.now();
    if (!force && now - this.lastDraw < OVERLAY_MS) return;
    this.lastDraw = now;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.overlays.draw(ctx, this.last.s, this.last.pos);
  }
}
