import { ICON_NAMES, iconUrl, importMarkerImage, MarkerView } from '../map/marker';
import { DEFAULT_MARKER, type MarkerKind, type MarkerSettings } from '../settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const PALETTE = ['#d2401e', '#0f5c5c', '#1e5aa8', '#2e7d4f', '#1a1a1a', '#ffffff'];
const FRONTS = ['0', '90', '180', '270'];
const PREVIEW_RADIUS = 30;
const PREVIEW_PERIOD_MS = 6000;

/** "Position marker" group in the settings drawer (§14.5). */
export class MarkerPanel {
  private view = new MarkerView();
  private raf = 0;
  /** Kind to go back to when the imported image is removed. */
  private lastKind: MarkerKind = DEFAULT_MARKER.kind;

  constructor(
    private get: () => MarkerSettings,
    private set: (ms: MarkerSettings) => void,
    private toast: (msg: string, error?: boolean) => void,
  ) {
    $('mk-preview').append(this.view.el);

    $('mk-kinds').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-kind]');
      if (!b) return;
      const kind = b.dataset.kind as MarkerKind;
      if (kind === 'image' && !this.get().imageDataUrl) $<HTMLInputElement>('mk-file').click();
      else this.setKind(kind);
    });

    const icons = $('mk-icons');
    for (const name of ICON_NAMES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.icon = name;
      b.title = name[0].toUpperCase() + name.slice(1);
      b.setAttribute('aria-label', b.title);
      b.append(document.createElement('img'));
      icons.append(b);
    }
    icons.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-icon]');
      if (b) this.patch({ kind: 'icon', icon: b.dataset.icon as MarkerSettings['icon'] });
    });

    const swatches = $('mk-colors');
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.color = c;
      b.style.background = c;
      b.title = c;
      swatches.insertBefore(b, $('mk-color'));
    }
    swatches.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-color]');
      if (b) this.patch({ color: b.dataset.color! });
    });
    $<HTMLInputElement>('mk-color').addEventListener('input', (e) => this.patch({ color: (e.target as HTMLInputElement).value }));

    $<HTMLInputElement>('mk-size').addEventListener('input', (e) => this.patch({ sizePx: Number((e.target as HTMLInputElement).value) }));
    $<HTMLInputElement>('mk-halo').addEventListener('change', (e) => this.patch({ halo: (e.target as HTMLInputElement).checked }));
    $<HTMLSelectElement>('mk-rotation').addEventListener('change', (e) =>
      this.patch({ rotation: (e.target as HTMLSelectElement).value as MarkerSettings['rotation'] }));
    $<HTMLSelectElement>('mk-front').addEventListener('change', (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === 'custom') {
        $('mk-front-deg').hidden = false;
        $<HTMLInputElement>('mk-front-deg').focus();
      } else this.patch({ imageFrontDeg: Number(v) });
    });
    $<HTMLInputElement>('mk-front-deg').addEventListener('change', (e) => {
      const n = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(n)) this.patch({ imageFrontDeg: ((Math.round(n) % 360) + 360) % 360 });
      else this.render();
    });

    $('mk-import').addEventListener('click', () => $<HTMLInputElement>('mk-file').click());
    $<HTMLInputElement>('mk-file').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      input.value = '';
      if (f) this.importFile(f);
    });
    $('mk-remove').addEventListener('click', () => {
      this.patch({ imageDataUrl: null, kind: this.lastKind, rotation: 'rotate' });
    });
    $('mk-reset').addEventListener('click', () => {
      this.set({ ...DEFAULT_MARKER });
      this.render();
    });

    // Drop an image on the preview (it must not reach the window-wide track drop).
    const preview = $('mk-preview');
    preview.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      preview.classList.add('drag');
    });
    preview.addEventListener('dragleave', () => preview.classList.remove('drag'));
    preview.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      preview.classList.remove('drag');
      const f = e.dataTransfer?.files[0];
      if (f) this.importFile(f);
    });

    // Animate the preview only while the settings drawer is open.
    new MutationObserver(() => this.animate()).observe($('settings'), { attributes: true, attributeFilter: ['hidden'] });
    this.render();
  }

  private patch(p: Partial<MarkerSettings>) {
    this.set({ ...this.get(), ...p });
    this.render();
  }

  private setKind(kind: MarkerKind) {
    const ms = this.get();
    if (kind === ms.kind) return;
    // Default rotation per type (§14.3): Rotate for built-in shapes, Fixed for images.
    const rotation = kind === 'image' ? 'fixed' : kind === 'dot' ? ms.rotation : ms.kind === 'image' ? 'rotate' : ms.rotation;
    this.patch({ kind, rotation });
  }

  private async importFile(f: File) {
    try {
      const url = await importMarkerImage(f);
      const ms = this.get();
      if (ms.kind !== 'image') this.lastKind = ms.kind;
      this.patch({ kind: 'image', imageDataUrl: url, rotation: ms.kind === 'image' ? ms.rotation : 'fixed' });
    } catch (err) {
      this.toast(`Could not use ${f.name}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  render(): void {
    const ms = this.get();
    if (ms.kind !== 'image') this.lastKind = ms.kind;
    this.view.set(ms);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mk-kinds button')) b.classList.toggle('active', b.dataset.kind === ms.kind);
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mk-icons button')) {
      b.classList.toggle('active', ms.kind === 'icon' && b.dataset.icon === ms.icon);
      const img = b.querySelector('img')!;
      const src = iconUrl(b.dataset.icon as MarkerSettings['icon'], ms.color);
      if (img.src !== src) img.src = src;
    }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mk-colors button')) b.classList.toggle('active', b.dataset.color === ms.color.toLowerCase());
    $<HTMLInputElement>('mk-color').value = ms.color;
    $('mk-icons').hidden = ms.kind !== 'icon';
    $('mk-remove').hidden = !ms.imageDataUrl;
    $('mk-color-row').hidden = ms.kind === 'image';
    $<HTMLInputElement>('mk-size').value = String(ms.sizePx);
    $('mk-size-v').textContent = `${ms.sizePx} px`;
    $<HTMLInputElement>('mk-halo').checked = ms.halo;
    const rot = $<HTMLSelectElement>('mk-rotation');
    rot.value = ms.rotation;
    rot.disabled = ms.kind === 'dot';
    $('mk-front-row').hidden = ms.kind !== 'image';
    const preset = FRONTS.includes(String(ms.imageFrontDeg));
    $<HTMLSelectElement>('mk-front').value = preset ? String(ms.imageFrontDeg) : 'custom';
    $<HTMLInputElement>('mk-front-deg').value = String(ms.imageFrontDeg);
    $('mk-front-deg').hidden = preset;
  }

  private animate() {
    cancelAnimationFrame(this.raf);
    if ($('settings').hidden) return;
    const tick = (now: number) => {
      const box = $('mk-preview');
      const a = ((now % PREVIEW_PERIOD_MS) / PREVIEW_PERIOD_MS) * Math.PI * 2;
      const x = box.clientWidth / 2 + Math.sin(a) * PREVIEW_RADIUS * 1.8;
      const y = box.clientHeight / 2 - Math.cos(a) * PREVIEW_RADIUS;
      // Direction of travel along the ellipse, clockwise on screen.
      const dx = Math.cos(a) * 1.8;
      const dy = Math.sin(a);
      const heading = (Math.atan2(dx, -dy) * 180) / Math.PI;
      this.view.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      this.view.update(heading, true);
      if (!$('settings').hidden) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Scroll the drawer to this group (from the export dialog's "Change marker…"). */
  reveal(): void {
    $('marker-panel').scrollIntoView({ block: 'start' });
  }
}
