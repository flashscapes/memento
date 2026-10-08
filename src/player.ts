import { drawFrame, type Drawable } from './render.ts';
import { buildPlan, type MovieOptions, type ScenePlan } from './scene.ts';
import type { MusicEngine } from './music.ts';

export type PlayerState = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlayerOptions {
  /** Canvas pixels per frame pixel (1 = 1280x720). */
  scale: number;
  loop: boolean;
  music: MusicEngine | null;
  onState?: (s: PlayerState) => void;
  onTime?: (t: number, duration: number) => void;
}

/** Draws the scene plan on a canvas in real time. This is the browser preview, not a video file. */
export class Player {
  private ctx: CanvasRenderingContext2D;
  private plan: ScenePlan | null = null;
  private photos: Drawable[] = [];
  private raf = 0;
  private startedAt = 0;
  private base = 0;
  private t = 0;
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

  setMovie(photos: Drawable[], options: MovieOptions, poster = 0): void {
    this.stopLoop();
    this.opts.music?.stop();
    this.photos = photos;
    this.plan = buildPlan(photos.length, options);
    this.musicId = options.music;
    this.t = poster;
    this.base = poster;
    this.setState('idle');
    this.draw();
  }

  play(): void {
    if (!this.plan || this.plan.duration === 0) return;
    if (this.state === 'ended' || this.t >= this.plan.duration - 0.02) this.t = 0;
    this.base = this.t;
    this.startedAt = performance.now();
    this.opts.music?.start(this.musicId, this.t, this.plan.duration);
    this.setState('playing');
    this.stopLoop();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.stopLoop();
    this.opts.music?.stop();
    this.setState('paused');
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
    this.draw();
    this.opts.onTime?.(this.t, this.plan.duration);
    if (this.state === 'playing') this.opts.music?.start(this.musicId, this.t, this.plan.duration);
    else if (this.state === 'ended') this.setState('paused');
  }

  destroy(): void {
    this.stopLoop();
    this.opts.music?.stop();
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
        this.setState('ended');
        return;
      }
    }
    this.draw();
    this.opts.onTime?.(this.t, this.plan.duration);
    this.raf = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    if (this.plan) drawFrame(this.ctx, this.plan, this.photos, this.t, this.opts.scale);
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
