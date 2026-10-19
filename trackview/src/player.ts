import type { Track } from './model/types';

export const RATES = [1, 10, 30, 60, 120, 240, 600, 1200];
const TARGET_REPLAY_MS = 90_000;
const MAX_FRAME_MS = 100;

/** Smallest listed rate that replays the whole track in at most 90 s. */
export function autoRate(durationMs: number): number {
  return RATES.find((r) => durationMs / r <= TARGET_REPLAY_MS) ?? RATES[RATES.length - 1];
}

type Listener = () => void;

/** Playback clock over a track's playback timeline (ms). */
export class Player {
  track: Track | null = null;
  pos = 0;
  playing = false;
  rate = 120;

  private posListeners = new Set<Listener>();
  private stateListeners = new Set<Listener>();
  private raf = 0;
  private last = 0;

  get duration(): number {
    return this.track ? this.track.stats.duration : 0;
  }

  onPosition(fn: Listener) { this.posListeners.add(fn); }
  onState(fn: Listener) { this.stateListeners.add(fn); }
  private emitPos() { this.posListeners.forEach((f) => f()); }
  private emitState() { this.stateListeners.forEach((f) => f()); }

  setTrack(track: Track | null, pos = 0): void {
    this.pause();
    this.track = track;
    this.pos = Math.min(Math.max(0, pos), this.duration);
    this.emitState();
    this.emitPos();
  }

  play(): void {
    if (!this.track || this.playing) return;
    if (this.pos >= this.duration) this.pos = 0;
    this.playing = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    this.emitState();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emitState();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(pos: number): void {
    if (!this.track) return;
    this.pos = Math.min(Math.max(0, pos), this.duration);
    this.emitPos();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.emitState();
  }

  private tick = (now: number) => {
    const dt = Math.min(MAX_FRAME_MS, now - this.last);
    this.last = now;
    this.pos = Math.min(this.duration, this.pos + dt * this.rate);
    this.emitPos();
    if (this.pos >= this.duration) this.pause();
    else this.raf = requestAnimationFrame(this.tick);
  };
}
