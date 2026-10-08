// Renders the scene plan to an H.264 + AAC MP4 with FFmpeg. The plan comes from src/scene.ts, the
// same file the browser preview uses, so the film is cut the same way in both places.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { buildPlan, clipFades, FRAME, type MovieOptions, type PlanItem, type Scene, type ScenePlan, type Trim } from '../src/scene.ts';
import { probe, runFfmpeg, type ClipInfo } from './ffmpeg.ts';

export interface RenderItem {
  kind: 'photo' | 'video';
  /** Absolute path of the uploaded file. */
  file: string;
  trim: Trim | null;
}

export interface RenderRequest {
  dir: string;
  options: MovieOptions;
  items: RenderItem[];
  /** The title card picture drawn by the browser, if the movie has a title. */
  titleFile: string | null;
  /** Absolute path of the soundtrack for options.music, or null. */
  musicFile: string | null;
  out: string;
  onProgress: (fraction: number, stage: string) => void;
  signal?: AbortSignal;
}

const FPS = 30;
const MUSIC_LEVEL = 0.8; // same as src/music.ts
const MUSIC_FADE_IN = 1.8;
const MUSIC_FADE_OUT = 2.2;
const SAMPLE_RATE = 48000;
const BLACK = '0x0e0d0c';
const FIT = 0.94;

export class RenderError extends Error {}

const n = (v: number) => v.toFixed(4);

/** Zoom factor over a scene's own clock `t`, written as an ffmpeg expression. Mirrors photoScale(). */
function zoomExpr(plan: ScenePlan, zoom: Scene['zoom'], length: number): string {
  const eased = `(0.5-cos(PI*clip(t/${n(length)}\\,0\\,1))/2)`;
  if (zoom === 'in') return `(${plan.minScale}+${1 - plan.minScale}*${eased})`;
  if (zoom === 'out') return `(1-${1 - plan.minScale}*${eased})`;
  return '1';
}

/** Blurred, darkened copy of the picture that fills the margins. Mirrors drawMedia() in src/render.ts. */
const BACKDROP =
  'scale=48:27:force_original_aspect_ratio=increase,crop=48:27,scale=192:108:flags=bilinear,' +
  `scale=${FRAME.width}:${FRAME.height}:flags=bilinear,drawbox=x=0:y=0:w=iw:h=ih:color=0x171614@0.55:t=fill`;

const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,';

function segmentGraph(plan: ScenePlan, scene: Scene, hdr: boolean): string {
  const length = scene.end - scene.start;
  const fit = `min(${n(FRAME.width * FIT)}/iw\\,${n(FRAME.height * FIT)}/ih)`;
  if (scene.kind === 'title') {
    return `[0:v]scale=${FRAME.width}:${FRAME.height},setsar=1,format=yuv420p[v]`;
  }
  const head = scene.kind === 'video' ? `[0:v]${hdr ? TONEMAP : ''}fps=${FPS},setsar=1,format=gbrp,split=2[a][b]` : `[0:v]setsar=1,format=gbrp,split=2[a][b]`;
  const k = zoomExpr(plan, scene.zoom, length);
  const fg =
    scene.zoom === 'none'
      ? `[b]scale=w=round(${fit}*iw):h=round(${fit}*ih):flags=bicubic[fg]`
      : `[b]scale=w=round(${fit}*iw*${k}):h=round(${fit}*ih*${k}):eval=frame:flags=bicubic[fg]`;
  return `${head};[a]${BACKDROP}[bg];${fg};[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2:format=gbrp,format=yuv420p[v]`;
}

/** The music level over time as raw mono float samples, following plan.duck exactly. */
function writeDuckEnvelope(plan: ScenePlan, file: string): void {
  const total = Math.ceil((plan.duration + 1) * SAMPLE_RATE);
  const buf = Buffer.alloc(total * 4);
  let seg = 0;
  const pts = plan.duck;
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    while (seg < pts.length - 2 && t > pts[seg + 1].t) seg++;
    const a = pts[seg];
    const b = pts[Math.min(seg + 1, pts.length - 1)];
    const g = t <= a.t ? a.g : t >= b.t ? b.g : a.g + ((b.g - a.g) * (t - a.t)) / (b.t - a.t);
    buf.writeFloatLE(g, i * 4);
  }
  writeFileSync(file, buf);
}

export async function renderMovie(req: RenderRequest): Promise<{ plan: ScenePlan; seconds: number }> {
  const { dir, options, items, onProgress, signal } = req;
  if (!items.length) throw new RenderError('Nothing to render.');

  // 1. Look at every clip with ffprobe. These numbers, not the browser's, decide the cut.
  const infos = new Map<number, ClipInfo>();
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'video') continue;
    onProgress(0, `Reading clip ${i + 1}`);
    let info: ClipInfo;
    try {
      info = await probe(items[i].file);
    } catch {
      throw new RenderError(`Clip ${i + 1} couldn't be read.`);
    }
    if (!info.hasVideo || info.duration <= 0) throw new RenderError(`Clip ${i + 1} has no picture.`);
    infos.set(i, info);
  }

  const planItems: PlanItem[] = items.map((it, i) =>
    it.kind === 'video'
      ? { kind: 'video', duration: infos.get(i)!.duration, hasAudio: infos.get(i)!.hasAudio, trim: it.trim }
      : { kind: 'photo' },
  );
  const plan = buildPlan(planItems, options);
  const D = plan.duration;

  // 2. One silent H.264 segment per scene: picture, backdrop, zoom, orientation, HDR tone mapping.
  const segDir = join(dir, 'seg');
  mkdirSync(segDir, { recursive: true });
  const segFiles: string[] = plan.scenes.map((_, i) => join(segDir, `${i}.mp4`));
  const work = plan.scenes.reduce((s, sc) => s + (sc.end - sc.start), 0) + D; // seconds of output to write
  const written = new Map<number, number>(); // seconds written so far, per scene
  const finished = new Set<number>();
  const report = (stage: string) => {
    let sum = 0;
    for (const v of written.values()) sum += v;
    onProgress(Math.min(0.97, sum / work), stage);
  };
  const stop = new AbortController();
  signal?.addEventListener('abort', () => stop.abort(), { once: true });

  const renderScene = async (i: number): Promise<void> => {
    const scene = plan.scenes[i];
    const length = scene.end - scene.start;
    const src = scene.kind === 'title' ? req.titleFile : items[scene.itemIndex].file;
    if (!src) throw new RenderError('The title card is missing.');
    const input =
      scene.kind === 'video'
        ? ['-ss', n(scene.clip!.start), '-t', n(length), '-i', src]
        : ['-loop', '1', '-framerate', String(FPS), '-t', n(length), '-i', src];
    const hdr = scene.kind === 'video' && (infos.get(scene.itemIndex)?.hdr ?? false);
    const label = scene.kind === 'title' ? 'title' : scene.kind === 'video' ? `clip ${scene.itemIndex + 1}` : `photo ${scene.itemIndex + 1}`;
    const r = await runFfmpeg(
      [
        '-y', ...input,
        '-filter_complex', segmentGraph(plan, scene, hdr),
        '-map', '[v]', '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS),
        '-t', n(length),
        segFiles[i],
      ],
      (t) => {
        written.set(i, Math.min(t, length));
        report(`Preparing ${finished.size + 1} of ${plan.scenes.length}`);
      },
      stop.signal,
    );
    if (r.code !== 0) throw new RenderError(`Couldn't prepare ${label}.\n${r.tail}`);
    written.set(i, length);
    finished.add(i);
    report(`Preparing ${Math.min(finished.size + 1, plan.scenes.length)} of ${plan.scenes.length}`);
  };

  // Each scene is its own ffmpeg run; a couple at a time keeps every core busy without piling up memory.
  const lanes = Math.max(1, Math.min(3, availableParallelism()));
  let cursor = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(lanes, plan.scenes.length) }, async () => {
        while (cursor < plan.scenes.length && !stop.signal.aborted) await renderScene(cursor++);
      }),
    );
  } catch (e) {
    stop.abort();
    throw e;
  }
  if (signal?.aborted) throw new RenderError('Cancelled.');
  const done = plan.scenes.reduce((s, sc) => s + (sc.end - sc.start), 0);

  // 3. Assemble: crossfades by alpha, fades from and to black, and the audio mix.
  const args: string[] = ['-y'];
  for (const f of segFiles) args.push('-i', f);
  let next = segFiles.length;
  const audio: string[] = []; // labels of audio streams to mix
  const afilters: string[] = [];

  const musicOn = options.music !== 'none' && req.musicFile !== null;
  const clipAudio = plan.scenes
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.kind === 'video' && s.clip?.audio);

  if (musicOn) {
    const mi = next++;
    args.push('-stream_loop', '-1', '-i', req.musicFile!);
    afilters.push(
      `[${mi}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${n(D)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${MUSIC_FADE_IN},afade=t=out:st=${n(Math.max(0, D - MUSIC_FADE_OUT))}:d=${MUSIC_FADE_OUT},volume=${MUSIC_LEVEL}[m0]`,
    );
    if (clipAudio.length) {
      const envFile = join(dir, 'duck.f32');
      writeDuckEnvelope(plan, envFile);
      const ei = next++;
      args.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', envFile);
      afilters.push(`[${ei}:a]pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp[env]`, `[m0][env]amultiply[m1]`);
      audio.push('m1');
    } else audio.push('m0');
  }
  for (const { s, i } of clipAudio) {
    const ci = next++;
    const f = clipFades(plan, i);
    const len = s.end - s.start;
    const delay = Math.round(s.start * 1000);
    args.push('-ss', n(s.clip!.start), '-t', n(len), '-i', items[s.itemIndex].file);
    afilters.push(
      `[${ci}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${n(f.in)},afade=t=out:st=${n(Math.max(0, len - f.out))}:d=${n(f.out)},adelay=${delay}|${delay}[c${i}]`,
    );
    audio.push(`c${i}`);
  }
  if (!audio.length) {
    // A silent track keeps phones, chat apps and editors happy with a file that has no soundtrack.
    const si = next++;
    args.push('-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=stereo`);
    afilters.push(`[${si}:a]atrim=0:${n(D)},asetpts=PTS-STARTPTS[aout]`);
  } else {
    afilters.push(
      `${audio.map((l) => `[${l}]`).join('')}amix=inputs=${audio.length}:normalize=0:duration=longest,atrim=0:${n(D)},alimiter=limit=0.97,aresample=${SAMPLE_RATE}[aout]`,
    );
  }

  const vf: string[] = [`color=c=${BLACK}:s=${FRAME.width}x${FRAME.height}:r=${FPS}:d=${n(D)}[base]`];
  plan.scenes.forEach((s, i) => {
    const fade = i > 0 ? `fade=t=in:st=0:d=${n(plan.crossfade)}:alpha=1,` : '';
    vf.push(`[${i}:v]format=yuva420p,${fade}setpts=PTS-STARTPTS+${n(s.start)}/TB[s${i}]`);
  });
  let prev = 'base';
  plan.scenes.forEach((s, i) => {
    const out = i === plan.scenes.length - 1 ? 'last' : `o${i}`;
    vf.push(`[${prev}][s${i}]overlay=eof_action=pass:format=yuv420:enable=between(t\\,${n(s.start)}\\,${n(s.end + 0.05)})[${out}]`);
    prev = out;
  });
  vf.push(
    `[last]fade=t=in:st=0:d=${plan.fadeIn}:color=${BLACK},fade=t=out:st=${n(Math.max(0, D - plan.fadeOut))}:d=${plan.fadeOut}:color=${BLACK},format=yuv420p[vout]`,
  );

  args.push(
    '-filter_complex', [...vf, ...afilters].join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE),
    '-movflags', '+faststart',
    '-t', n(D),
    req.out,
  );
  const r = await runFfmpeg(args, (t) => onProgress(Math.min(0.99, (done + Math.min(t, D)) / work), 'Putting it together'), stop.signal);
  rmSync(segDir, { recursive: true, force: true });
  if (r.code !== 0) throw new RenderError(`Couldn't put the movie together.\n${r.tail}`);
  onProgress(1, 'Done');
  return { plan, seconds: D };
}
