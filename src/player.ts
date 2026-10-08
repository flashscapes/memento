import { drawFrame } from './render.ts';
import type { Media } from './media.ts';
import { buildPlan, clipVolume, type MovieOptions, type ScenePlan } from './scene.ts';
import { toPlanItems } from './media.ts';
import type { MusicEngine } from './music.ts';

export type PlayerState = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlayerOptions {
  /** Canvas pixels per frame pixel (1 = 1280x720). */
  scale: number;
  loop: boolean;
  music: MusicEngine | null;
  onState?: (s: PlayerState) => void;
  onTime?: (t: number, duration: number) => void;
  /** The browser refused to play a clip with its sound, so it plays silently instead. */
  onClipSoundBlocked?: () => void;
}

/** Seconds before a clip starts that its element is moved to the first frame. */
const PRELOAD = 2;
/** A clip may wander this far from the movie clock before it is nudged back. */
const DRIFT = 0.4;

/** Draws the scene plan on a canvas in real time. This is the browser preview, not a video file. */
export class Player {
  private ctx: CanvasRenderingContext2D;
  private plan: ScenePlan | null = null;
  private media: Media[] = [];
  private videos: HTMLVideoElement[] = [];
  private raf = 0;
  private startedAt = 0;
  private base = 0;
  private t = 0;
  private muted = false;
  private corrected = new WeakMap<HTMLVideoElement, number>();
  state: PlayerState = 'idle';
  musicId: MovieOptions['music'] = 'none';

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: PlayerOptions,
  ) {
    canvas.width = Math.round(1280 * opts.scale);
    canvas.height = Math.round(720 * opts.scale);
    this.ctx = canvas.getContext('2d')!;
  }

  get duration(): number {
    return this.plan?.duration ?? 0;
  }
  get time(): number {
    return this.t;
  }
  get planInfo(): ScenePlan | null {
    return this.plan;
  }
  get hasClips(): boolean {
    return this.videos.length > 0;
  }

  setMovie(media: Media[], options: MovieOptions, poster = 0): void {
    this.stopLoop();
    this.opts.music?.stop();
    this.detach();
    this.media = media;
    this.videos = media.flatMap((m) => (m.kind === 'video' ? [m.video] : []));
    for (const v of this.videos) v.addEventListener('seeked', this.onSeeked);
    this.plan = buildPlan(toPlanItems(media), options);
    this.musicId = options.music;
    this.t = poster;
    this.base = poster;
    this.setState('idle');
    this.syncVideos(false);
    this.draw();
  }

  /** Mute everything: the soundtrack and the clips' own sound. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.opts.music?.setMuted(muted);
    this.syncVideos(this.state === 'playing');
  }

  /**
   * Call inside the tap that starts the movie. Phones only let a video element make sound later if
   * it was started by a tap, so each clip gets a silent nudge here.
   */
  prime(): void {
    for (const v of this.videos) {
      try {
        v.muted = true;
        const p = v.play();
        if (p) {
          p.then(() => {
            if (!this.isActive(v)) v.pause();
          }).catch(() => {});
        }
      } catch {
        /* a clip that can't be primed still plays when its turn comes */
      }
    }
  }

  play(): void {
    if (!this.plan || this.plan.duration === 0) return;
    if (this.state === 'ended' || this.t >= this.plan.duration - 0.02) this.t = 0;
    this.base = this.t;
    this.startedAt = performance.now();
    this.opts.music?.start(this.musicId, this.t, this.plan.duration, this.plan.duck);
    this.setState('playing');
    this.stopLoop();
    this.syncVideos(true);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.stopLoop();
    this.opts.music?.stop();
    this.setState('paused');
    this.syncVideos(false);
  }

  toggle(): void {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  seek(t: number): void {
    if (!this.plan) return;
    this.t = Math.min(Math.max(0, t), this.plan.duration);
    this.base = this.t;
    this.startedAt = performance.now();
    this.syncVideos(this.state === 'playing');
    this.draw();
    this.opts.onTime?.(this.t, this.plan.duration);
    if (this.state === 'playing') this.opts.music?.start(this.musicId, this.t, this.plan.duration, this.plan.duck);
    else if (this.state === 'ended') this.setState('paused');
  }

  destroy(): void {
    this.stopLoop();
    this.opts.music?.stop();
    this.detach();
  }

  // -------------------------------------------------------------------------------- internals

  private onSeeked = (): void => {
    if (this.state !== 'playing') this.draw();
  };

  private detach(): void {
    for (const v of this.videos) {
      v.removeEventListener('seeked', this.onSeeked);
      if (!v.paused) v.pause();
    }
    this.videos = [];
  }

  private isActive(v: HTMLVideoElement): boolean {
    if (!this.plan || this.state !== 'playing') return false;
    return this.plan.scenes.some(
      (s) => s.kind === 'video' && (this.media[s.itemIndex] as { video?: HTMLVideoElement }).video === v && this.t >= s.start && this.t < s.end,
    );
  }

  /** Keep every clip element where the movie clock says it should be. */
  private syncVideos(playing: boolean): void {
    const plan = this.plan;
    if (!plan || !this.videos.length) return;
    const now = performance.now();
    plan.scenes.forEach((scene, i) => {
      if (scene.kind !== 'video' || !scene.clip) return;
      const m = this.media[scene.itemIndex];
      if (!m || m.kind !== 'video') return;
      const v = m.video;
      const clip = scene.clip;
      const inside = this.t >= scene.start && this.t < scene.end;
      const want = clip.start + (this.t - scene.start);
      if (inside) {
        if (playing) {
          const audible = clip.audio && !this.muted;
          if (v.muted === audible) v.muted = !audible;
          if (audible) {
            const vol = clipVolume(plan, i, this.t);
            if (Math.abs(v.volume - vol) > 0.02) {
              try {
                v.volume = vol;
              } catch {
                /* phones ignore volume; the clip simply plays at full level */
              }
            }
          }
          if (want >= v.duration - 0.05) {
            // The excerpt runs to the very end of the clip: hold its last frame. Calling play() on an
            // ended video would restart it from the beginning.
            if (!v.paused) v.pause();
          } else if (v.paused) {
            if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
            this.playVideo(v);
          } else if (Math.abs(v.currentTime - want) > DRIFT && now - (this.corrected.get(v) ?? 0) > 1500) {
            this.corrected.set(v, now);
            v.currentTime = want;
          }
        } else {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - want) > 0.03) v.currentTime = want;
        }
      } else {
        if (!v.paused) v.pause();
        const upcoming = this.t < scene.start && scene.start - this.t < PRELOAD;
        if (upcoming && Math.abs(v.currentTime - clip.start) > 0.05) v.currentTime = clip.start;
      }
    });
  }

  private playVideo(v: HTMLVideoElement): void {
    const p = v.play();
    if (!p) return;
    p.catch((e: unknown) => {
      if ((e as DOMException)?.name !== 'NotAllowedError') return; // a quick pause also rejects; that's fine
      // Sound was refused. Show the footage anyway, silently, and say so.
      v.muted = true;
      v.play().catch(() => {});
      this.opts.onClipSoundBlocked?.();
    });
  }

  private tick = (now: number): void => {
    if (!this.plan) return;
    this.t = this.base + (now - this.startedAt) / 1000;
    if (this.t >= this.plan.duration) {
      if (this.opts.loop) {
        this.t = 0;
        this.base = 0;
        this.startedAt = now;
      } else {
        this.t = this.plan.duration;
        this.draw();
        this.opts.onTime?.(this.t, this.plan.duration);
        this.opts.music?.stop();
        this.syncVideos(false);
        this.setState('ended');
        return;
      }
    }
    this.syncVideos(true);
    this.draw();
    this.opts.onTime?.(this.t, this.plan.duration);
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    if (this.plan) drawFrame(this.ctx, this.plan, this.media, this.t, this.opts.scale);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private setState(s: PlayerState): void {
    this.state = s;
    this.opts.onState?.(s);
  }
}
