import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { indexAt } from '../model/interpolate';
import type { Track } from '../model/types';
import { distUnit, distValue, eleUnit, eleValue, hms, speedUnit, speedValue } from '../model/units';
import type { Units } from '../settings';

const SMOOTH = 5; // moving-average window for display only
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export type ChartMode = 'speed' | 'ele' | 'none';

export interface ChartEvents {
  onSeek(pos: number): void;
  onScrub(active: boolean): void;
  onHover(pos: number | null): void;
}

/** Keep at most ~2 points per pixel: min and max of each bucket, in order. */
function decimate(x: number[], y: number[], buckets: number): [number[], number[]] {
  if (x.length <= buckets * 2) return [x, y];
  const ox: number[] = [];
  const oy: number[] = [];
  const size = x.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size);
    const e = Math.min(x.length, Math.floor((b + 1) * size));
    let lo = s, hi = s;
    for (let i = s; i < e; i++) {
      if (y[i] < y[lo]) lo = i;
      if (y[i] > y[hi]) hi = i;
    }
    for (const i of lo < hi ? [lo, hi] : lo > hi ? [hi, lo] : [lo]) {
      ox.push(x[i]);
      oy.push(y[i]);
    }
  }
  return [ox, oy];
}

export class SpeedChart {
  mode: ChartMode = 'none';
  private u: uPlot | null = null;
  private track: Track | null = null;
  private pos = 0;
  private cursorPx = -1;
  private cursorEl = document.createElement('div');
  private handleEl = document.createElement('div');
  private scrubbing = false;
  private pauseMarks: number[] = [];
  private units: Units = 'metric';

  constructor(
    private host: HTMLElement,
    private tip: HTMLElement,
    private unitLabel: HTMLElement,
    private events: ChartEvents,
  ) {
    this.cursorEl.className = 'chart-cursor';
    this.handleEl.className = 'chart-handle';
    new ResizeObserver(() => this.resize()).observe(host);
  }

  setTrack(track: Track | null, units: Units): void {
    this.track = track;
    this.units = units;
    this.u?.destroy();
    this.u = null;
    this.mode = !track ? 'none' : track.hasSpeed ? 'speed' : track.hasEle ? 'ele' : 'none';
    this.unitLabel.textContent = this.mode === 'speed' ? speedUnit(units) : this.mode === 'ele' ? eleUnit(units) : '';
    if (!track || this.mode === 'none') return;

    const xs: number[] = Array.from(track.playT, (v) => v / 1000);
    const raw = this.mode === 'speed' ? track.speed : track.ele;
    const conv = this.mode === 'speed' ? (v: number) => speedValue(v, units) : (v: number) => eleValue(v, units);
    const ys: number[] = new Array(track.n);
    const half = Math.floor(SMOOTH / 2);
    for (let i = 0; i < track.n; i++) {
      let sum = 0, cnt = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(track.n - 1, i + half); k++) {
        if (track.seg[k] === track.seg[i] && Number.isFinite(raw[k])) { sum += raw[k]; cnt++; }
      }
      ys[i] = cnt ? conv(sum / cnt) : NaN;
    }
    const [dx, dy] = decimate(xs, ys, Math.max(200, this.host.clientWidth));

    const finite = dy.filter(Number.isFinite);
    const yMin = this.mode === 'ele' ? Math.min(...finite) : 0;
    const yMax = Math.max(...finite);
    this.pauseMarks = track.pauses.filter((p) => p.realMs > 0 && p.playEnd - p.playStart < p.realMs).map((p) => (p.playStart + p.playEnd) / 2000);

    const fillDone = css('--chart-fill-done');
    const fillTodo = css('--chart-fill');
    const tint = css('--accent-tint');
    const opts: uPlot.Options = {
      width: this.host.clientWidth,
      height: this.host.clientHeight,
      legend: { show: false },
      padding: [8, 0, 0, 0],
      cursor: {
        x: false,
        y: false,
        drag: { x: false, y: false, setScale: false },
        points: { size: 10, width: 2, fill: css('--hover'), stroke: '#ffffff' },
      },
      scales: {
        x: { time: false, range: [0, track.playT[track.n - 1] / 1000 || 1] },
        y: { range: () => [yMin - (this.mode === 'ele' ? (yMax - yMin) * 0.1 + 1 : 0), yMax + (yMax - yMin) * 0.12 + 1] },
      },
      axes: [
        { show: false },
        {
          size: 36,
          gap: 4,
          stroke: css('--text-faint'),
          font: `10.5px ${css('--mono')}`,
          ticks: { show: false },
          grid: { stroke: css('--grid'), width: 1 },
          splits: (_u, _i, min, max) => {
            const step = niceStep((max - min) / 3.5);
            const out: number[] = [];
            for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
            return out;
          },
          values: (_u, vals) => vals.map((v) => String(Math.round(v))),
        },
      ],
      series: [
        {},
        {
          stroke: css('--chart-line'),
          width: 1.6,
          points: { show: false },
          spanGaps: true,
          fill: (u) => {
            // Grey up to the playback cursor, teal after it.
            const { left, width } = u.bbox;
            const g = u.ctx.createLinearGradient(left, 0, left + width, 0);
            const f = Math.min(1, Math.max(0, (u.valToPos(this.pos / 1000, 'x', true) - left) / width));
            g.addColorStop(0, fillDone);
            g.addColorStop(f, fillDone);
            g.addColorStop(Math.min(1, f + 1e-6), fillTodo);
            g.addColorStop(1, fillTodo);
            return g;
          },
        },
      ],
      hooks: {
        drawClear: [
          (u) => {
            const { left, top, height } = u.bbox;
            const x = u.valToPos(this.pos / 1000, 'x', true);
            u.ctx.fillStyle = tint;
            u.ctx.fillRect(left, top, Math.max(0, x - left), height);
          },
        ],
        draw: [
          (u) => {
            const ctx = u.ctx;
            ctx.save();
            ctx.strokeStyle = css('--text-faint');
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = devicePixelRatio;
            for (const sec of this.pauseMarks) {
              const x = Math.round(u.valToPos(sec, 'x', true)) + 0.5;
              ctx.beginPath();
              ctx.moveTo(x, u.bbox.top);
              ctx.lineTo(x, u.bbox.top + u.bbox.height);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
        setCursor: [(u) => this.onCursor(u)],
        // Scales are only valid once uPlot has committed its first layout.
        ready: [() => { this.cursorPx = -1; this.setPosition(this.pos); }],
      },
    };
    this.u = new uPlot(opts, [dx, dy], this.host);
    this.u.over.append(this.cursorEl, this.handleEl);
    this.bindPointer(this.u.over);
  }

  setPosition(pos: number): void {
    this.pos = pos;
    const u = this.u;
    if (!u) return;
    const x = u.valToPos(pos / 1000, 'x');
    if (!Number.isFinite(x)) return;
    this.cursorEl.style.left = `${x}px`;
    this.handleEl.style.left = `${x}px`;
    const px = Math.round(x);
    if (px !== this.cursorPx) {
      this.cursorPx = px;
      u.redraw(false, false);
    }
  }

  private bindPointer(over: HTMLElement) {
    const toPos = (e: PointerEvent) => {
      const u = this.u!;
      const r = over.getBoundingClientRect();
      const x = Math.min(Math.max(0, e.clientX - r.left), r.width);
      return u.posToVal(x, 'x') * 1000;
    };
    over.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      over.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      this.events.onScrub(true);
      this.events.onSeek(toPos(e));
    });
    over.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this.events.onSeek(toPos(e));
    });
    const end = (e: PointerEvent) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      if (over.hasPointerCapture(e.pointerId)) over.releasePointerCapture(e.pointerId);
      this.events.onScrub(false);
    };
    over.addEventListener('pointerup', end);
    over.addEventListener('pointercancel', end);
  }

  private onCursor(u: uPlot) {
    const left = u.cursor.left ?? -1;
    if (left < 0 || !this.track) {
      this.tip.hidden = true;
      this.events.onHover(null);
      return;
    }
    const pos = u.posToVal(left, 'x') * 1000;
    const t = this.track;
    const i = indexAt(t, pos);
    const v = u.data[1][u.cursor.idx ?? 0];
    const unit = this.unitLabel.textContent;
    const value = v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(this.mode === 'speed' ? 1 : 0);
    const dist = `${distValue(t.dist[i], this.units).toFixed(2)} ${distUnit(this.units)}`;
    this.tip.textContent = `${hms(pos)} · ${value} ${unit} · ${dist}`;
    this.tip.hidden = false;
    const hostLeft = u.over.offsetLeft + this.host.offsetLeft;
    const tipW = this.tip.offsetWidth;
    const x = Math.min(Math.max(hostLeft + left, tipW / 2 + 4), this.host.parentElement!.clientWidth - tipW / 2 - 4);
    this.tip.style.left = `${x}px`;
    this.events.onHover(pos);
  }

  private resize() {
    if (!this.u) return;
    this.u.setSize({ width: this.host.clientWidth, height: this.host.clientHeight });
    this.cursorPx = -1;
    this.setPosition(this.pos);
  }
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

