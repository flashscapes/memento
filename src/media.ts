import type { Drawable } from './render.ts';
import { MAX_CLIPS, MIN_CLIP_SECONDS, defaultTrim, type PlanItem, type Trim } from './scene.ts';

export { MAX_CLIPS };

interface Base extends Drawable {
  id: string;
  origin: 'user' | 'sample';
  thumbUrl: string;
  ar: number;
}

export interface Photo extends Base {
  kind: 'photo';
}

export interface Clip extends Base {
  kind: 'video';
  /** The original file. It is read in place and never copied into memory. */
  file: File;
  url: string;
  /** The element that plays this clip during the movie. */
  video: HTMLVideoElement;
  /** Length of the whole clip, seconds. */
  duration: number;
  hasAudio: boolean;
  /** Best-effort codec name read from the file, for messages. */
  codec: string;
  /** The user's own trim. Null means Memento picks the excerpt. */
  trim: Trim | null;
}

export type Media = Photo | Clip;

export interface LoadFailure {
  name: string;
  reason: string;
}

/** Working copies are 1280 px on the long edge: enough for a 720p export. */
export const MAX_EDGE = 1280;
const THUMB_EDGE = 560;
export const MAX_FILE_MB = 40;
export const MAX_VIDEO_MB = 800;

let counter = 0;

// ------------------------------------------------------------------ what kind of file is this

const VIDEO_EXT = /\.(mov|mp4|m4v|webm|3gp|3g2|mkv|avi|mts|m2ts)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?)$/i;

export function fileKind(file: { name: string; type: string }): 'photo' | 'video' | 'other' {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'photo';
  if (VIDEO_EXT.test(file.name)) return 'video';
  if (IMAGE_EXT.test(file.name)) return 'photo';
  return 'other';
}

// ------------------------------------------------------------------ photos

type Decoded = { img: CanvasImageSource; w: number; h: number; close: () => void };

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('decode'));
    });
    return { img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Halve repeatedly so big phone photos stay sharp when they are shrunk. */
function downscale(src: CanvasImageSource, sw: number, sh: number, tw: number, th: number): HTMLCanvasElement {
  let cur: CanvasImageSource = src;
  let cw = sw;
  let ch = sh;
  while (cw / 2 >= tw && ch / 2 >= th) {
    const nw = Math.round(cw / 2);
    const nh = Math.round(ch / 2);
    const c = document.createElement('canvas');
    c.width = nw;
    c.height = nh;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = document.createElement('canvas');
  out.width = tw;
  out.height = th;
  const g = out.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, tw, th);
  return out;
}

function toBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve) => {
    if (!canvas.toBlob) return resolve(canvas.toDataURL('image/jpeg', 0.82));
    canvas.toBlob(
      (b) => resolve(b ? URL.createObjectURL(b) : canvas.toDataURL('image/jpeg', 0.82)),
      'image/jpeg',
      0.82,
    );
  });
}

/** A JPEG of a canvas, for the MP4 renderer. */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality);
  });
}

function makeBackdrop(work: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  // Cover-crop to 16:9 at tiny size, then upscale smoothly: a cheap, even blur.
  const tiny = document.createElement('canvas');
  tiny.width = 48;
  tiny.height = 27;
  const g = tiny.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  const s = Math.max(48 / w, 27 / h);
  const dw = w * s;
  const dh = h * s;
  g.drawImage(work, (48 - dw) / 2, (27 - dh) / 2, dw, dh);
  const out = document.createElement('canvas');
  out.width = 192;
  out.height = 108;
  const o = out.getContext('2d')!;
  o.imageSmoothingQuality = 'high';
  o.drawImage(tiny, 0, 0, 192, 108);
  return out;
}

export function describeFailure(file: { name: string; type: string }): string {
  const heic = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  if (heic) return "This browser can't open HEIC photos. Choose the JPEG version instead.";
  return "This file couldn't be opened as a photo.";
}

export async function decodePhoto(blob: Blob, name: string, origin: Photo['origin']): Promise<Photo> {
  if (blob.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`Larger than ${MAX_FILE_MB} MB.`);
  let d: Decoded;
  try {
    d = await decode(blob);
  } catch {
    throw new Error(describeFailure({ name, type: blob.type }));
  }
  try {
    if (!d.w || !d.h) throw new Error(describeFailure({ name, type: blob.type }));
    const k = Math.min(1, MAX_EDGE / Math.max(d.w, d.h));
    const w = Math.max(1, Math.round(d.w * k));
    const h = Math.max(1, Math.round(d.h * k));
    const work = downscale(d.img, d.w, d.h, w, h);
    const tk = THUMB_EDGE / Math.max(w, h);
    const thumb = tk < 1 ? downscale(work, w, h, Math.round(w * tk), Math.round(h * tk)) : work;
    return {
      kind: 'photo',
      id: `p${++counter}`,
      origin,
      source: work,
      w,
      h,
      backdrop: makeBackdrop(work, w, h),
      thumbUrl: await toBlobUrl(thumb),
      ar: w / h,
    };
  } finally {
    d.close();
  }
}

// ------------------------------------------------------------------ reading the container

export interface Probe {
  container: 'isobmff' | 'matroska' | 'unknown';
  /** Short name such as h264, hevc, vp9, av1. */
  codec: string | null;
  /** Null when the container could not say. */
  hasAudio: boolean | null;
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

const CODEC_NAMES: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc',
  vp09: 'vp9', av01: 'av1', mp4v: 'mpeg4', jpeg: 'mjpeg', apch: 'prores', apcn: 'prores', apcs: 'prores', ap4h: 'prores',
};

async function bytes(file: Blob, start: number, len: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, start + len).arrayBuffer());
}

/** Walks a MOV or MP4 header: which video codec, and is there an audio track. Reads a few KB. */
function parseMoov(b: Uint8Array): Probe {
  const probe: Probe = { container: 'isobmff', codec: null, hasAudio: false };
  const walk = (start: number, end: number, handler: { v: string }) => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = tag(b, o + 4);
      let hdr = 8;
      if (size === 1 && o + 16 <= end) {
        size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      const bs = o + hdr;
      const be = o + size;
      if (type === 'trak') walk(bs, be, { v: '' });
      else if (CONTAINERS.has(type)) walk(bs, be, handler);
      else if (type === 'hdlr' && be - bs >= 12) {
        // QuickTime files carry a second hdlr (the data handler) inside minf; the first one names the track.
        if (!handler.v) handler.v = tag(b, bs + 8);
        if (handler.v === 'soun') probe.hasAudio = true;
      } else if (type === 'stsd' && be - bs >= 16 && handler.v === 'vide' && !probe.codec) {
        const fourcc = tag(b, bs + 12);
        probe.codec = CODEC_NAMES[fourcc] ?? fourcc.trim();
      }
      o += size;
    }
  };
  walk(0, b.length, { v: '' });
  return probe;
}

export async function probeContainer(file: Blob): Promise<Probe> {
  const unknown: Probe = { container: 'unknown', codec: null, hasAudio: null };
  const head = await bytes(file, 0, 16);
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // Matroska / WebM: the track list sits near the start and names its codecs in plain text.
    const text = new TextDecoder('latin1').decode(await bytes(file, 0, 131072));
    const codec = /V_VP9/.test(text) ? 'vp9' : /V_VP8/.test(text) ? 'vp8' : /V_AV1/.test(text) ? 'av1'
      : /V_MPEG4\/ISO\/AVC/.test(text) ? 'h264' : /V_MPEGH\/ISO\/HEVC/.test(text) ? 'hevc' : null;
    return { container: 'matroska', codec, hasAudio: /A_(OPUS|VORBIS|AAC|MPEG|AC3|EAC3|FLAC)/.test(text) };
  }
  let pos = 0;
  for (let i = 0; i < 200 && pos + 8 <= file.size; i++) {
    const h = await bytes(file, pos, 16);
    let size = u32(h, 0);
    const type = tag(h, 4);
    let hdr = 8;
    if (i === 0 && type !== 'ftyp' && type !== 'moov' && type !== 'wide' && type !== 'free' && type !== 'mdat') return unknown;
    if (size === 1) {
      size = u32(h, 8) * 2 ** 32 + u32(h, 12);
      hdr = 16;
    } else if (size === 0) size = file.size - pos;
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > 96 * 1024 * 1024) break;
      return parseMoov(await bytes(file, pos + hdr, size - hdr));
    }
    pos += size;
  }
  return unknown;
}

// ------------------------------------------------------------------ videos

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC / H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', prores: 'ProRes', mjpeg: 'Motion JPEG',
};

function createVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.preload = 'auto';
  v.disablePictureInPicture = true;
  return v;
}

/** Plain-language reason a clip can't be played here. */
export function explainUnplayable(probe: Probe, mediaError: MediaError | null): string {
  if (probe.container === 'unknown') return "This file doesn't look like a video Memento can open.";
  if (mediaError && mediaError.code === 3) return 'This video looks damaged or incomplete.';
  if (probe.codec === 'hevc') {
    return "This browser can't play HEVC (H.265), the format iPhones record by default. Safari on iPhone and Mac can. Elsewhere, choose a clip recorded as Most Compatible.";
  }
  const label = probe.codec ? CODEC_LABEL[probe.codec] ?? probe.codec : null;
  return `This browser can't play this kind of video${label ? ` (${label})` : ''}. Try Safari or Chrome, or a different clip.`;
}

function waitFor(el: HTMLVideoElement, ok: string[], ms: number): Promise<'ok' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    const done = (r: 'ok' | 'error' | 'timeout') => {
      clearTimeout(timer);
      for (const e of ok) el.removeEventListener(e, onOk);
      el.removeEventListener('error', onErr);
      resolve(r);
    };
    const onOk = () => done('ok');
    const onErr = () => done('error');
    const timer = setTimeout(() => done('timeout'), ms);
    for (const e of ok) el.addEventListener(e, onOk, { once: true });
    el.addEventListener('error', onErr, { once: true });
  });
}

/** Show the frame at `time` and resolve once it can be drawn. */
export async function seekTo(video: HTMLVideoElement, time: number, ms = 5000): Promise<boolean> {
  const t = Math.max(0, Math.min(time, Math.max(0, (video.duration || time) - 0.05)));
  if (Math.abs(video.currentTime - t) < 0.01 && video.readyState >= 2 && !video.seeking) return true;
  const waiting = waitFor(video, ['seeked'], ms);
  video.currentTime = t;
  const r = await waiting;
  if (r === 'ok') return video.readyState >= 2 || (await waitFor(video, ['loadeddata', 'canplay'], 2000)) === 'ok';
  return false;
}

/** Some phones won't decode a paused video until it has played. A brief muted play gets the first frame. */
async function nudge(video: HTMLVideoElement): Promise<boolean> {
  try {
    video.muted = true;
    await video.play();
    await new Promise((r) => setTimeout(r, 120));
    video.pause();
    return video.readyState >= 2;
  } catch {
    return false;
  }
}

function drawn(video: HTMLVideoElement, w: number, h: number): HTMLCanvasElement {
  const k = Math.min(1, MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(video, 0, 0, c.width, c.height);
  return c;
}

/** Capture the frame at `time` as a canvas, or null if the browser won't give one. */
async function grabFrame(video: HTMLVideoElement, time: number): Promise<HTMLCanvasElement | null> {
  let ok = await seekTo(video, time);
  if (!ok && (await nudge(video))) ok = await seekTo(video, time);
  if (!ok) return null;
  return drawn(video, video.videoWidth, video.videoHeight);
}

function runtimeHasAudio(v: HTMLVideoElement): boolean | null {
  const el = v as HTMLVideoElement & { audioTracks?: { length: number }; mozHasAudio?: boolean };
  if (el.audioTracks && typeof el.audioTracks.length === 'number') return el.audioTracks.length > 0;
  if (typeof el.mozHasAudio === 'boolean') return el.mozHasAudio;
  return null;
}

export async function decodeClip(file: File, onStep?: (fraction: number) => void): Promise<Clip> {
  if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`Larger than ${MAX_VIDEO_MB} MB.`);
  const probe = await probeContainer(file).catch((): Probe => ({ container: 'unknown', codec: null, hasAudio: null }));
  onStep?.(0.15);
  const url = URL.createObjectURL(file);
  const video = createVideo();
  const fail = (msg: string): never => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    throw new Error(msg);
  };
  video.src = url;
  video.load();
  const r = await waitFor(video, ['loadedmetadata'], 15000);
  if (r === 'error') fail(explainUnplayable(probe, video.error));
  if (r === 'timeout') fail("This video took too long to open. It may be too large or in a format this browser can't read.");
  const { videoWidth: w, videoHeight: h, duration } = video;
  if (!w || !h) fail(explainUnplayable(probe, video.error));
  if (!Number.isFinite(duration) || duration <= 0) fail("This video's length couldn't be read.");
  if (duration < MIN_CLIP_SECONDS) fail(`Clips need to be at least ${MIN_CLIP_SECONDS} seconds long.`);
  onStep?.(0.4);

  const auto = defaultTrim(duration, 'relaxed');
  const poster = await grabFrame(video, auto.start + Math.min(0.3, auto.length / 2));
  if (!poster) fail("This browser opened the video but wouldn't show a frame from it.");
  onStep?.(0.85);

  const pw = poster!.width;
  const ph = poster!.height;
  const tk = THUMB_EDGE / Math.max(pw, ph);
  const thumb = tk < 1 ? downscale(poster!, pw, ph, Math.round(pw * tk), Math.round(ph * tk)) : poster!;
  const clip: Clip = {
    kind: 'video',
    id: `v${++counter}`,
    origin: 'user',
    source: poster!,
    video,
    w,
    h,
    backdrop: makeBackdrop(poster!, pw, ph),
    thumbUrl: await toBlobUrl(thumb),
    ar: w / h,
    file,
    url,
    duration,
    hasAudio: probe.hasAudio ?? runtimeHasAudio(video) ?? true,
    codec: probe.codec ?? 'unknown',
    trim: null,
  };
  return clip;
}

/** After the user trims, show the new first frame in the grid and in the movie's stand-in frame. */
export async function refreshClipFrame(clip: Clip, atTime: number): Promise<void> {
  const poster = await grabFrame(clip.video, atTime);
  if (!poster) return;
  const tk = THUMB_EDGE / Math.max(poster.width, poster.height);
  const thumb = tk < 1 ? downscale(poster, poster.width, poster.height, Math.round(poster.width * tk), Math.round(poster.height * tk)) : poster;
  const old = clip.thumbUrl;
  clip.source = poster;
  clip.backdrop = makeBackdrop(poster, poster.width, poster.height);
  clip.thumbUrl = await toBlobUrl(thumb);
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
}

// ------------------------------------------------------------------ loading a selection

export interface LoadProgress {
  /** 0..1 over the whole selection. */
  fraction: number;
  index: number;
  total: number;
  kind: 'photo' | 'video';
}

/** Open files one at a time so a big selection never holds every original in memory. */
export async function loadFiles(
  files: File[],
  limits: { room: number; clipRoom: number },
  onProgress?: (p: LoadProgress) => void,
): Promise<{ items: Media[]; failures: LoadFailure[]; skipped: number; skippedClips: number }> {
  const items: Media[] = [];
  const failures: LoadFailure[] = [];
  const take = files.slice(0, Math.max(0, limits.room));
  const skipped = files.length - take.length;
  let clipRoom = limits.clipRoom;
  let skippedClips = 0;
  for (let i = 0; i < take.length; i++) {
    const file = take[i];
    const kind = fileKind(file);
    const report = (inner: number) =>
      onProgress?.({ fraction: (i + inner) / take.length, index: i, total: take.length, kind: kind === 'video' ? 'video' : 'photo' });
    report(0);
    try {
      if (kind === 'video') {
        if (clipRoom <= 0) {
          skippedClips++;
        } else {
          items.push(await decodeClip(file, report));
          clipRoom--;
        }
      } else if (kind === 'photo') {
        items.push(await decodePhoto(file, file.name, 'user'));
      } else {
        throw new Error("This isn't a photo or video Memento can open.");
      }
    } catch (e) {
      failures.push({ name: file.name, reason: e instanceof Error ? e.message : describeFailure(file) });
    }
    report(1);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { items, failures, skipped, skippedClips };
}

export async function loadSamples(): Promise<Photo[]> {
  const names = ['01-pagoda', '02-dahlia', '03-espresso', '04-cat', '05-astronaut', '06-launch'];
  const out: Photo[] = [];
  for (const n of names) {
    const res = await fetch(`samples/${n}.jpg`);
    if (!res.ok) throw new Error(`Sample ${n} missing`);
    out.push(await decodePhoto(await res.blob(), `${n}.jpg`, 'sample'));
  }
  return out;
}

export function releaseMedia(m: Media): void {
  if (m.origin !== 'user') return;
  if (m.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(m.thumbUrl);
  if (m.kind === 'video') {
    m.video.pause();
    m.video.removeAttribute('src');
    m.video.load();
    URL.revokeObjectURL(m.url);
  }
}

export function toPlanItems(media: Media[]): PlanItem[] {
  return media.map((m): PlanItem =>
    m.kind === 'video' ? { kind: 'video', duration: m.duration, hasAudio: m.hasAudio, trim: m.trim } : { kind: 'photo' },
  );
}
