import { FIT_MIN_SEC, INTRO_FLY_SEC, INTRO_HOLD_SEC, OUTRO_FLY_SEC, OUTRO_HOLD_SEC } from './presets';

// Frame index → playback position for the video (§13.2, §13.3). Pure, so it is unit-tested.

export interface PlanInput {
  from: number; // playback timeline, ms
  to: number;
  rateMode: 'preset' | 'fit';
  rate: number;
  targetSec: number;
  fps: number;
  intro: boolean;
  outro: boolean;
}

export interface Plan {
  from: number;
  to: number;
  rate: number;
  fps: number;
  introHold: number; // frame counts of each part
  introFly: number;
  main: number;
  outroFly: number;
  outroHold: number;
  total: number;
  seconds: number;
}

export type Phase = 'intro-hold' | 'intro-fly' | 'main' | 'outro-fly' | 'outro-hold';

export interface FrameInfo {
  pos: number;
  phase: Phase;
  /** Camera blend: 0 = whole-track overview, 1 = the chosen camera. */
  follow: number;
  /** Video time of the frame, seconds. */
  t: number;
}

/** Rate used for "Fit to duration": never slower than realtime. */
export function fitRate(spanMs: number, targetSec: number): number {
  return Math.max(1, spanMs / 1000 / Math.max(FIT_MIN_SEC, targetSec));
}

export function makePlan(p: PlanInput): Plan {
  const span = Math.max(0, p.to - p.from);
  const rate = p.rateMode === 'fit' ? fitRate(span, p.targetSec) : Math.max(1, p.rate);
  const frames = (sec: number) => Math.round(sec * p.fps);
  const main = Math.floor((span / rate / 1000) * p.fps + 1e-6) + 1;
  const introHold = p.intro ? frames(INTRO_HOLD_SEC) : 0;
  const introFly = p.intro ? frames(INTRO_FLY_SEC) : 0;
  const outroFly = p.outro ? frames(OUTRO_FLY_SEC) : 0;
  const outroHold = p.outro ? frames(OUTRO_HOLD_SEC) : 0;
  const total = introHold + introFly + main + outroFly + outroHold;
  return { from: p.from, to: p.to, rate, fps: p.fps, introHold, introFly, main, outroFly, outroHold, total, seconds: total / p.fps };
}

const ease = (x: number) => x * x * (3 - 2 * x);

export function frameAt(plan: Plan, k: number): FrameInfo {
  const t = k / plan.fps;
  let j = k;
  if (j < plan.introHold) return { pos: plan.from, phase: 'intro-hold', follow: 0, t };
  j -= plan.introHold;
  if (j < plan.introFly) return { pos: plan.from, phase: 'intro-fly', follow: ease((j + 1) / (plan.introFly + 1)), t };
  j -= plan.introFly;
  if (j < plan.main) {
    const pos = Math.min(plan.to, plan.from + (j / plan.fps) * plan.rate * 1000);
    return { pos, phase: 'main', follow: 1, t };
  }
  j -= plan.main;
  if (j < plan.outroFly) return { pos: plan.to, phase: 'outro-fly', follow: 1 - ease((j + 1) / (plan.outroFly + 1)), t };
  return { pos: plan.to, phase: 'outro-hold', follow: 0, t };
}

/** "h:mm:ss", "mm:ss" or seconds → seconds; NaN if unreadable. */
export function parseClock(text: string): number {
  const parts = text.trim().split(':').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}
