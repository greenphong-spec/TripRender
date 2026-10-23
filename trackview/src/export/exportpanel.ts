import { markerImageUrl } from '../map/marker';
import { smartZoomAvailable } from '../map/smartzoom';
import type { ZoomKnot } from '../map/zoomcurve';
import type { Track } from '../model/types';
import { hms, humanDuration } from '../model/units';
import type { ExportOptions, MapStyleId, Settings } from '../settings';
import { SmartZoomFields, type SmartZoomHost } from '../ui/smartzoomfields';
import { downloadBlob, fileSink, isTauri, memorySink, pickCodec, VideoWriter, type Codec } from './encode';
import {
  bitrateFor, FRAME_RATES, LONG_VIDEO_SEC, RATE_PRESETS, RESOLUTIONS, resolutionById,
} from './presets';
import { ExportRenderer } from './render';
import { frameAt, makePlan, parseClock, type Plan } from './timeline';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const NUMERIC: (keyof ExportOptions)[] = ['tilt', 'zoom', 'fps'];
const BROWSER_MEMORY_WARN = 2 * 1024 ** 3;
const PREVIEW_DELAY_MS = 250;

export interface ExportHost {
  /** Smart zoom values, shared with the settings drawer (§15.6). */
  smartHost: SmartZoomHost;
  track(): Track | null;
  settings(): Settings;
  update(patch: Partial<Settings>): void;
  playerPos(): number;
  pausePlayer(): void;
  mapZoom(): number;
  /** The track's zoom curve (§16), used by Zoom: Smart. */
  zoomCurve(): ZoomKnot[] | null;
  openMarkerSettings(): void;
  toast(message: string, error?: boolean): void;
}

const mmss = (sec: number) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function bytesText(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} kB`;
}

const videoLength = (sec: number) => (sec >= 3600 ? humanDuration(sec * 1000) : mmss(sec));

/** Video export dialog (§13.6). */
export class ExportPanel {
  rendering = false;
  private root = $('export');
  private form = $<HTMLFormElement>('ex-form');
  private range: 'all' | 'custom' = 'all';
  private from = 0;
  private to = 0;
  private rangeTrack: Track | null = null;
  private renderer: ExportRenderer | null = null;
  private mapKey = '';
  private cfgKey = '';
  private queue: Promise<unknown> = Promise.resolve();
  private previewTimer = 0;
  private cancelRequested = false;
  private result: { blob: Blob; name: string } | null = null;
  private smartFields: SmartZoomFields;

  constructor(private host: ExportHost) {
    this.smartFields = new SmartZoomFields($('ex-smart-fields'), host.smartHost);
    const rates = $('ex-rates');
    for (const p of RATE_PRESETS) rates.append(this.chip(String(p.rate), p.label));
    rates.append(this.chip('fit', 'Fit to duration'));
    rates.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
      if (!b) return;
      this.patch(b.dataset.v === 'fit' ? { rateMode: 'fit' } : { rateMode: 'preset', rate: Number(b.dataset.v) });
    });
    for (const r of RESOLUTIONS) $('ex-resolution').append(new Option(r.label, r.id));
    for (const f of FRAME_RATES) $('ex-fps').append(new Option(`${f} fps`, String(f)));

    $('ex-range').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-range]');
      if (!b) return;
      this.range = b.dataset.range as 'all' | 'custom';
      this.render();
      this.schedulePreview();
    });
    for (const id of ['ex-from', 'ex-to'] as const) {
      $(id).addEventListener('change', (e) => {
        const sec = parseClock((e.target as HTMLInputElement).value);
        if (Number.isFinite(sec)) this.setRangeEnd(id === 'ex-from' ? 'from' : 'to', sec * 1000);
        else this.render();
      });
    }
    $('ex-range-rows').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-use]');
      if (b) this.setRangeEnd(b.dataset.use as 'from' | 'to', this.host.playerPos());
    });

    this.form.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.type === 'range') this.onField(el);
    });
    this.form.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      if (!(el instanceof HTMLInputElement && el.type === 'range') && el.name) this.onField(el);
    });
    $('ex-use-zoom').addEventListener('click', () => this.patch({ zoom: Math.round(this.host.mapZoom() * 2) / 2 }));
    $('ex-marker-btn').addEventListener('click', () => this.host.openMarkerSettings());

    $('export-close').addEventListener('click', () => this.toggle(false));
    $('ex-render').addEventListener('click', () => this.renderVideo());
    $('ex-cancel').addEventListener('click', () => this.cancel());
    $('ex-back').addEventListener('click', () => this.showView('setup'));
    $('ex-save').addEventListener('click', () => {
      if (this.result) downloadBlob(this.result.blob, this.result.name);
    });
  }

  private chip(v: string, label: string) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = v;
    b.textContent = label;
    return b;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  toggle(open = this.root.hidden): void {
    if (!open && this.rendering) return;
    if (open && !this.host.track()) return;
    this.root.hidden = !open;
    if (open) {
      this.syncRange();
      this.showView('setup');
      this.render();
      this.schedulePreview();
    } else {
      clearTimeout(this.previewTimer);
      this.enqueue(async () => this.dropRenderer());
    }
  }

  /** Settings or the loaded track changed elsewhere (units, marker, map style, rebuild). */
  refresh(): void {
    if (!this.isOpen || this.rendering) return;
    if (!this.host.track()) return this.toggle(false);
    this.syncRange();
    this.render();
    this.schedulePreview();
  }

  private opts(): ExportOptions {
    return this.host.settings().export;
  }

  private patch(p: Partial<ExportOptions>) {
    this.host.update({ export: { ...this.opts(), ...p } });
    this.render();
    this.schedulePreview();
  }

  private onField(el: HTMLInputElement | HTMLSelectElement) {
    const key = el.name as keyof ExportOptions;
    if (key === 'targetSec') {
      const sec = parseClock(el.value);
      if (Number.isFinite(sec) && sec > 0) this.patch({ targetSec: Math.round(sec) });
      else this.render();
      return;
    }
    let value: unknown = el.value;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
    else if (NUMERIC.includes(key)) value = Number(el.value);
    this.patch({ [key]: value } as Partial<ExportOptions>);
  }

  // ---------- Range ----------
  private syncRange() {
    const t = this.host.track();
    if (!t) return;
    if (t !== this.rangeTrack) {
      this.rangeTrack = t;
      this.range = 'all';
      this.from = 0;
      this.to = t.stats.duration;
    }
  }

  private setRangeEnd(which: 'from' | 'to', ms: number) {
    const t = this.host.track();
    if (!t) return;
    const v = Math.min(Math.max(0, ms), t.stats.duration);
    if (which === 'from') this.from = v;
    else this.to = v;
    if (this.from > this.to) [this.from, this.to] = [this.to, this.from];
    this.range = 'custom';
    this.render();
    this.schedulePreview();
  }

  private span(): [number, number] {
    const t = this.host.track()!;
    return this.range === 'all' ? [0, t.stats.duration] : [this.from, this.to];
  }

  private plan(): Plan {
    const o = this.opts();
    const [from, to] = this.span();
    const fly = o.camera !== 'overview';
    return makePlan({ from, to, rateMode: o.rateMode, rate: o.rate, targetSec: o.targetSec, fps: o.fps, intro: o.intro && fly, outro: o.outro && fly });
  }

  private mapStyle(): MapStyleId {
    const o = this.opts();
    return o.mapStyle === 'current' ? this.host.settings().mapStyle : o.mapStyle;
  }

  // ---------- View ----------
  private render() {
    const t = this.host.track();
    if (!t) return;
    const o = this.opts();
    for (const el of Array.from(this.form.elements) as (HTMLInputElement | HTMLSelectElement)[]) {
      const key = el.name as keyof ExportOptions;
      if (!key || !(key in o)) continue;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(o[key]);
      else if (key === 'targetSec') { if (document.activeElement !== el) el.value = mmss(o.targetSec); }
      else el.value = String(o[key]);
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#ex-rates button')) {
      b.classList.toggle('active', b.dataset.v === 'fit' ? o.rateMode === 'fit' : o.rateMode === 'preset' && Number(b.dataset.v) === o.rate);
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#ex-range button')) b.classList.toggle('active', b.dataset.range === this.range);
    $('ex-fit-row').hidden = o.rateMode !== 'fit';
    $('ex-range-rows').hidden = this.range !== 'custom';
    $<HTMLInputElement>('ex-from').value = hms(this.from);
    $<HTMLInputElement>('ex-to').value = hms(this.to);
    $('ex-tilt-row').hidden = o.camera !== 'heading';
    $('ex-tilt-v').textContent = `${o.tilt}°`;
    const overview = o.camera === 'overview';
    // Smart zoom needs a centred camera and speed data (§15.6).
    const smartOk = (o.camera === 'north' || o.camera === 'heading') && smartZoomAvailable(t);
    const smart = smartOk && o.zoomMode === 'smart';
    $('ex-zoommode-row').hidden = !(o.camera === 'north' || o.camera === 'heading');
    ($('ex-zoommode').querySelector('option[value=smart]') as HTMLOptionElement).disabled = !smartZoomAvailable(t);
    $('ex-zoommode').title = smartZoomAvailable(t) ? '' : 'Smart zoom needs speed data';
    $('ex-smart-fields').hidden = !smart;
    if (smart) this.smartFields.render();
    $('ex-zoom-row').hidden = overview || smart;
    $('ex-use-zoom').hidden = overview || smart;
    $('ex-intro-row').hidden = overview;
    $('ex-outro-row').hidden = overview;
    $('ex-zoom-v').textContent = o.zoom.toFixed(1);
    $('ex-title-row').hidden = o.title !== 'custom';

    const ms = this.host.settings().marker;
    const url = markerImageUrl(ms);
    const box = $('ex-marker-img');
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      box.replaceChildren(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = ms.color;
      box.replaceChildren(dot);
    }
    this.renderSummary();
  }

  private renderSummary() {
    const o = this.opts();
    const plan = this.plan();
    const res = resolutionById(o.resolution);
    const bitrate = bitrateFor(o.quality, res.w, res.h, o.fps);
    const bytes = (bitrate * plan.seconds) / 8;
    const extra = plan.total - plan.main;
    const rate = plan.rate >= 10 ? Math.round(plan.rate) : Math.round(plan.rate * 10) / 10;
    $('ex-summary').textContent =
      `Speed ×${rate} · video ${videoLength((plan.main - 1) / plan.fps)}` +
      (extra ? ` + ${Math.round(extra / plan.fps)} s intro/outro` : '') +
      `\n${plan.total.toLocaleString('en-US')} frames · ${res.w}×${res.h} · ${o.fps} fps` +
      `\nAbout ${bytesText(bytes)}`;

    const warn: string[] = [];
    if (plan.seconds > LONG_VIDEO_SEC) {
      warn.push(`${videoLength(plan.seconds)} video, ~${bytesText(bytes)} — consider ×10 or Fit to duration.`);
    }
    if (!isTauri() && bytes > BROWSER_MEMORY_WARN) {
      warn.push('In the browser the whole video is kept in memory until saved; this size may fail. The desktop app writes straight to disk.');
    }
    if (this.renderer && !this.renderer.styleOk) warn.push('Map tiles unavailable — the video will have a plain background.');
    $('ex-warn').hidden = !warn.length;
    $('ex-warn').textContent = warn.join('\n');
  }

  private showView(v: 'setup' | 'progress' | 'done') {
    $('ex-setup').hidden = v !== 'setup';
    $('ex-progress').hidden = v !== 'progress';
    $('ex-done').hidden = v !== 'done';
  }

  // ---------- Renderer and preview ----------
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  private dropRenderer() {
    this.renderer?.destroy();
    this.renderer = null;
    this.mapKey = '';
    this.cfgKey = '';
  }

  /** Create or re-configure the hidden export map for the current options. */
  private async ensureRenderer(): Promise<ExportRenderer> {
    const s = this.host.settings();
    const o = s.export;
    const style = this.mapStyle();
    const mapKey = `${o.resolution}|${style}`;
    if (!this.renderer || mapKey !== this.mapKey) {
      this.dropRenderer();
      this.renderer = await ExportRenderer.create(o.resolution, style);
      this.mapKey = mapKey;
    }
    const [from, to] = this.span();
    const track = this.host.track()!;
    const curve = this.host.zoomCurve();
    const cfgKey = JSON.stringify([o, s.marker, s.smart, s.units, from, to, track.fileName, track.n, track.stats.duration, curve]);
    if (cfgKey !== this.cfgKey) {
      await this.renderer.configure({ track, units: s.units, marker: s.marker, smart: s.smart, curve, opts: o, from, to });
      this.cfgKey = cfgKey;
    }
    return this.renderer;
  }

  private schedulePreview() {
    clearTimeout(this.previewTimer);
    $('ex-preview-note').hidden = false;
    $('ex-preview-note').textContent = 'Updating preview…';
    this.previewTimer = window.setTimeout(() => {
      this.enqueue(() => this.drawPreview()).catch((err) => {
        console.error(err);
        $('ex-preview-note').textContent = 'Preview unavailable';
      });
    }, PREVIEW_DELAY_MS);
  }

  private async drawPreview() {
    if (!this.isOpen || this.rendering || !this.host.track()) return;
    const r = await this.ensureRenderer();
    if (!this.isOpen) return;
    const plan = this.plan();
    const pos = Math.min(Math.max(this.host.playerPos(), plan.from), plan.to);
    r.reset();
    await r.renderFrame({ pos, phase: 'main', follow: 1, t: 0 }, plan);
    const c = $<HTMLCanvasElement>('ex-preview-canvas');
    const w = Math.max(1, $('ex-preview').clientWidth);
    c.width = w * devicePixelRatio;
    c.height = Math.round((w * r.H) / r.W) * devicePixelRatio;
    c.getContext('2d')!.drawImage(r.canvas, 0, 0, c.width, c.height);
    $('ex-preview-note').hidden = true;
    this.renderSummary();
  }

  // ---------- Rendering ----------
  private fileName(codec: Codec): string {
    const t = this.host.track()!;
    const o = this.opts();
    const base = t.fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'track';
    const rate = o.rateMode === 'fit' ? `${o.targetSec}s` : `x${o.rate}`;
    const res = resolutionById(o.resolution);
    const size = res.w > res.h ? `${res.h}p` : `${res.w}x${res.h}`;
    return `${base}_${rate}_${size}.${codec.ext}`;
  }

  private async renderVideo() {
    if (this.rendering || !this.host.track()) return;
    const o = this.opts();
    const res = resolutionById(o.resolution);
    const bitrate = bitrateFor(o.quality, res.w, res.h, o.fps);
    const codec = await pickCodec(res.w, res.h, o.fps, bitrate);
    if (!codec) {
      this.host.toast(`This system cannot encode ${res.w}×${res.h} video (no H.264 or VP9 encoder). Try a smaller resolution.`, true);
      return;
    }
    const name = this.fileName(codec);
    let sink;
    try {
      sink = isTauri() ? await fileSink(name, codec) : memorySink();
    } catch (err) {
      this.host.toast(`Could not create the file: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }
    if (!sink) return; // Save As cancelled

    this.rendering = true;
    this.cancelRequested = false;
    this.result = null;
    this.host.pausePlayer();
    clearTimeout(this.previewTimer);
    $('export-block').hidden = false;
    $('export-close').hidden = true;
    this.showView('progress');
    $('ex-prog-text').textContent = 'Preparing…';
    $<HTMLProgressElement>('ex-bar').value = 0;

    let writer: VideoWriter | null = null;
    try {
      await this.enqueue(async () => {
        const r = await this.ensureRenderer();
        const plan = this.plan();
        r.reset();
        writer = new VideoWriter(r.canvas, codec, plan.fps, bitrate, sink);
        await writer.start();
        const thumb = $<HTMLCanvasElement>('ex-thumb');
        thumb.width = 320 * devicePixelRatio;
        thumb.height = Math.round((320 * r.H) / r.W) * devicePixelRatio;
        const t0 = performance.now();
        let lastText = 0, lastThumb = 0;
        for (let k = 0; k < plan.total; k++) {
          if (this.cancelRequested) break;
          await r.renderFrame(frameAt(plan, k), plan);
          if (this.cancelRequested) break;
          await writer.add(k);
          const now = performance.now();
          if (now - lastText > 250 || k === plan.total - 1) {
            lastText = now;
            const done = k + 1;
            const elapsed = (now - t0) / 1000;
            const remain = (elapsed / done) * (plan.total - done);
            $<HTMLProgressElement>('ex-bar').value = done / plan.total;
            $('ex-prog-text').textContent =
              `Frame ${done.toLocaleString('en-US')} / ${plan.total.toLocaleString('en-US')} · ${Math.floor((done / plan.total) * 100)} %` +
              `\nElapsed ${hms(elapsed * 1000)} · remaining ${hms(remain * 1000)}`;
          }
          if (now - lastThumb > 1000) {
            lastThumb = now;
            thumb.getContext('2d')!.drawImage(r.canvas, 0, 0, thumb.width, thumb.height);
          }
        }
        if (this.cancelRequested) {
          await writer.cancel();
          await sink.discard();
          return;
        }
        $('ex-prog-text').textContent = 'Finishing the file…';
        await writer.finalize();
        await sink.close();

        const blob = sink.result(codec.mime);
        const lines = [`Video ready: ${videoLength(plan.seconds)}, ${plan.total.toLocaleString('en-US')} frames.`];
        if (sink.path) lines.push(`Saved to ${sink.path}`);
        if (r.missingFrames) lines.push(`${r.missingFrames.toLocaleString('en-US')} frame${r.missingFrames === 1 ? ' was' : 's were'} rendered with missing tiles.`);
        if (blob) {
          lines.push(`Size ${bytesText(blob.size)}.`);
          this.result = { blob, name };
        }
        $('ex-done-text').textContent = lines.join('\n');
        $('ex-save').hidden = !blob;
      });
      this.showView(this.cancelRequested ? 'setup' : 'done');
    } catch (err) {
      console.error(err);
      await (writer as VideoWriter | null)?.cancel().catch(() => {});
      await sink.discard();
      this.host.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, true);
      this.showView('setup');
    } finally {
      this.rendering = false;
      $('export-block').hidden = true;
      $('export-close').hidden = false;
      if (!$('ex-setup').hidden) this.schedulePreview();
    }
  }

  private cancel() {
    this.cancelRequested = true;
    this.renderer?.cancel();
  }
}
