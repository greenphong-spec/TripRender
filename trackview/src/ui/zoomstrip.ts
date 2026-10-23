import { clampZoom, curveAt, type ZoomCurve, type ZoomKnot } from '../map/zoomcurve';
import { hms } from '../model/units';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const AXIS_PX = 36; // left label column, same as the speed chart's y axis
const PAD_Y = 8;
const HIT_PX = 10; // touch-friendly grab radius
const DOUBLE_TAP_MS = 350;
const MIN_GAP_MS = 500; // knots never pass each other

export interface ZoomStripEvents {
  /** The user changed the curve (on release). */
  onEdit(knots: ZoomKnot[]): void;
  onSeek(pos: number): void;
  onScrub(active: boolean): void;
}

type Drag = { kind: 'knot'; i: number; moved: boolean } | { kind: 'seek' } | null;

/**
 * Editable zoom curve under the speed chart (§16): x = playback timeline (aligned with the chart),
 * y = map zoom. Drag a point, click the line to add one, double-click / double-tap a point to delete it.
 * Clicking elsewhere seeks, like the chart.
 */
export class ZoomStrip {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private curve: ZoomCurve | null = null;
  private auto: ZoomKnot[] | null = null;
  private duration = 0;
  private pos = 0;
  private cursorPx = -1;
  private range: [number, number] = [12, 18];
  private drag: Drag = null;
  private lastTap = { i: -1, t: 0 };
  private hoverI = -1;
  private w = 0;
  private h = 0;

  constructor(private host: HTMLElement, private readout: HTMLElement, private events: ZoomStripEvents) {
    host.append(this.canvas);
    new ResizeObserver(() => this.resize()).observe(host);
    this.bindPointer();
  }

  /** Show a curve; `auto` is drawn faintly behind an edited curve. */
  set(curve: ZoomCurve | null, auto: ZoomKnot[] | null, duration: number): void {
    this.curve = curve ? { ...curve, knots: curve.knots.map((k) => ({ ...k })) } : null;
    this.auto = auto;
    this.duration = duration;
    this.fitRange();
    this.draw();
  }

  setPosition(pos: number): void {
    this.pos = pos;
    const px = Math.round(this.x(pos));
    if (px !== this.cursorPx) {
      this.cursorPx = px;
      this.draw();
    }
  }

  private fitRange() {
    const zs = [...(this.curve?.knots ?? []), ...(this.auto ?? [])].map((k) => k.z);
    if (!zs.length) return;
    const lo = Math.floor(Math.min(...zs) - 0.5);
    const hi = Math.ceil(Math.max(...zs) + 0.5);
    this.range = [lo, Math.max(hi, lo + 2)];
  }

  private get plotW() { return Math.max(1, this.w - AXIS_PX); }
  private get plotH() { return Math.max(1, this.h - 2 * PAD_Y); }
  private x(pos: number) { return AXIS_PX + (this.duration > 0 ? (pos / this.duration) * this.plotW : 0); }
  private y(z: number) { return PAD_Y + ((this.range[1] - z) / (this.range[1] - this.range[0])) * this.plotH; }
  private posAt(x: number) { return Math.min(this.duration, Math.max(0, ((x - AXIS_PX) / this.plotW) * this.duration)); }
  private zAt(y: number) { return this.range[1] - ((y - PAD_Y) / this.plotH) * (this.range[1] - this.range[0]); }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cursorPx = -1;
    this.draw();
  }

  private draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!this.curve || !w) return;
    const [lo, hi] = this.range;

    // Travelled tint, gridlines and labels.
    const cx = this.x(this.pos);
    ctx.fillStyle = css('--accent-tint');
    ctx.fillRect(AXIS_PX, PAD_Y, Math.max(0, cx - AXIS_PX), this.plotH);
    const perLevel = this.plotH / (hi - lo);
    const step = [1, 2, 5, 10].find((s) => s * perLevel >= 16) ?? 10; // keep the labels apart
    ctx.font = `10.5px ${css('--mono')}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let z = Math.ceil(lo / step) * step; z <= hi; z += step) {
      const y = Math.round(this.y(z)) + 0.5;
      ctx.strokeStyle = css('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(AXIS_PX, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = css('--text-faint');
      ctx.fillText(String(z), AXIS_PX - 8, y);
    }

    const line = (knots: ZoomKnot[]) => {
      ctx.beginPath();
      for (let px = AXIS_PX; px <= w; px += 2) {
        const y = this.y(curveAt(knots, this.posAt(px)));
        if (px === AXIS_PX) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.stroke();
    };
    if (this.curve.edited && this.auto) {
      ctx.strokeStyle = css('--text-faint');
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      line(this.auto);
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = css('--chart-line');
    ctx.lineWidth = 2;
    line(this.curve.knots);

    this.curve.knots.forEach((k, i) => {
      const active = i === this.hoverI || (this.drag?.kind === 'knot' && this.drag.i === i);
      ctx.beginPath();
      ctx.arc(this.x(k.pos), this.y(k.z), active ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? css('--chart-line') : '#ffffff';
      ctx.strokeStyle = css('--chart-line');
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
    });

    // Playback cursor.
    ctx.fillStyle = css('--accent');
    ctx.fillRect(Math.round(cx) - 1, 0, 2, h);
  }

  private knotNear(px: number, py: number): number {
    if (!this.curve) return -1;
    let best = -1, bestD = HIT_PX;
    this.curve.knots.forEach((k, i) => {
      const d = Math.hypot(this.x(k.pos) - px, this.y(k.z) - py);
      if (d <= bestD) { best = i; bestD = d; }
    });
    return best;
  }

  private showValue(pos: number, z: number) {
    this.readout.textContent = `z ${z.toFixed(1)} at ${hms(pos)}`;
  }

  private bindPointer() {
    const c = this.canvas;
    const local = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.curve) return;
      const [px, py] = local(e);
      c.setPointerCapture(e.pointerId);
      const knots = this.curve.knots;
      let i = this.knotNear(px, py);

      // Double-click / double-tap on a point deletes it (not the end points).
      const now = performance.now();
      if (i >= 0 && i === this.lastTap.i && now - this.lastTap.t < DOUBLE_TAP_MS) {
        this.lastTap = { i: -1, t: 0 };
        if (i > 0 && i < knots.length - 1) {
          knots.splice(i, 1);
          this.hoverI = -1;
          this.commit();
        }
        this.drag = null;
        return;
      }
      this.lastTap = { i, t: now };

      if (i < 0 && px >= AXIS_PX) {
        // Close to the line: add a point there and drag it.
        const pos = this.posAt(px);
        const z = curveAt(knots, pos);
        if (Math.abs(this.y(z) - py) <= HIT_PX) {
          i = knots.findIndex((k) => k.pos > pos);
          if (i > 0 && pos - knots[i - 1].pos >= MIN_GAP_MS && knots[i].pos - pos >= MIN_GAP_MS) {
            knots.splice(i, 0, { pos, z: Math.round(z * 100) / 100 });
            this.lastTap = { i, t: now };
            this.drag = { kind: 'knot', i, moved: true };
            this.draw();
            return;
          }
          i = -1;
        }
      }
      if (i >= 0) {
        this.drag = { kind: 'knot', i, moved: false };
        this.showValue(knots[i].pos, knots[i].z);
        this.draw();
        return;
      }
      this.drag = { kind: 'seek' };
      this.events.onScrub(true);
      this.events.onSeek(this.posAt(px));
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.curve) return;
      const [px, py] = local(e);
      const d = this.drag;
      if (d?.kind === 'seek') {
        this.events.onSeek(this.posAt(px));
        return;
      }
      if (d?.kind === 'knot') {
        const knots = this.curve.knots;
        const k = knots[d.i];
        k.z = Math.round(clampZoom(this.zAt(py)) * 20) / 20;
        if (d.i > 0 && d.i < knots.length - 1) {
          k.pos = Math.min(knots[d.i + 1].pos - MIN_GAP_MS, Math.max(knots[d.i - 1].pos + MIN_GAP_MS, this.posAt(px)));
        }
        d.moved = true;
        this.showValue(k.pos, k.z);
        this.draw();
        return;
      }
      const i = this.knotNear(px, py);
      const pos = this.posAt(px);
      const onLine = px >= AXIS_PX && Math.abs(this.y(curveAt(this.curve.knots, pos)) - py) <= HIT_PX;
      c.style.cursor = i >= 0 ? 'grab' : onLine ? 'copy' : 'pointer';
      if (i !== this.hoverI) {
        this.hoverI = i;
        this.draw();
      }
      if (i >= 0) this.showValue(this.curve.knots[i].pos, this.curve.knots[i].z);
      else this.showValue(pos, curveAt(this.curve.knots, pos));
    });

    c.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.readout.textContent = '';
      if (this.hoverI >= 0) {
        this.hoverI = -1;
        this.draw();
      }
    });

    const end = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      if (d?.kind === 'seek') this.events.onScrub(false);
      if (d?.kind === 'knot' && d.moved) this.commit();
      else this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  private commit() {
    if (!this.curve) return;
    this.curve.edited = true;
    this.fitRange();
    this.draw();
    this.events.onEdit(this.curve.knots.map((k) => ({ ...k })));
  }
}
