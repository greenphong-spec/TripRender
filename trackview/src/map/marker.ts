import type { MarkerIcon, MarkerSettings } from '../settings';

// Position marker (§14): one definition for the live map, the settings preview and the video.

interface Shape {
  /** Tight viewBox, so the longest side of the drawing is the marker size. */
  vb: [number, number, number, number];
  /** SVG body; `C` is replaced by the marker colour. Front of the vehicle points up. */
  body: string;
}

const W = 'stroke="#fff" stroke-linejoin="round"';

const ARROW: Shape = {
  vb: [3, 1, 26, 29.5],
  body: `<path d="M16 2.5 L27.5 28.5 L16 22.5 L4.5 28.5 Z" fill="C" ${W} stroke-width="2"/>`,
};

export const ICONS: Record<MarkerIcon, Shape> = {
  car: {
    vb: [7.5, 1, 17, 30],
    body:
      `<rect x="8.5" y="2" width="15" height="28" rx="5" fill="C" ${W} stroke-width="1.6"/>` +
      `<path d="M10.6 11 Q16 8.6 21.4 11 L20.4 14.6 Q16 13.6 11.6 14.6 Z" fill="#fff" fill-opacity=".85"/>` +
      `<path d="M11.4 24 Q16 25 20.6 24 L21 27 Q16 28.4 11 27 Z" fill="#fff" fill-opacity=".7"/>`,
  },
  motorbike: {
    vb: [6, 0.5, 20, 31],
    body:
      `<rect x="14" y="1.5" width="4" height="8" rx="2" fill="#1a1a1a" ${W}/>` +
      `<rect x="14" y="22.5" width="4" height="8" rx="2" fill="#1a1a1a" ${W}/>` +
      `<rect x="7" y="9" width="18" height="2.6" rx="1.3" fill="C" ${W}/>` +
      `<path d="M12.5 11 h7 l1 12 q-4.5 3 -9 0z" fill="C" ${W} stroke-width="1.4"/>`,
  },
  bicycle: {
    vb: [7, 1, 18, 30],
    body:
      `<rect x="14.75" y="2" width="2.5" height="9" rx="1.25" fill="#1a1a1a" ${W}/>` +
      `<rect x="14.75" y="21" width="2.5" height="9" rx="1.25" fill="#1a1a1a" ${W}/>` +
      `<rect x="8" y="9.5" width="16" height="2" rx="1" fill="C" ${W}/>` +
      `<circle cx="16" cy="16" r="4.5" fill="C" ${W} stroke-width="1.4"/>`,
  },
  walker: {
    vb: [6, 2, 20, 21],
    body:
      `<path d="M16 3 l4 6 h-8z" fill="C" ${W}/>` +
      `<ellipse cx="16" cy="17" rx="9" ry="5" fill="C" ${W} stroke-width="1.4"/>` +
      `<circle cx="16" cy="16.5" r="4.2" fill="#f2c9a0" ${W} stroke-width="1.2"/>`,
  },
  truck: {
    vb: [7, 1, 18, 30.5],
    body:
      `<rect x="9" y="2" width="14" height="8" rx="3" fill="C" ${W} stroke-width="1.4"/>` +
      `<path d="M11 4 h10 v3 h-10z" fill="#fff" fill-opacity=".8"/>` +
      `<rect x="8" y="11" width="16" height="19.5" rx="1.5" fill="C" ${W} stroke-width="1.4"/>` +
      `<path d="M12 14v13.5M16 14v13.5M20 14v13.5" stroke="#fff" stroke-opacity=".45"/>`,
  },
  boat: {
    vb: [8, 0.5, 16, 30.5],
    body:
      `<path d="M16 1.5 C22 7 23.5 14 23 30 H9 C8.5 14 10 7 16 1.5Z" fill="C" ${W} stroke-width="1.6"/>` +
      `<rect x="12" y="15" width="8" height="9" rx="1.5" fill="#fff" fill-opacity=".8"/>`,
  },
};

export const ICON_NAMES = Object.keys(ICONS) as MarkerIcon[];

/** SVG data URL of a built-in shape in the given colour. */
function shapeUrl(shape: Shape, color: string): string {
  const [x, y, w, h] = shape.vb;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w * 8}" height="${h * 8}">` +
    shape.body.replaceAll('"C"', `"${color}"`) +
    '</svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function iconUrl(icon: MarkerIcon, color: string): string {
  return shapeUrl(ICONS[icon], color);
}

/** The picture drawn for a marker, or null for the dot (drawn with CSS / canvas). */
export function markerImageUrl(ms: MarkerSettings): string | null {
  if (ms.kind === 'arrow') return shapeUrl(ARROW, ms.color);
  if (ms.kind === 'icon') return shapeUrl(ICONS[ms.icon], ms.color);
  if (ms.kind === 'image' && ms.imageDataUrl) return ms.imageDataUrl;
  return null;
}

/** Aspect ratio (w / h) of a built-in shape; images report theirs once loaded. */
function shapeAspect(ms: MarkerSettings): number {
  const vb = ms.kind === 'arrow' ? ARROW.vb : ms.kind === 'icon' ? ICONS[ms.icon].vb : null;
  return vb ? vb[2] / vb[3] : 1;
}

/** Box with the longest side = size. */
export function fitBox(size: number, aspect: number): [number, number] {
  return aspect >= 1 ? [size, size / aspect] : [size * aspect, size];
}

/** Which way the picture faces: built-in shapes face up. */
const frontOf = (ms: MarkerSettings) => (ms.kind === 'image' ? ms.imageFrontDeg : 0);

export interface Pose {
  rotate: number; // degrees clockwise on screen
  flip: boolean; // mirrored left/right
}

/**
 * How to draw the marker for a direction of travel given in *screen* degrees
 * (travel bearing − map bearing; NaN when unknown) (§14.3).
 */
export function markerPose(ms: MarkerSettings, screenDeg: number, prevFlip = false): Pose {
  if (ms.kind === 'dot' || ms.rotation === 'fixed') return { rotate: 0, flip: false };
  const front = frontOf(ms);
  if (ms.rotation === 'rotate') return { rotate: Number.isFinite(screenDeg) ? screenDeg - front : 0, flip: false };
  // Flip: face right when travelling right on screen. Hold the last choice when moving straight up/down.
  const east = Math.sin((screenDeg * Math.PI) / 180);
  const facesRight = Math.sin((front * Math.PI) / 180) >= 0;
  const flip = !Number.isFinite(east) || Math.abs(east) < 0.05 ? prevFlip : east > 0 !== facesRight;
  return { rotate: 0, flip };
}

export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(210, 64, 30, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}

const DOT_SCALE = 0.75; // the dot's diameter relative to the marker size (24 px → 18 px, as in v0.1)

/** The marker as a DOM element (live map and settings preview). */
export class MarkerView {
  readonly el = document.createElement('div');
  private halo = document.createElement('div');
  private body: HTMLElement = document.createElement('div');
  private wedge = document.createElement('div');
  private ms: MarkerSettings | null = null;
  private flip = false;

  constructor() {
    this.el.className = 'mk';
    this.halo.className = 'mk-halo';
    this.wedge.className = 'mk-wedge';
    this.el.append(this.halo, this.body);
  }

  set(ms: MarkerSettings): void {
    this.ms = ms;
    const url = markerImageUrl(ms);
    const size = ms.sizePx;
    if (!url) {
      const d = Math.max(8, size * DOT_SCALE);
      const dot = document.createElement('div');
      dot.className = 'mk-body mk-dot';
      dot.style.cssText = `width:${d}px;height:${d}px;background:${ms.color}`;
      dot.append(this.wedge);
      this.wedge.style.setProperty('--wedge-off', `${-(d / 2 + 6)}px`);
      this.wedge.style.borderBottomColor = ms.color;
      this.body.replaceWith(dot);
      this.body = dot;
      this.setBox(d, d, d + 24);
    } else {
      const img = document.createElement('img');
      img.className = 'mk-body mk-img';
      img.alt = '';
      img.draggable = false;
      const place = (aspect: number) => {
        const [w, h] = fitBox(size, aspect);
        img.style.width = `${w}px`;
        img.style.height = `${h}px`;
        this.setBox(w, h, size * 1.7);
      };
      place(shapeAspect(ms));
      if (ms.kind === 'image') img.onload = () => place(img.naturalWidth / img.naturalHeight || 1);
      img.src = url;
      this.body.replaceWith(img);
      this.body = img;
    }
    this.halo.hidden = !ms.halo;
    this.halo.style.background = ms.kind === 'image' ? 'rgba(20, 30, 30, 0.22)' : hexToRgba(ms.color, 0.22);
    this.el.classList.toggle('image', ms.kind === 'image');
  }

  private setBox(w: number, h: number, halo: number) {
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    this.halo.style.width = this.halo.style.height = `${halo}px`;
  }

  /** screenDeg: direction of travel on screen, NaN when unknown. */
  update(screenDeg: number, playing: boolean): void {
    const ms = this.ms;
    if (!ms) return;
    this.el.classList.toggle('playing', playing);
    if (ms.kind === 'dot') {
      this.wedge.hidden = !Number.isFinite(screenDeg);
      if (!this.wedge.hidden) this.wedge.style.setProperty('--heading', `${screenDeg}deg`);
      return;
    }
    const pose = markerPose(ms, screenDeg, this.flip);
    this.flip = pose.flip;
    this.body.style.transform = `translate(-50%, -50%) rotate(${pose.rotate}deg)${pose.flip ? ' scaleX(-1)' : ''}`;
  }
}

/** A marker picture prepared for drawing on a canvas (video export). */
export interface MarkerSprite {
  ms: MarkerSettings;
  img: HTMLImageElement | null;
  w: number;
  h: number;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The file could not be read as an image.'));
    img.src = url;
  });
}

/** Load the marker picture; `scale` converts the CSS size to output pixels. */
export async function prepareSprite(ms: MarkerSettings, scale: number): Promise<MarkerSprite> {
  const url = markerImageUrl(ms);
  if (!url) {
    const d = Math.max(8, ms.sizePx * DOT_SCALE) * scale;
    return { ms, img: null, w: d, h: d };
  }
  const img = await loadImage(url);
  const aspect = ms.kind === 'image' ? img.naturalWidth / img.naturalHeight || 1 : shapeAspect(ms);
  const [w, h] = fitBox(ms.sizePx * scale, aspect);
  return { ms, img, w, h };
}

/** Draw the marker centred at (x, y). */
export function drawMarker(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  sp: MarkerSprite,
  x: number,
  y: number,
  pose: Pose,
  screenDeg: number,
  scale: number,
): void {
  const ms = sp.ms;
  ctx.save();
  ctx.translate(x, y);
  if (ms.halo) {
    const r = sp.img ? (ms.sizePx * scale * 1.7) / 2 : sp.w / 2 + 12 * scale;
    ctx.fillStyle = sp.img && ms.kind === 'image' ? 'rgba(20, 30, 30, 0.22)' : hexToRgba(ms.color, 0.22);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }
  if (!sp.img) {
    const r = sp.w / 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ms.color;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1, r - 3 * scale), 0, Math.PI * 2);
    ctx.fill();
    if (Number.isFinite(screenDeg)) {
      ctx.rotate((screenDeg * Math.PI) / 180);
      ctx.beginPath();
      ctx.moveTo(0, -r - 13 * scale);
      ctx.lineTo(5 * scale, -r - 6 * scale);
      ctx.lineTo(-5 * scale, -r - 6 * scale);
      ctx.closePath();
      ctx.fill();
    }
  } else {
    ctx.rotate((pose.rotate * Math.PI) / 180);
    if (pose.flip) ctx.scale(-1, 1);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3 * scale;
    ctx.shadowOffsetY = 1 * scale;
    ctx.drawImage(sp.img, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
  }
  ctx.restore();
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PX = 256;
const IMAGE_EXT = /\.(png|jpe?g|webp|svg)$/i;
const IMAGE_MIME = /^image\/(png|jpeg|webp|svg\+xml)$/;

/**
 * Read a user image for the marker: check it, scale it down to 256 px and return a PNG data URL (§14.4).
 * SVGs only ever go through an <img>, where scripts do not run.
 */
export async function importMarkerImage(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('The image is larger than 5 MB.');
  if (!IMAGE_EXT.test(file.name) && !IMAGE_MIME.test(file.type)) throw new Error('Use a PNG, JPG, WebP or SVG image.');
  const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : '');
  const url = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type }));
  try {
    const img = await loadImage(url);
    const w0 = img.naturalWidth || MAX_IMAGE_PX;
    const h0 = img.naturalHeight || MAX_IMAGE_PX;
    const k = Math.min(1, MAX_IMAGE_PX / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * k));
    canvas.height = Math.max(1, Math.round(h0 * k));
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
