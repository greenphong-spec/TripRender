import type { Track } from '../model/types';
import type { Settings } from '../settings';

type Key = keyof Settings;
const $ = (id: string) => document.getElementById(id)!;

const TIMING_TEXT = { timed: 'Recorded per point', estimated: 'Estimated from start/end', untimed: 'None (distance playback)' };

export class SettingsPanel {
  private root = $('settings');
  private form = $('settings-form') as HTMLFormElement;

  constructor(private get: () => Settings, onChange: (patch: Partial<Settings>) => void) {
    $('settings-btn').addEventListener('click', () => this.toggle());
    $('settings-close').addEventListener('click', () => this.toggle(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.toggle(false);
    });
    this.form.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement | HTMLSelectElement;
      const key = input.name as Key;
      let value: unknown;
      if (input instanceof HTMLInputElement && input.type === 'checkbox') value = input.checked;
      else if (input instanceof HTMLInputElement && input.type === 'number') {
        const n = Number(input.value);
        const min = Number(input.min);
        const max = Number(input.max);
        if (!Number.isFinite(n)) return this.render();
        value = Math.min(max, Math.max(min, n));
      } else value = input.value;
      onChange({ [key]: value } as Partial<Settings>);
      this.render();
    });
    this.render();
  }

  toggle(open = this.root.hidden) {
    this.root.hidden = !open;
    if (open) this.render();
  }

  render() {
    const s = this.get();
    for (const el of Array.from(this.form.elements) as (HTMLInputElement | HTMLSelectElement)[]) {
      const v = s[el.name as Key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
    }
    (this.form.elements.namedItem('spikeDistanceM') as HTMLInputElement).disabled = !s.removeSpikes;
    (this.form.elements.namedItem('pauseThresholdSec') as HTMLInputElement).disabled = !s.skipPauses;
  }

  setTrackInfo(track: Track | null) {
    const dl = $('file-details');
    if (!track) {
      dl.replaceChildren();
      return;
    }
    const rows: [string, string][] = [
      ['File', track.fileName],
      ['Format', track.format.toUpperCase()],
      ['Producer', track.creator || '—'],
      ['Timing', TIMING_TEXT[track.timing]],
      ['Speed', track.speedSource === 'none' ? 'Not available' : track.speedSource === 'recorded' ? 'Recorded' : 'Derived from positions'],
      ['Points', track.n.toLocaleString('en-US')],
      ['Segments', String(track.segmentCount)],
      ['Waypoints', String(track.waypoints.length)],
      ['GPS spikes', `${track.spikesRemoved} point${track.spikesRemoved === 1 ? '' : 's'} removed`],
    ];
    dl.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  }
}
