import './styles/tokens.css';
import './styles/app.css';
import { TrackMap } from './map/trackmap';
import { buildTrack } from './model/build';
import { sampleAt } from './model/interpolate';
import type { RawTrack, Track } from './model/types';
import { distUnit, distValue, fmt, hms, speedUnit, speedValue } from './model/units';
import { parseTrackFile } from './parse';
import { autoRate, Player, RATES } from './player';
import { loadSettings, saveSettings, type BuildSettings, type Settings } from './settings';
import { SpeedChart } from './ui/chart';
import { InfoCard } from './ui/infocard';
import { SettingsPanel } from './ui/settingspanel';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BUILD_KEYS: (keyof BuildSettings)[] = ['skipPauses', 'pauseThresholdSec', 'removeSpikes', 'spikeDistanceM', 'estimatedSpeed'];
const CHIP_RATES = [60, 120, 240];
const CARD_INSET = 24 + 272; // info card margin + width, kept clear when fitting the track

let settings: Settings = loadSettings();
let raw: RawTrack | null = null;
let track: Track | null = null;
let followActive = settings.follow;
let resumeAfterScrub = false;

const player = new Player();
const info = new InfoCard();

// ---------- Toast ----------
let toastTimer = 0;
function toast(message: string, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), error ? 6000 : 3500);
}

// ---------- Map ----------
let viewTimer = 0;
const map = new TrackMap($('map'), settings.mapStyle, settings.view, {
  onUserPan() {
    followActive = false;
    renderFollow();
  },
  onViewChange(view) {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => updateSettings({ view }), 500);
  },
  onOffline(offline) {
    $('offline-notice').hidden = !offline;
  },
});

function renderFollow() {
  $('fit-btn').classList.toggle('active', !!track && followActive && settings.follow);
}

const cardInset = () => (!$('info-card').hidden && window.innerWidth > 640 ? CARD_INSET : 0);

// ---------- Chart ----------
const chart = new SpeedChart($('chart'), $('chart-tip'), $('chart-unit'), {
  onSeek: (pos) => player.seek(pos),
  onScrub(active) {
    if (active) {
      resumeAfterScrub = player.playing;
      player.pause();
    } else if (resumeAfterScrub) player.play();
  },
  onHover: (pos) => map.setHover(pos === null || !track ? null : sampleAt(track, pos)),
});

// ---------- Settings ----------
function updateSettings(patch: Partial<Settings>) {
  const prev = settings;
  settings = { ...settings, ...patch };
  saveSettings(settings);
  if (patch.view) return;

  if (patch.mapStyle && patch.mapStyle !== prev.mapStyle) map.setStyle(settings.mapStyle);
  if ('follow' in patch) {
    followActive = settings.follow;
    renderFollow();
  }
  if (BUILD_KEYS.some((k) => k in patch && patch[k] !== prev[k])) rebuild();
  else if (patch.units && patch.units !== prev.units && track) {
    chart.setTrack(track, settings.units);
    renderTrackText();
    onPosition(true);
  }
  renderStyleMenu();
}
const panel = new SettingsPanel(() => settings, updateSettings);

// ---------- Loading ----------
const LARGE_FILE = 2 * 1024 * 1024;

async function loadFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > LARGE_FILE) {
    // Parsing blocks the page for a moment; let the notice paint first.
    toast(`Opening ${file.name}…`);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }
  loadBytes(file.name, bytes);
  if (bytes.length > LARGE_FILE && track?.fileName === file.name) $('toast').hidden = true;
}

function loadBytes(fileName: string, bytes: Uint8Array) {
  try {
    const r = parseTrackFile(fileName, bytes);
    const t = buildTrack(r, fileName, settings);
    raw = r;
    show(t, 0);
    player.setRate(autoRate(t.stats.duration));
    followActive = settings.follow;
    map.fit(cardInset());
    renderFollow();
  } catch (err) {
    console.error(err);
    toast(`Could not open ${fileName}: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/** Rebuild the current file after a processing setting changed, keeping the position by distance. */
function rebuild() {
  if (!raw || !track) return;
  const dist = sampleAt(track, player.pos).dist;
  const wasPlaying = player.playing;
  const t = buildTrack(raw, track.fileName, settings);
  let lo = 0;
  let hi = t.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.dist[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  show(t, t.playT[lo]);
  if (wasPlaying) player.play();
}

function show(t: Track, pos: number) {
  track = t;
  info.show(true);
  $('chart-empty').hidden = true;
  $<HTMLButtonElement>('play-btn').disabled = false;
  map.setTrack(t);
  chart.setTrack(t, settings.units);
  panel.setTrackInfo(t);
  renderTrackText();
  player.setTrack(t, pos);
}

function renderTrackText() {
  if (!track) return;
  const u = settings.units;
  const st = track.stats;
  $('file-info').hidden = false;
  $('file-name').textContent = track.fileName;
  $('file-name').title = track.fileName;
  const time = track.timing === 'untimed' ? 'no time data' : hms(st.duration);
  const total = st.totalMs !== null && st.totalMs - st.duration > 60_000 ? ` (${hms(st.totalMs)} total)` : '';
  $('file-summary').textContent =
    `${fmt(distValue(st.distance, u), 1)} ${distUnit(u)} · ${time}${total} · ${track.n.toLocaleString('en-US')} points`;
  $('dur-time').textContent = hms(st.duration);

  // Speed hidden for an estimated-time file: fall back to the values stated in the file.
  const stated = track.statedStats;
  const avg = st.avgSpeed ?? (stated?.avgKmh !== undefined ? stated.avgKmh / 3.6 : null);
  const max = st.maxSpeed ?? (stated?.maxKmh !== undefined ? stated.maxKmh / 3.6 : null);
  $('st-avg').textContent = fmt(avg === null ? null : speedValue(avg, u), 1);
  $('st-max').textContent = fmt(max === null ? null : speedValue(max, u), 1);
  $('st-dist').textContent = fmt(distValue(st.distance, u), 1);
  $('st-avg-u').textContent = speedUnit(u);
  $('st-max-u').textContent = speedUnit(u);
  $('st-dist-u').textContent = distUnit(u);
}

// ---------- Playback ----------
function onPosition(force = false) {
  if (!track) return;
  const s = sampleAt(track, player.pos);
  map.setProgress(s, player.playing, followActive && settings.follow);
  chart.setPosition(player.pos);
  info.update(track, s, player.pos, settings.units, force || !player.playing);
  $('pos-time').textContent = hms(player.pos);
}
player.onPosition(() => onPosition());

player.onState(() => {
  const btn = $('play-btn');
  btn.classList.toggle('playing', player.playing);
  btn.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  for (const b of document.querySelectorAll<HTMLButtonElement>('#rates [data-rate]')) {
    b.classList.toggle('active', Number(b.dataset.rate) === player.rate && CHIP_RATES.includes(player.rate));
  }
  const more = $('rate-more');
  const inMenu = !CHIP_RATES.includes(player.rate);
  more.classList.toggle('active', inMenu);
  more.textContent = inMenu ? `×${player.rate} ▾` : '▾';
  onPosition(true);
});

$('play-btn').addEventListener('click', () => player.toggle());

$('rates').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b) return;
  if (b.id === 'rate-more') {
    $('rate-menu').hidden = !$('rate-menu').hidden;
    return;
  }
  if (b.dataset.rate) {
    player.setRate(Number(b.dataset.rate));
    $('rate-menu').hidden = true;
  }
});

// ---------- Map controls ----------
$('zoom-in').addEventListener('click', () => map.zoomBy(1));
$('zoom-out').addEventListener('click', () => map.zoomBy(-1));
$('fit-btn').addEventListener('click', () => {
  map.fit(cardInset());
  followActive = settings.follow;
  renderFollow();
});
$('style-btn').addEventListener('click', () => ($('style-menu').hidden = !$('style-menu').hidden));
$('style-menu').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-style]');
  if (!b) return;
  $('style-menu').hidden = true;
  updateSettings({ mapStyle: b.dataset.style as Settings['mapStyle'] });
  panel.render();
});
function renderStyleMenu() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#style-menu button')) {
    b.classList.toggle('active', b.dataset.style === settings.mapStyle);
  }
}
renderStyleMenu();

// Close pop-up menus on outside clicks.
document.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest('#rates')) $('rate-menu').hidden = true;
  if (!target.closest('.map-ctrls')) $('style-menu').hidden = true;
});

// ---------- Opening files ----------
const input = $<HTMLInputElement>('file-input');
$('open-btn').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const f = input.files?.[0];
  if (f) loadFile(f);
  input.value = '';
});
$('sample-btn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/sample.kmz`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadBytes('Sep_13,_2026_11_26_19.kmz', new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    toast(`Could not load the sample: ${err instanceof Error ? err.message : String(err)}`, true);
  }
});

let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const f = e.dataTransfer!.files[0];
  if (f) loadFile(f);
});

// ---------- Keyboard ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !track) return;
  const step = (e.shiftKey ? 60 : 10) * 1000;
  switch (e.key) {
    case ' ':
      player.toggle();
      break;
    case 'ArrowRight':
      player.seek(player.pos + step);
      break;
    case 'ArrowLeft':
      player.seek(player.pos - step);
      break;
    case 'Home':
      player.seek(0);
      break;
    case 'End':
      player.seek(player.duration);
      break;
    case '+':
    case '=':
      player.setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(player.rate) + 1)]);
      break;
    case '-':
      player.setRate(RATES[Math.max(0, RATES.indexOf(player.rate) - 1)]);
      break;
    default:
      return;
  }
  e.preventDefault();
});

new ResizeObserver(() => map.resize()).observe($('map'));

// Dev-only handle for debugging from the browser console.
if (import.meta.env.DEV) Object.assign(window, { trackview: { player, map, chart, info } });
