import { autoSpeeds, speedRange, ZOOM_LIMITS } from '../map/smartzoom';
import type { Track } from '../model/types';
import { fmt, speedUnit } from '../model/units';
import type { SmartZoomSettings, Units } from '../settings';

const KM_PER_MI = 1.609344;
const SPEED_LIMITS = { slow: [1, 300], fast: [2, 400] } as const; // km/h

type Key = 'near' | 'far' | 'slowKmh' | 'fastKmh';

export interface SmartZoomHost {
  smart(): SmartZoomSettings;
  units(): Units;
  track(): Track | null;
  update(sz: SmartZoomSettings): void;
}

/**
 * The four Smart zoom values as number inputs (§15.2): Near / Far zoom and Slow / Fast speed (Auto from the
 * track average until typed). Used in the settings drawer and in the export dialog; both edit the same values.
 */
export class SmartZoomFields {
  private inputs = {} as Record<Key, HTMLInputElement>;
  private hints = {} as Record<'slowKmh' | 'fastKmh', HTMLElement>;
  private units: HTMLElement[] = [];

  constructor(root: HTMLElement, private host: SmartZoomHost) {
    root.classList.add('sz-fields');
    const field = (key: Key, label: string, step: string) => {
      const wrap = document.createElement('label');
      wrap.className = 'row';
      const title = document.createElement('span');
      title.textContent = label;
      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'decimal';
      input.step = step;
      input.dataset.k = key;
      wrap.append(title, input);
      if (key === 'slowKmh' || key === 'fastKmh') {
        const unit = document.createElement('i');
        title.append(' (', unit, ')');
        this.units.push(unit);
        const hint = document.createElement('small');
        hint.className = 'sz-hint';
        wrap.append(hint);
        this.hints[key] = hint;
      }
      this.inputs[key] = input;
      return wrap;
    };
    const grid = document.createElement('div');
    grid.className = 'sz-grid';
    grid.append(field('near', 'Near zoom (slow)', '0.1'), field('far', 'Far zoom (fast)', '0.1'), field('slowKmh', 'Slow speed', '1'), field('fastKmh', 'Fast speed', '1'));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'link';
    reset.textContent = 'Use track average';
    reset.addEventListener('click', () => {
      this.host.update({ ...this.host.smart(), slowKmh: null, fastKmh: null });
      this.render();
    });
    root.append(grid, reset);
    for (const input of Object.values(this.inputs)) input.addEventListener('change', () => this.apply(input));
    this.render();
  }

  private toKmh(v: number): number {
    return this.host.units() === 'metric' ? v : v * KM_PER_MI;
  }

  private fromKmh(kmh: number): number {
    return this.host.units() === 'metric' ? kmh : kmh / KM_PER_MI;
  }

  /** Validate one edited field against the others; invalid input gets a red outline and is not applied. */
  private apply(input: HTMLInputElement) {
    const key = input.dataset.k as Key;
    const sz = this.host.smart();
    const v = Number(input.value);
    const next = { ...sz };
    let ok = input.value.trim() !== '' && Number.isFinite(v);
    if (ok && (key === 'near' || key === 'far')) {
      const z = Math.round(v * 10) / 10;
      next[key] = z;
      ok = z >= ZOOM_LIMITS.min && z <= ZOOM_LIMITS.max && next.far < next.near;
    } else if (ok) {
      const kmh = Math.round(this.toKmh(v));
      next[key as 'slowKmh' | 'fastKmh'] = kmh;
      const [lo, hi] = key === 'slowKmh' ? SPEED_LIMITS.slow : SPEED_LIMITS.fast;
      const range = speedRange(next, this.host.track()?.stats.avgSpeed ?? null);
      ok = kmh >= lo && kmh <= hi && (!range || range.slow < range.fast);
    }
    input.classList.toggle('invalid', !ok);
    if (ok) {
      this.host.update(next);
      this.render();
    }
  }

  render(): void {
    const sz = this.host.smart();
    const units = this.host.units();
    const avg = this.host.track()?.stats.avgSpeed ?? null;
    const auto = autoSpeeds(avg);
    for (const u of this.units) u.textContent = speedUnit(units);
    for (const key of ['near', 'far'] as const) {
      const el = this.inputs[key];
      if (document.activeElement !== el) el.value = sz[key].toFixed(1);
      el.classList.remove('invalid');
      el.min = String(ZOOM_LIMITS.min);
      el.max = String(ZOOM_LIMITS.max);
    }
    const avgText = avg === null ? '' : `avg ${fmt(this.fromKmh(avg * 3.6), 1)} ${speedUnit(units)}`;
    for (const key of ['slowKmh', 'fastKmh'] as const) {
      const el = this.inputs[key];
      const custom = sz[key];
      const value = custom ?? (auto ? (key === 'slowKmh' ? auto.slow : auto.fast) : null);
      if (document.activeElement !== el) el.value = value === null ? '' : String(Math.round(this.fromKmh(value)));
      el.placeholder = value === null ? 'needs speed data' : '';
      el.classList.remove('invalid');
      this.hints[key].textContent = custom !== null ? 'custom' : auto ? `auto from ${avgText}` : 'auto (no speed data)';
    }
  }
}
