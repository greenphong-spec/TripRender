import { indexAt, type Sample } from '../model/interpolate';
import { chartSeries } from '../model/series';
import type { Track } from '../model/types';
import {
  clockText, distUnit, distValue, eleUnit, eleValue, fmt, hms, humanDuration, latLonText, speedUnit, speedValue,
} from '../model/units';
import type { ExportOptions, Units } from '../settings';

// Info card, speed chart strip, title and attribution drawn straight onto the video frame (§13.5).
// Sizes are CSS pixels of the app, scaled by the frame's shorter side / 1080.

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const font = (weight: number, size: number, mono = false) => `${weight} ${size}px ${mono ? css('--mono') : css('--font')}`;
const STRIP_FRACTION = 0.16;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export class Overlays {
  /** Height of the chart strip at the bottom (0 when off); the camera keeps the marker above it. */
  readonly stripH: number;
  private readonly u: number;
  private todo: AnyCanvas | null = null;
  private done: AnyCanvas | null = null;
  private plot = { x: 0, w: 0 };

  constructor(
    private track: Track,
    private units: Units,
    private opts: ExportOptions,
    private W: number,
    private H: number,
    private from: number,
    private to: number,
    private attribution: string,
    /** Size factor; default shorter side / 1080 (phone scale passes its own, §18.4). */
    u = Math.min(W, H) / 1080,
  ) {
    this.u = u;
    const series = opts.chart ? chartSeries(track, units) : null;
    this.stripH = series && series.mode !== 'none' ? Math.round(H * STRIP_FRACTION) : 0;
    if (series && this.stripH) this.buildStrip(series.ys, series.unit, series.mode === 'ele');
  }

  draw(ctx: Ctx, s: Sample, pos: number): void {
    if (this.stripH) this.drawStrip(ctx, pos);
    if (this.opts.infoCard) this.drawCard(ctx, s, pos);
    const title = this.opts.title === 'file' ? this.track.fileName : this.opts.title === 'custom' ? this.opts.titleText.trim() : '';
    if (title) this.drawTitle(ctx, title);
    this.drawAttribution(ctx);
  }

  // ---------- Info card (mirrors §7.2) ----------
  private drawCard(ctx: Ctx, s: Sample, pos: number) {
    const u = this.u;
    const t = this.track;
    const units = this.units;
    const x0 = 24 * u, y0 = 24 * u, w = 272 * u, pad = 18 * u;
    const clock = clockText(s.clock);
    const [clockTime, clockDate] = clock.includes(' · ') ? clock.split(' · ') : [clock, ''];
    const big = this.opts.timeShown === 'clock' ? (Number.isFinite(s.clock) ? clockTime : '—') : hms(pos);
    const small = this.opts.timeShown === 'elapsed' ? '' : this.opts.timeShown === 'clock' ? clockDate : clock;

    const badges: [string, boolean][] = [];
    if (t.timing === 'estimated') badges.push(['Estimated time', false]);
    if (t.timing === 'untimed') badges.push(['No time data', false]);
    if (s.pause && s.pause.realMs > 0) badges.push([`Paused ${humanDuration(s.pause.realMs)}`, true]);

    const [lat, lon] = latLonText(s.lat, s.lon);
    const cells: [string, string, string][] = [
      ['Speed', fmt(t.hasSpeed ? speedValue(s.speed, units) : NaN, 1), speedUnit(units)],
      ['Distance', fmt(distValue(s.dist, units), 1), distUnit(units)],
      ['Elevation', fmt(t.hasEle ? eleValue(s.ele, units) : NaN, 0), eleUnit(units)],
    ];

    const timeH = 34 * u, smallH = small ? 17 * u : 0, badgeH = badges.length ? 28 * u : 0;
    const gridTop = pad + timeH + smallH + badgeH + 12 * u;
    const rowH = 44 * u;
    const h = gridTop + 15 * u + rowH * 2 + 4 * u + pad - 6 * u;

    ctx.save();
    ctx.shadowColor = 'rgba(20, 30, 30, 0.16)';
    ctx.shadowBlur = 16 * u;
    ctx.shadowOffsetY = 4 * u;
    ctx.fillStyle = css('--surface');
    roundRect(ctx, x0, y0, w, h, 12 * u);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.textBaseline = 'alphabetic';
    let y = y0 + pad + 28 * u;
    ctx.fillStyle = css('--text-muted');
    ctx.font = font(500, 11 * u);
    ctx.textAlign = 'left';
    ctx.fillText(this.opts.timeShown === 'clock' ? 'TIME' : 'AT', x0 + pad, y);
    ctx.fillStyle = css('--text');
    ctx.font = font(500, 30 * u, true);
    ctx.textAlign = 'right';
    ctx.fillText(big, x0 + w - pad, y);
    if (small) {
      y += smallH;
      ctx.fillStyle = css('--text-faint');
      ctx.font = font(400, 11.5 * u, true);
      ctx.fillText(small, x0 + w - pad, y);
    }
    if (badges.length) {
      let bx = x0 + pad;
      const by = y + 10 * u;
      ctx.font = font(400, 11 * u);
      ctx.textAlign = 'left';
      for (const [text, pause] of badges) {
        const bw = ctx.measureText(text).width + 16 * u;
        ctx.fillStyle = pause ? css('--accent-tint') : css('--page');
        roundRect(ctx, bx, by, bw, 19 * u, 9.5 * u);
        ctx.fill();
        ctx.fillStyle = pause ? css('--accent') : css('--text-muted');
        ctx.fillText(text, bx + 8 * u, by + 13.5 * u);
        bx += bw + 6 * u;
      }
    }

    const gy = y0 + gridTop;
    ctx.fillStyle = css('--border');
    ctx.fillRect(x0 + pad, gy, w - 2 * pad, Math.max(1, u));
    const colW = (w - 2 * pad - 12 * u) / 2;
    const cell = (c: number, r: number) => [x0 + pad + c * (colW + 12 * u), gy + 15 * u + r * rowH] as const;
    ctx.textAlign = 'left';
    cells.forEach(([k, v, unit], i) => {
      const [cx, cy] = cell(i % 2, Math.floor(i / 2));
      ctx.fillStyle = css('--text-muted');
      ctx.font = font(400, 12 * u);
      ctx.fillText(k, cx, cy + 12 * u);
      ctx.fillStyle = css('--text');
      ctx.font = font(500, 19 * u, true);
      ctx.fillText(v, cx, cy + 36 * u);
      const vw = ctx.measureText(v).width;
      ctx.fillStyle = css('--text-muted');
      ctx.font = font(400, 11 * u);
      ctx.fillText(unit, cx + vw + 5 * u, cy + 36 * u);
    });
    const [px, py] = cell(1, 1);
    ctx.fillStyle = css('--text-muted');
    ctx.font = font(400, 12 * u);
    ctx.fillText('Position', px, py + 12 * u);
    ctx.fillStyle = css('--text');
    ctx.font = font(400, 11.5 * u, true);
    ctx.fillText(lat, px, py + 30 * u);
    ctx.fillText(lon, px, py + 47 * u);
    ctx.restore();
  }

  // ---------- Chart strip (mirrors §7.4) ----------
  private buildStrip(ys: number[], unit: string, ele: boolean) {
    const t = this.track;
    const u = this.u;
    const W = this.W;
    const h = this.stripH;
    const left = 44 * u, right = 24 * u, top = 20 * u, bottom = 10 * u;
    const pw = W - left - right, ph = h - top - bottom;
    this.plot = { x: left, w: pw };

    const i0 = indexAt(t, this.from);
    const i1 = Math.min(t.n - 1, indexAt(t, this.to) + 1);
    const span = Math.max(1, this.to - this.from);
    let yMin = Infinity, yMax = -Infinity;
    for (let i = i0; i <= i1; i++) if (Number.isFinite(ys[i])) { yMin = Math.min(yMin, ys[i]); yMax = Math.max(yMax, ys[i]); }
    if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
    const lo = ele ? yMin - (yMax - yMin) * 0.1 - 1 : 0;
    const hi = yMax + (yMax - yMin) * 0.12 + 1;
    const X = (playT: number) => left + ((playT - this.from) / span) * pw;
    const Y = (v: number) => top + ph - ((v - lo) / (hi - lo)) * ph;

    // One point per pixel column (the max), which keeps peaks visible.
    const cols = Math.max(2, Math.round(pw));
    const colY = new Float64Array(cols).fill(NaN);
    for (let i = i0; i <= i1; i++) {
      if (!Number.isFinite(ys[i])) continue;
      const c = Math.round(((t.playT[i] - this.from) / span) * (cols - 1));
      if (c < 0 || c >= cols) continue;
      if (!(colY[c] >= ys[i])) colY[c] = ys[i];
    }
    const line = new Path2D();
    const area = new Path2D();
    let started = false, lastX = left;
    for (let c = 0; c < cols; c++) {
      if (!Number.isFinite(colY[c])) continue;
      const x = left + (c / (cols - 1)) * pw, y = Y(colY[c]);
      if (!started) { line.moveTo(x, y); area.moveTo(x, top + ph); area.lineTo(x, y); started = true; }
      else { line.lineTo(x, y); area.lineTo(x, y); }
      lastX = x;
    }
    area.lineTo(lastX, top + ph);
    area.closePath();

    const step = niceStep((hi - lo) / 3.5);
    const layer = (doneLayer: boolean) => {
      const c = makeCanvas(W, h);
      const g = c.getContext('2d') as Ctx;
      g.fillStyle = css('--surface');
      g.fillRect(0, 0, W, h);
      g.fillStyle = css('--border');
      g.fillRect(0, 0, W, Math.max(1, u));
      if (doneLayer) {
        g.fillStyle = css('--accent-tint');
        g.fillRect(left, top, pw, ph);
      }
      g.strokeStyle = css('--grid');
      g.lineWidth = Math.max(1, u);
      g.fillStyle = css('--text-faint');
      g.font = font(400, 10.5 * u, true);
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
        const y = Math.round(Y(v)) + 0.5;
        g.beginPath(); g.moveTo(left, y); g.lineTo(left + pw, y); g.stroke();
        g.fillText(String(Math.round(v)), left - 6 * u, y);
      }
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = css('--text-muted');
      g.font = font(400, 11 * u);
      g.fillText(unit, 10 * u, 5 * u);
      g.fillStyle = doneLayer ? css('--chart-fill-done') : css('--chart-fill');
      g.fill(area);
      g.strokeStyle = css('--chart-line');
      g.lineWidth = 1.6 * u;
      g.lineJoin = 'round';
      g.stroke(line);
      // Collapsed pauses: dashed break marks.
      g.strokeStyle = css('--text-faint');
      g.setLineDash([3 * u, 3 * u]);
      g.lineWidth = Math.max(1, u);
      for (const p of t.pauses) {
        if (p.realMs <= 0 || p.playEnd - p.playStart >= p.realMs) continue;
        const mid = (p.playStart + p.playEnd) / 2;
        if (mid < this.from || mid > this.to) continue;
        const x = Math.round(X(mid)) + 0.5;
        g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + ph); g.stroke();
      }
      return c;
    };
    this.todo = layer(false);
    this.done = layer(true);
  }

  private drawStrip(ctx: Ctx, pos: number) {
    const y0 = this.H - this.stripH;
    const f = Math.min(1, Math.max(0, (pos - this.from) / Math.max(1, this.to - this.from)));
    const x = Math.round(this.plot.x + f * this.plot.w);
    ctx.drawImage(this.todo!, 0, y0);
    if (x > 0) ctx.drawImage(this.done!, 0, 0, x, this.stripH, 0, y0, x, this.stripH);
    ctx.fillStyle = css('--accent');
    ctx.fillRect(x - Math.max(1, this.u), y0 + 4 * this.u, Math.max(2, 2 * this.u), this.stripH - 4 * this.u);
  }

  // ---------- Title and attribution ----------
  private drawTitle(ctx: Ctx, text: string) {
    const u = this.u;
    ctx.save();
    ctx.font = font(600, 22 * u);
    const tw = Math.min(ctx.measureText(text).width, this.W * 0.6);
    const w = tw + 36 * u, h = 44 * u;
    const x = (this.W - w) / 2, y = 24 * u;
    ctx.shadowColor = 'rgba(20, 30, 30, 0.16)';
    ctx.shadowBlur = 12 * u;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
    roundRect(ctx, x, y, w, h, 10 * u);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = css('--text');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.W / 2, y + h / 2, tw);
    ctx.restore();
  }

  private drawAttribution(ctx: Ctx) {
    if (!this.attribution) return;
    const u = this.u;
    ctx.save();
    ctx.font = font(400, 12 * u);
    const tw = ctx.measureText(this.attribution).width;
    const padX = 6 * u, h = 18 * u;
    const x = this.W - tw - padX * 2, y = this.H - this.stripH - h;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    ctx.fillRect(x, y, tw + padX * 2, h);
    ctx.fillStyle = '#333';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.attribution, x + padX, y + h / 2);
    ctx.restore();
  }
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
