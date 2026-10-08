// The scene plan: the one description of the movie. The browser preview draws it
// and the MP4 renderer (server/) reads the very same file. No DOM in here.

export type Pace = 'relaxed' | 'quicker';
export const MUSIC_IDS = ['gentle', 'warm', 'golden', 'cafe', 'porch', 'sunny', 'parade', 'musicbox', 'waltz', 'aurora', 'neon', 'calm'] as const;
export type MusicId = (typeof MUSIC_IDS)[number] | 'none';

export interface MovieOptions {
  title: string;
  music: MusicId;
  pace: Pace;
  reducedMotion: boolean;
  /** Keep each clip's own sound (and lower the music under it). */
  clipSound: boolean;
}

/** What the plan needs to know about one chosen item, in the order the user arranged them. */
export type PlanItem =
  | { kind: 'photo' }
  | {
      kind: 'video';
      /** Length of the whole source clip, seconds. */
      duration: number;
      hasAudio: boolean;
      /** The user's own trim, or null to let Memento pick a short excerpt. */
      trim: Trim | null;
    };

export interface Trim {
  start: number;
  length: number;
}

export interface Scene {
  kind: 'title' | 'photo' | 'video';
  start: number;
  end: number;
  /** Index into the item list, or -1 for the title card. */
  itemIndex: number;
  /** Photos only breathe between minScale and 1. Nothing is ever cropped. Clips do not zoom. */
  zoom: 'in' | 'out' | 'none';
  /** Video scenes: the excerpt of the source clip and whether its sound is used. */
  clip?: { start: number; length: number; audio: boolean };
  /** How this scene arrives over the one before it. The first scene has none. */
  transition: Transition;
}

/**
 * fade: a soft dissolve. glide: the next picture drifts in from the right while it dissolves.
 * rise: it floats up from slightly below. dip: the film dims, then the next picture emerges from the dark.
 */
export type Transition = 'none' | 'fade' | 'glide' | 'rise' | 'dip';

/** The rhythm of arrivals: mostly dissolves, a drift or a rise now and then, a dip once in a while. */
export const TRANSITION_ROTATION: readonly Transition[] = ['fade', 'glide', 'fade', 'rise', 'fade', 'dip'];
/** How far a glide or rise travels, as a fraction of the frame. */
export const GLIDE_X = 0.07;
export const RISE_Y = 0.06;
/** How dark the frame gets at the middle of a dip. */
export const DIP_LEVEL = 0.85;

export interface DuckPoint {
  t: number;
  /** Music gain multiplier, 1 = untouched. */
  g: number;
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
  /** Piecewise-linear music level while clips with sound play. The preview and the MP4 both follow it. */
  duck: DuckPoint[];
}

export const FRAME = { width: 1280, height: 720 } as const;
export const MAX_ITEMS = 60;
/** Phones keep a decoder alive per video element, so clips are capped well below the item limit. */
export const MAX_CLIPS = 12;
export const MAX_TITLE = 60;
export const TITLE_CARD_SECONDS = 3.6;

/** Shortest and longest excerpt of a clip, seconds. */
export const MIN_CLIP_SECONDS = 1.5;
export const MAX_CLIP_SECONDS = 20;
/** Music level while a clip with sound plays. */
export const DUCK_LEVEL = 0.18;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Seconds each still is on screen, transition included. Fewer items get a shorter film, not stretched
 * stills. The first version used 52/n (4.2 to 7 s); this is about half of that.
 */
export function secondsPerPhoto(count: number, pace: Pace): number {
  const n = Math.max(1, count);
  return pace === 'relaxed' ? clamp(26 / n, 2.4, 3.5) : clamp(18.5 / n, 1.9, 2.3);
}

/** The excerpt Memento picks when the user has not trimmed: a few seconds, a little way in. */
export function defaultTrim(duration: number, pace: Pace): Trim {
  const target = pace === 'relaxed' ? 6 : 4.5;
  if (duration <= target + 1.5) return { start: 0, length: duration };
  const start = clamp(duration * 0.2, 0, duration - target);
  return { start, length: target };
}

/** Make any trim legal for a clip of `duration` seconds. */
export function fitTrim(trim: Trim, duration: number): Trim {
  const length = clamp(trim.length, Math.min(MIN_CLIP_SECONDS, duration), Math.min(MAX_CLIP_SECONDS, duration));
  const start = clamp(trim.start, 0, Math.max(0, duration - length));
  return { start, length };
}

/** The excerpt that will actually play: the user's trim, or Memento's pick, made legal. */
export function resolveTrim(duration: number, trim: Trim | null, pace: Pace): Trim {
  return fitTrim(trim ?? defaultTrim(duration, pace), duration);
}

export function buildPlan(items: PlanItem[], opts: MovieOptions): ScenePlan {
  const crossfade = opts.reducedMotion ? 0.7 : 0.9;
  const title = opts.title.trim().slice(0, MAX_TITLE);
  const per = secondsPerPhoto(items.length, opts.pace);
  const scenes: Scene[] = [];
  let cursor = 0;
  let stillCount = 0;

  if (title && items.length > 0) {
    scenes.push({ kind: 'title', start: 0, end: TITLE_CARD_SECONDS, itemIndex: -1, zoom: 'none', transition: 'none' });
    cursor = TITLE_CARD_SECONDS - crossfade;
  }
  items.forEach((item, i) => {
    const start = cursor;
    let scene: Scene;
    if (item.kind === 'video') {
      const trim = resolveTrim(item.duration, item.trim, opts.pace);
      scene = {
        kind: 'video',
        start,
        end: start + trim.length,
        itemIndex: i,
        zoom: 'none',
        clip: { start: trim.start, length: trim.length, audio: item.hasAudio && opts.clipSound },
        transition: 'none',
      };
    } else {
      const zoom = opts.reducedMotion ? 'none' : stillCount % 2 === 0 ? 'in' : 'out';
      stillCount++;
      scene = { kind: 'photo', start, end: start + per, itemIndex: i, zoom, transition: 'none' };
    }
    scenes.push(scene);
    cursor = scene.end - crossfade;
  });

  assignTransitions(scenes, crossfade, opts.reducedMotion);
  const duration = scenes.length ? scenes[scenes.length - 1].end : 0;
  return {
    width: FRAME.width,
    height: FRAME.height,
    duration,
    fadeIn: 1.2,
    fadeOut: 1.8,
    crossfade,
    minScale: 0.955,
    title,
    music: opts.music,
    scenes,
    duck: buildDuck(scenes, duration),
  };
}

/**
 * Give each scene after the first its way of arriving. Gentle only: with reduced motion everything is
 * a dissolve, and a scene too short to hold two full transitions also just dissolves.
 */
function assignTransitions(scenes: Scene[], crossfade: number, reduced: boolean): void {
  for (let i = 1; i < scenes.length; i++) {
    const wanted = TRANSITION_ROTATION[(i - 1) % TRANSITION_ROTATION.length];
    const roomy = scenes[i].end - scenes[i].start >= 2 * crossfade + 0.2;
    scenes[i].transition = reduced || !roomy ? 'fade' : wanted;
  }
}

/**
 * Music comes down under a clip's own sound and back up after it. Clips close together share one
 * dip instead of pumping. Ramps are linear so FFmpeg can reproduce them exactly.
 */
function buildDuck(scenes: Scene[], duration: number): DuckPoint[] {
  const DOWN = 0.8; // ramp length going down, ending 0.4s into the clip
  const UP = 1.2; // ramp length coming back, starting 0.4s before the clip ends
  const holds: { a: number; b: number }[] = [];
  for (const s of scenes) {
    if (s.kind !== 'video' || !s.clip?.audio) continue;
    const a = s.start + 0.4;
    const b = Math.max(a, s.end - 0.4);
    const last = holds[holds.length - 1];
    if (last && a - DOWN <= last.b + UP) last.b = Math.max(last.b, b);
    else holds.push({ a, b });
  }
  if (!holds.length) return [{ t: 0, g: 1 }, { t: duration, g: 1 }];

  const raw: DuckPoint[] = [];
  for (const h of holds) {
    raw.push({ t: h.a - DOWN, g: 1 }, { t: h.a, g: DUCK_LEVEL }, { t: h.b, g: DUCK_LEVEL }, { t: h.b + UP, g: 1 });
  }
  // Clip the curve to [0, duration], keeping its shape at the edges.
  const at = (t: number) => interp(raw, t);
  const pts: DuckPoint[] = [{ t: 0, g: at(0) }];
  for (const p of raw) if (p.t > 0 && p.t < duration) pts.push(p);
  pts.push({ t: duration, g: at(duration) });
  return pts;
}

function interp(points: DuckPoint[], t: number): number {
  if (t <= points[0].t) return points[0].g;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) return b.t === a.t ? b.g : a.g + ((b.g - a.g) * (t - a.t)) / (b.t - a.t);
  }
  return points[points.length - 1].g;
}

/** Music level multiplier at time `t`. */
export function musicGain(plan: Pick<ScenePlan, 'duck'>, t: number): number {
  return interp(plan.duck, t);
}

/** Opacity of scene `i` at time `t`. The first scene is opaque; the black overlay fades it in. */
export function sceneAlpha(plan: ScenePlan, i: number, t: number): number {
  if (i === 0) return t >= plan.scenes[0].start ? 1 : 0;
  const p = (t - plan.scenes[i].start) / plan.crossfade;
  // After a dip the new picture only starts to appear once the frame is darkest.
  return plan.scenes[i].transition === 'dip' ? clamp((p - 0.5) * 2, 0, 1) : clamp(p, 0, 1);
}

/** Where scene `i` sits at time `t`, in frame pixels away from rest. Only glides and rises move. */
export function sceneOffset(plan: ScenePlan, i: number, t: number): { x: number; y: number } {
  const s = plan.scenes[i];
  const p = clamp((t - s.start) / plan.crossfade, 0, 1);
  const left = 1 - (0.5 - Math.cos(p * Math.PI) / 2); // 1 at the start of the arrival, 0 once settled
  if (s.transition === 'glide') return { x: plan.width * GLIDE_X * left, y: 0 };
  if (s.transition === 'rise') return { x: 0, y: plan.height * RISE_Y * left };
  return { x: 0, y: 0 };
}

/** How dark the whole frame is at `t` because of a dip (0 when none is under way). */
export function dimAlpha(plan: ScenePlan, t: number): number {
  let dim = 0;
  for (const s of plan.scenes) {
    if (s.transition !== 'dip') continue;
    const p = (t - s.start) / plan.crossfade;
    if (p > 0 && p < 1) dim = Math.max(dim, DIP_LEVEL * (1 - Math.abs(2 * p - 1)));
  }
  return dim;
}

/** Opacity of the black overlay: fade in from black at the start, out to black at the end. */
export function blackAlpha(plan: ScenePlan, t: number): number {
  const fin = 1 - t / plan.fadeIn;
  const fout = (t - (plan.duration - plan.fadeOut)) / plan.fadeOut;
  return clamp(Math.max(fin, fout), 0, 1);
}

/** How long a clip's own sound fades in and out, so cuts between clips and stills never click. */
export function clipFades(plan: ScenePlan, i: number): { in: number; out: number } {
  return { in: i === 0 ? plan.fadeIn : plan.crossfade, out: i === plan.scenes.length - 1 ? plan.fadeOut : plan.crossfade };
}

/** Volume (0..1) of the clip in scene `i` at time `t`. */
export function clipVolume(plan: ScenePlan, i: number, t: number): number {
  const s = plan.scenes[i];
  const f = clipFades(plan, i);
  return clamp(Math.min((t - s.start) / f.in, (s.end - t) / f.out), 0, 1);
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
