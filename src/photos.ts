import type { Drawable } from './render.ts';

export interface Photo extends Drawable {
  id: string;
  /** Neutral label such as "Photo 3". File names can be personal, so they are not shown. */
  origin: 'user' | 'sample';
  thumbUrl: string;
  ar: number;
}

export interface LoadFailure {
  name: string;
  reason: string;
}

/** Working copies are 1280 px on the long edge: enough for a 720p export. */
export const MAX_EDGE = 1280;
const THUMB_EDGE = 560;
export const MAX_FILE_MB = 40;

let counter = 0;

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

function makeBackdrop(work: HTMLCanvasElement): HTMLCanvasElement {
  // Cover-crop to 16:9 at tiny size, then upscale smoothly: a cheap, even blur.
  const tiny = document.createElement('canvas');
  tiny.width = 48;
  tiny.height = 27;
  const g = tiny.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  const s = Math.max(48 / work.width, 27 / work.height);
  const dw = work.width * s;
  const dh = work.height * s;
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
      id: `p${++counter}`,
      origin,
      source: work,
      w,
      h,
      backdrop: makeBackdrop(work),
      thumbUrl: await toBlobUrl(thumb),
      ar: w / h,
    };
  } finally {
    d.close();
  }
}

/** Decode files one at a time so a big selection never holds every original in memory. */
export async function loadFiles(
  files: File[],
  room: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ photos: Photo[]; failures: LoadFailure[]; skipped: number }> {
  const photos: Photo[] = [];
  const failures: LoadFailure[] = [];
  const take = files.slice(0, Math.max(0, room));
  const skipped = files.length - take.length;
  let done = 0;
  for (const file of take) {
    try {
      photos.push(await decodePhoto(file, file.name, 'user'));
    } catch (e) {
      failures.push({ name: file.name, reason: e instanceof Error ? e.message : describeFailure(file) });
    }
    onProgress?.(++done, take.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { photos, failures, skipped };
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

export function releasePhoto(p: Photo): void {
  if (p.origin === 'user' && p.thumbUrl.startsWith('blob:')) URL.revokeObjectURL(p.thumbUrl);
}
