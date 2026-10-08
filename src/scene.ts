// The scene plan: the one description of the movie. The browser preview draws it
// today; the MP4 renderer (milestone 2) will read the same plan. No DOM in here.

export type Pace = 'relaxed' | 'quicker';
export type MusicId = 'gentle' | 'warm' | 'none';

export interface MovieOptions {
  title: string;
  music: MusicId;
  pace: Pace;
  reducedMotion: boolean;
}

export interface Scene {
  kind: 'title' | 'photo';
  start: number;
  end: number;
  /** Index into the photo list, or -1 for the title card. */
  photoIndex: number;
  /** Photos only breathe between this scale and 1. They are never cropped. */
  zoom: 'in' | 'out' | 'none';
}

export interface ScenePlan {
  width: number;
  height: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  crossfade: number;
  /** Smallest photo scale, as a fraction of the fitted size. */
  minScale: number;
  title: string;
  music: MusicId;
  scenes: Scene[];
}

export const FRAME = { width: 1280, height: 720 } as const;
export const MAX_PHOTOS = 20;
export const MAX_TITLE = 60;
export const TITLE_CARD_SECONDS = 3.6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Seconds each photo is on screen. Fewer photos get a shorter film, not stretched stills. */
export function secondsPerPhoto(count: number, pace: Pace): number {
  const n = Math.max(1, count);
  return pace === 'relaxed' ? clamp(52 / n, 4.2, 7) : clamp(36 / n, 3, 4.2);
}

export function buildPlan(photoCount: number, opts: MovieOptions): ScenePlan {
  const crossfade = opts.reducedMotion ? 0.8 : 1.2;
  const title = opts.title.trim().slice(0, MAX_TITLE);
  const per = secondsPerPhoto(photoCount, opts.pace);
  const scenes: Scene[] = [];
  let cursor = 0;

  if (title && photoCount > 0) {
    scenes.push({ kind: 'title', start: 0, end: TITLE_CARD_SECONDS, photoIndex: -1, zoom: 'none' });
    cursor = TITLE_CARD_SECONDS - crossfade;
  }
  for (let i = 0; i < photoCount; i++) {
    const start = cursor;
    const end = start + per;
    const zoom = opts.reducedMotion ? 'none' : i % 2 === 0 ? 'in' : 'out';
    scenes.push({ kind: 'photo', start, end, photoIndex: i, zoom });
    cursor = end - crossfade;
  }

  return {
    width: FRAME.width,
    height: FRAME.height,
    duration: scenes.length ? scenes[scenes.length - 1].end : 0,
    fadeIn: 1.2,
    fadeOut: 1.8,
    crossfade,
    minScale: 0.955,
    title,
    music: opts.music,
    scenes,
  };
}

/** Opacity of scene `i` at time `t`. The first scene is opaque; the black overlay fades it in. */
export function sceneAlpha(plan: ScenePlan, i: number, t: number): number {
  if (i === 0) return t >= plan.scenes[0].start ? 1 : 0;
  return clamp((t - plan.scenes[i].start) / plan.crossfade, 0, 1);
}

/** Opacity of the black overlay: fade in from black at the start, out to black at the end. */
export function blackAlpha(plan: ScenePlan, t: number): number {
  const fin = 1 - t / plan.fadeIn;
  const fout = (t - (plan.duration - plan.fadeOut)) / plan.fadeOut;
  return clamp(Math.max(fin, fout), 0, 1);
}

/** Photo scale at progress p (0..1) through its scene. */
export function photoScale(plan: ScenePlan, zoom: Scene['zoom'], p: number): number {
  const e = 0.5 - Math.cos(clamp(p, 0, 1) * Math.PI) / 2; // ease in-out
  if (zoom === 'in') return plan.minScale + (1 - plan.minScale) * e;
  if (zoom === 'out') return 1 - (1 - plan.minScale) * e;
  return 1;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
