import './styles/tokens.css';
import './styles/app.css';
import { ExportPanel } from './export/exportpanel';
import { CAMERA_CYCLE, CAMERA_LABEL } from './map/camera';
import { smartZoomAvailable } from './map/smartzoom';
import { TrackMap } from './map/trackmap';
import { autoCurve, forgetCurve, loadCurve, saveCurve, type ZoomCurve, type ZoomKnot } from './map/zoomcurve';
import { buildTrack } from './model/build';
import { sampleAt } from './model/interpolate';
import type { RawTrack, Track } from './model/types';
import { distUnit, distValue, fmt, hms, speedUnit, speedValue } from './model/units';
import { parseTrackFile } from './parse';
import { autoRate, Player, RATES } from './player';
import { loadSettings, saveSettings, type BuildSettings, type CameraMode, type Settings } from './settings';
import { SpeedChart } from './ui/chart';
import { InfoCard } from './ui/infocard';
import { MarkerPanel } from './ui/markerpanel';
import { SettingsPanel } from './ui/settingspanel';
import { SmartZoomFields } from './ui/smartzoomfields';
import { ZoomStrip } from './ui/zoomstrip';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BUILD_KEYS: (keyof BuildSettings)[] = ['skipPauses', 'pauseThresholdSec', 'removeSpikes', 'spikeDistanceM', 'estimatedSpeed'];
const CHIP_RATES = [60, 120, 240];
const CARD_INSET = 24 + 272; // info card margin + width, kept clear when fitting the track

let settings: Settings = loadSettings();
let raw: RawTrack | null = null;
let track: Track | null = null;
/** Camera mode in effect; a manual pan turns it off until the next fit or file load (§6.3). */
let camMode: CameraMode = settings.camera;
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
const map = new TrackMap($('map'), settings.mapStyle, settings.view, settings.marker, {
  onUserPan() {
    setCamera('off');
  },
  onViewChange(view) {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => updateSettings({ view }), 500);
  },
  onOffline(offline) {
    $('offline-notice').hidden = !offline;
  },
});

const CAMERA_BADGE: Record<CameraMode, string> = { off: '', north: 'N', heading: '↑', keep: '' };

function setCamera(mode: CameraMode) {
  camMode = mode;
  map.setCamera(mode);
  renderCamera();
  renderZoom();
}

function renderCamera() {
  const btn = $('fit-btn');
  const on = !!track && camMode !== 'off';
  btn.classList.toggle('active', on);
  btn.dataset.badge = on ? CAMERA_BADGE[camMode] : '';
  btn.title = `Fit track / camera: ${CAMERA_LABEL[camMode]}`;
}

const cardInset = () => (!$('info-card').hidden && window.innerWidth > 640 ? CARD_INSET : 0);

// ---------- Chart ----------
const scrub = {
  onSeek: (pos: number) => player.seek(pos),
  onScrub(active: boolean) {
    if (active) {
      resumeAfterScrub = player.playing;
      player.pause();
    } else if (resumeAfterScrub) player.play();
  },
};
const chart = new SpeedChart($('chart'), $('chart-tip'), $('chart-unit'), {
  ...scrub,
  onHover: (pos) => map.setHover(pos === null || !track ? null : sampleAt(track, pos)),
});

// ---------- Settings ----------
function updateSettings(patch: Partial<Settings>) {
  const prev = settings;
  settings = { ...settings, ...patch };
  if (!saveSettings(settings) && patch.marker?.imageDataUrl) toast('The marker image could not be saved for next time (storage full).', true);
  if (patch.view || patch.export) return;

  if (patch.mapStyle && patch.mapStyle !== prev.mapStyle) map.setStyle(settings.mapStyle);
  if (patch.camera && patch.camera !== prev.camera) setCamera(settings.camera);
  if (patch.marker) {
    map.setMarker(settings.marker);
    onPosition(true);
  }
  if (patch.smart) {
    map.setSmartZoom(settings.smart);
    smartChanged(prev.smart);
    // Smart zoom keeps the vehicle centred: it needs a follow mode (§15.1).
    if (settings.smart.enabled && !prev.smart.enabled && (settings.camera === 'off' || settings.camera === 'keep')) {
      updateSettings({ camera: 'north' });
      panel.render();
    }
    renderSmart();
  }
  if (BUILD_KEYS.some((k) => k in patch && patch[k] !== prev[k])) rebuild();
  else if (patch.units && patch.units !== prev.units && track) {
    chart.setTrack(track, settings.units);
    renderTrackText();
    onPosition(true);
  }
  if (patch.units) renderSmart();
  renderStyleMenu();
  exportPanel.refresh();
}
const panel = new SettingsPanel(() => settings, updateSettings);
new MarkerPanel(() => settings.marker, (marker) => updateSettings({ marker }), toast);

// ---------- Smart zoom (§15) ----------
const smartHost = {
  smart: () => settings.smart,
  units: () => settings.units,
  track: () => track,
  update: (smart: Settings['smart']) => updateSettings({ smart }),
};
const smartFields = new SmartZoomFields($('sz-settings-fields'), smartHost);

function setSmartEnabled(enabled: boolean) {
  if (enabled && !smartZoomAvailable(track)) {
    toast(track ? 'Smart zoom needs speed data; this track has none.' : 'Open a track to use smart zoom.');
    renderSmart();
    return;
  }
  updateSettings({ smart: { ...settings.smart, enabled } });
}

function renderSmart() {
  const available = !track || smartZoomAvailable(track);
  const box = $<HTMLInputElement>('sz-enabled');
  box.checked = settings.smart.enabled;
  box.disabled = !available;
  $('sz-toggle').classList.toggle('disabled', !available);
  $('sz-toggle').title = available ? '' : 'Needs speed data';
  smartFields.render();
  renderZoom();
}
$('sz-enabled').addEventListener('change', (e) => setSmartEnabled((e.target as HTMLInputElement).checked));
const exportPanel = new ExportPanel({
  smartHost,
  track: () => track,
  settings: () => settings,
  update: updateSettings,
  playerPos: () => player.pos,
  pausePlayer: () => player.pause(),
  mapZoom: () => map.map.getZoom(),
  zoomCurve: () => curve?.knots ?? null,
  openMarkerSettings() {
    panel.toggle(true);
    document.getElementById('marker-panel')!.scrollIntoView({ block: 'start' });
  },
  toast,
});

// ---------- Zoom curve (§16) ----------
/** The track's smart zoom as editable control points; the follow camera and the video read the zoom from it. */
let curve: ZoomCurve | null = null;
let autoKnots: ZoomKnot[] | null = null;
/** Last playback rate seen, to recompute the curve on a rate change when it follows the playback rate. */
let curveRate = player.rate;

const zoomStrip = new ZoomStrip($('zs-plot'), $('zs-readout'), {
  ...scrub,
  onEdit(knots) {
    if (!track || !curve) return;
    curve = { knots, rate: curve.rate, edited: true };
    saveCurve(track, curve);
    applyCurve(false);
  },
});

/** Compute the auto curve at `rate`; a saved edited curve for this file wins over it. */
function refreshCurve(rate: number) {
  const auto = track && smartZoomAvailable(track) ? autoCurve(track, rate, map.map.getContainer().clientWidth, settings.smart) : null;
  autoKnots = auto?.knots ?? null;
  curve = (track && auto && loadCurve(track)) || auto;
  applyCurve(true);
}

/** Recompute from scratch (edits are replaced), e.g. when the rate the curve is computed for changes. */
function reloadCurve(rate: number, why: string) {
  if (!track) return;
  const hadEdits = !!curve?.edited;
  forgetCurve(track);
  refreshCurve(rate);
  if (hadEdits) toast(`Zoom curve recomputed for ${why}; your edits were replaced.`);
}

function applyCurve(redrawStrip: boolean) {
  map.setZoomCurve(curve?.knots ?? null);
  if (redrawStrip) zoomStrip.set(curve, autoKnots, track?.stats.duration ?? 0);
  renderZoomStrip();
  exportPanel.refresh();
}

function renderZoomStrip() {
  $('zoom-strip').hidden = !(track && curve && settings.smart.enabled);
  $<HTMLSelectElement>('zs-rate').value = settings.smart.curveRate;
  $('zs-state').textContent = curve ? `${curve.edited ? 'edited' : 'auto'} · ×${curve.rate}` : '';
  $<HTMLButtonElement>('zs-reset').disabled = !curve?.edited;
}

/** Smart zoom settings changed: keep the curve in step (§16). */
function smartChanged(prev: Settings['smart']) {
  const sz = settings.smart;
  if (!track) return renderZoomStrip();
  if (sz.curveRate !== prev.curveRate) {
    reloadCurve(sz.curveRate === 'playback' ? player.rate : autoRate(track.stats.duration), 'the new rate option');
    return;
  }
  const valuesChanged = sz.near !== prev.near || sz.far !== prev.far || sz.slowKmh !== prev.slowKmh || sz.fastKmh !== prev.fastKmh;
  if (valuesChanged) {
    const edited = !!curve?.edited;
    refreshCurve(curve?.rate ?? player.rate);
    if (edited) toast('Your edited zoom curve is kept; use "Reset to auto" to apply the new values.');
  } else renderZoomStrip();
}

$('zs-rate').addEventListener('change', (e) => {
  updateSettings({ smart: { ...settings.smart, curveRate: (e.target as HTMLSelectElement).value as Settings['smart']['curveRate'] } });
});
$('zs-reset').addEventListener('click', () => {
  if (!track || !curve) return;
  forgetCurve(track);
  refreshCurve(curve.rate);
});

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
    // Set before the rate change, so loading never counts as "the rate changed" (which would replace edits).
    curveRate = autoRate(t.stats.duration);
    player.setRate(curveRate);
    refreshCurve(curveRate);
    map.fit(cardInset());
    setCamera(settings.camera);
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
  refreshCurve(curve?.rate ?? player.rate);
  if (wasPlaying) player.play();
}

function show(t: Track, pos: number) {
  track = t;
  info.show(true);
  $('chart-empty').hidden = true;
  $<HTMLButtonElement>('play-btn').disabled = false;
  $<HTMLButtonElement>('export-btn').disabled = false;
  map.setTrack(t);
  chart.setTrack(t, settings.units);
  renderSmart();
  panel.setTrackInfo(t);
  renderTrackText();
  player.setTrack(t, pos);
  exportPanel.refresh();
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
  map.setProgress(s, player.pos, player.rate, player.playing);
  chart.setPosition(player.pos);
  zoomStrip.setPosition(player.pos);
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
  if (player.rate !== curveRate) {
    curveRate = player.rate;
    if (settings.smart.curveRate === 'playback') reloadCurve(player.rate, `the playback rate ×${player.rate}`);
  }
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
// Zoom readout (§6.3): shows the map zoom to reuse later, e.g. in Export video → Zoom.
// Clicking it (or the copy icon) copies the number. Smart zoom is switched only in the settings (§15.5).
const zoomText = () => map.map.getZoom().toFixed(1);
function renderZoom() {
  const auto = settings.smart.enabled && map.smartActive;
  const el = $('zoom-level');
  el.textContent = `z ${zoomText()}${auto ? ' auto' : ''}`;
  el.classList.toggle('auto', settings.smart.enabled);
  el.title = 'Map zoom level — click to copy';
}
map.map.on('zoom', renderZoom);
async function copyZoom() {
  const z = zoomText();
  try {
    await navigator.clipboard.writeText(z);
    toast(`Zoom ${z} copied`);
  } catch {
    toast(`Zoom ${z}`);
  }
}
$('zoom-level').addEventListener('click', copyZoom);
$('zoom-copy').addEventListener('click', copyZoom);
$('zoom-in').addEventListener('click', () => map.zoomBy(1));
$('zoom-out').addEventListener('click', () => map.zoomBy(-1));
// Stopped: fit the track and restore the chosen camera. Playing: next camera mode (§6.3).
$('fit-btn').addEventListener('click', () => {
  if (!player.playing) {
    setCamera(settings.camera);
    map.fit(cardInset());
    return;
  }
  // With smart zoom on, only the centred modes it needs: the button must not switch it off (§15.5).
  const cycle: CameraMode[] = settings.smart.enabled && smartZoomAvailable(track) ? ['north', 'heading'] : CAMERA_CYCLE;
  const next = cycle[(cycle.indexOf(camMode) + 1) % cycle.length];
  updateSettings({ camera: next });
  setCamera(next);
  panel.render();
});
$('export-btn').addEventListener('click', () => exportPanel.toggle());
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
  if (e.key === 'Escape' && exportPanel.isOpen && $('settings').hidden) exportPanel.toggle(false);
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !track || exportPanel.rendering) return;
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
    case 'e':
    case 'E':
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      exportPanel.toggle();
      break;
    default:
      return;
  }
  e.preventDefault();
});

new ResizeObserver(() => map.resize()).observe($('map'));

map.setSmartZoom(settings.smart);
renderCamera();
renderSmart();

// Dev-only handle for debugging from the browser console.
if (import.meta.env.DEV) Object.assign(window, { trackview: { player, map, chart, info, exportPanel } });
