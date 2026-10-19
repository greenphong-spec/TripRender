import type { Sample } from '../model/interpolate';
import type { Track } from '../model/types';
import {
  clockText, distUnit, distValue, eleUnit, eleValue, fmt, hms, humanDuration, latLonText, speedUnit, speedValue,
} from '../model/units';
import type { Units } from '../settings';

const UPDATE_MS = 100;
const $ = (id: string) => document.getElementById(id)!;

export class InfoCard {
  private root = $('info-card');
  private last = 0;
  private lastBadges = '';

  constructor() {
    $('ic-collapse').addEventListener('click', () => this.root.classList.toggle('collapsed'));
  }

  show(visible: boolean) {
    this.root.hidden = !visible;
  }

  /** Update the values; at most every 100 ms unless forced (seek, pause, end). */
  update(track: Track, s: Sample, pos: number, units: Units, force: boolean) {
    const now = performance.now();
    if (!force && now - this.last < UPDATE_MS) return;
    this.last = now;

    $('ic-time').textContent = hms(pos);
    $('ic-clock').textContent = clockText(s.clock);
    $('ic-speed').textContent = fmt(track.hasSpeed ? speedValue(s.speed, units) : NaN, 1);
    $('ic-dist').textContent = fmt(distValue(s.dist, units), 1);
    $('ic-ele').textContent = fmt(track.hasEle ? eleValue(s.ele, units) : NaN, 0);
    const [lat, lon] = latLonText(s.lat, s.lon);
    $('ic-lat').textContent = lat;
    $('ic-lon').textContent = lon;
    $('ic-speed-u').textContent = speedUnit(units);
    $('ic-dist-u').textContent = distUnit(units);
    $('ic-ele-u').textContent = eleUnit(units);

    const badges: [string, string][] = [];
    if (track.timing === 'estimated') badges.push(['Estimated time', '']);
    if (track.timing === 'untimed') badges.push(['No time data', '']);
    if (s.pause && s.pause.realMs > 0) badges.push([`Paused ${humanDuration(s.pause.realMs)}`, 'pause']);
    const key = badges.map((b) => b.join('|')).join(',');
    if (key !== this.lastBadges) {
      this.lastBadges = key;
      const box = $('ic-badges');
      box.replaceChildren(
        ...badges.map(([text, cls]) => {
          const b = document.createElement('span');
          b.className = `badge ${cls}`;
          b.textContent = text;
          return b;
        }),
      );
    }
  }
}
