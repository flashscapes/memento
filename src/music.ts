import { musicGain, type DuckPoint, type MusicId } from './scene.ts';

/** The soundtrack list, in the order Edit shows it. Every track is an original, synthesized piece (tools/make_music.py). */
export const TRACKS: Record<Exclude<MusicId, 'none'>, { label: string; mood: string; url: string }> = {
  gentle: { label: 'Gentle piano', mood: 'Soft and unhurried', url: 'audio/gentle.mp3' },
  warm: { label: 'Warm glow', mood: 'Slow pads and bells', url: 'audio/warm.mp3' },
  sunny: { label: 'Sunny morning', mood: 'Light and cheerful', url: 'audio/sunny.mp3' },
  musicbox: { label: 'Music box', mood: 'A tender lullaby', url: 'audio/musicbox.mp3' },
  waltz: { label: 'Slow waltz', mood: 'Nostalgic piano in three', url: 'audio/waltz.mp3' },
  calm: { label: 'Calm waters', mood: 'Quiet, no beat', url: 'audio/calm.mp3' },
};

const LEVEL = 0.8;
const FADE_IN = 1.8;
const FADE_OUT = 2.2;

type Ctx = AudioContext;

/**
 * Plays the soundtrack through Web Audio. Fades use a gain node because iOS Safari
 * ignores the volume property on media elements.
 */
export class MusicEngine {
  private ctx: Ctx | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private master: GainNode | null = null;
  private muted = false;

  /** Call synchronously inside a tap. Browsers only allow audio after a gesture. */
  unlock(): void {
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback'; // sound even with the iPhone ring switch off
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 1;
        this.master.connect(this.ctx.destination);
      }
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  /** Mutes the soundtrack without touching its schedule. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    const ctx = this.ctx;
    if (ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.04);
  }

  get available(): boolean {
    return this.ctx !== null;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Fetch and decode a track. Rejects if the file or the decoder fails. */
  async load(id: Exclude<MusicId, 'none'>): Promise<void> {
    if (this.buffers.has(id)) return;
    const ctx = this.ctx;
    if (!ctx) throw new Error('Audio is not available in this browser.');
    const res = await fetch(TRACKS[id].url);
    if (!res.ok) throw new Error('The music file could not be loaded.');
    const data = await res.arrayBuffer();
    const buf = await new Promise<AudioBuffer>((resolve, reject) => {
      ctx.decodeAudioData(data, resolve, reject); // callback form works on older Safari too
    });
    this.buffers.set(id, buf);
  }

  /**
   * Start `id` at `offset` seconds into a movie that is `duration` seconds long. `duck` lowers the music
   * under clips that have their own sound; the MP4 renderer follows the same curve.
   */
  start(id: MusicId, offset: number, duration: number, duck: DuckPoint[] = []): void {
    this.stop();
    const ctx = this.ctx;
    if (!ctx || id === 'none') return;
    const buf = this.buffers.get(id);
    if (!buf) return;
    const remaining = duration - offset;
    if (remaining <= 0.05) return;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const ducker = ctx.createGain();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(gain);
    gain.connect(ducker);
    ducker.connect(this.master ?? ctx.destination);

    ducker.gain.setValueAtTime(duck.length ? musicGain({ duck }, offset) : 1, now);
    for (const p of duck) if (p.t > offset) ducker.gain.linearRampToValueAtTime(p.g, now + (p.t - offset));

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(LEVEL, now + (offset < 0.1 ? FADE_IN : 0.25));
    if (remaining > FADE_OUT + 0.5) {
      gain.gain.setValueAtTime(LEVEL, now + remaining - FADE_OUT);
    }
    gain.gain.linearRampToValueAtTime(0, now + remaining);
    src.start(now, offset % buf.duration);
    src.stop(now + remaining + 0.1);
    this.source = src;
    this.gain = gain;
  }

  stop(): void {
    const ctx = this.ctx;
    if (!ctx || !this.source || !this.gain) return;
    const { source, gain } = this;
    this.source = null;
    this.gain = null;
    try {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.12);
      source.stop(now + 0.15);
    } catch {
      /* already stopped */
    }
  }
}
