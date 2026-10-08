import { blackAlpha, photoScale, sceneAlpha, type ScenePlan } from './scene.ts';

export interface Drawable {
  /** The picture, or for a clip a still frame used until the live video can be drawn. */
  source: CanvasImageSource;
  w: number;
  h: number;
  /** Small pre-blurred copy used to fill the margins. */
  backdrop: CanvasImageSource;
  /** Clips only: the element that is playing. Its current frame is drawn when it has one. */
  video?: HTMLVideoElement;
}

const CHARCOAL = '#171614';
const IVORY = '#F4EFE6';
const CHAMPAGNE = '#C8AC78';
/** Photos are fitted inside this fraction of the frame, so there is always a margin. */
const FIT = 0.94;

export const TITLE_FONT = "700 {size}px Manrope, Inter, system-ui, sans-serif";

/** Draw the movie at time `t`. `scale` shrinks the canvas for small previews. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  plan: ScenePlan,
  media: Drawable[],
  t: number,
  scale = 1,
): void {
  const { width: W, height: H } = plan;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0e0d0c';
  ctx.fillRect(0, 0, W, H);

  plan.scenes.forEach((scene, i) => {
    if (t < scene.start || t > scene.end) return;
    const alpha = sceneAlpha(plan, i, t);
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    if (scene.kind === 'title') {
      drawTitle(ctx, plan);
    } else {
      const item = media[scene.itemIndex];
      if (!item) return;
      const p = (t - scene.start) / (scene.end - scene.start);
      drawMedia(ctx, plan, item, photoScale(plan, scene.zoom, p));
    }
  });

  const black = blackAlpha(plan, t);
  if (black > 0) {
    ctx.globalAlpha = black;
    ctx.fillStyle = '#0e0d0c';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;
}

let tiny: HTMLCanvasElement | null = null;
let mid: HTMLCanvasElement | null = null;

/** Blurred backdrop from the current video frame: cover-crop to 48x27, then smooth up to 192x108. */
function liveBackdrop(video: HTMLVideoElement, w: number, h: number): HTMLCanvasElement {
  if (!tiny || !mid) {
    tiny = document.createElement('canvas');
    tiny.width = 48;
    tiny.height = 27;
    mid = document.createElement('canvas');
    mid.width = 192;
    mid.height = 108;
  }
  const g = tiny.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  const s = Math.max(48 / w, 27 / h);
  g.drawImage(video, (48 - w * s) / 2, (27 - h * s) / 2, w * s, h * s);
  const o = mid.getContext('2d')!;
  o.imageSmoothingQuality = 'high';
  o.drawImage(tiny, 0, 0, 192, 108);
  return mid;
}

function drawMedia(ctx: CanvasRenderingContext2D, plan: ScenePlan, item: Drawable, k: number): void {
  const { width: W, height: H } = plan;
  const v = item.video;
  const live = v && v.readyState >= 2 && v.videoWidth > 0 ? v : null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(live ? liveBackdrop(live, live.videoWidth, live.videoHeight) : item.backdrop, 0, 0, W, H);
  const prev = ctx.globalAlpha;
  ctx.fillStyle = 'rgba(23,22,20,0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = prev;

  const sw = live ? live.videoWidth : item.w;
  const sh = live ? live.videoHeight : item.h;
  const fit = Math.min((W * FIT) / sw, (H * FIT) / sh) * k;
  const dw = sw * fit;
  const dh = sh * fit;
  ctx.drawImage(live ?? item.source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/** The opening title card as its own picture, so the MP4 renderer can use exactly what the preview shows. */
export function renderTitleCard(plan: ScenePlan): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = plan.width;
  c.height = plan.height;
  drawTitle(c.getContext('2d')!, plan);
  return c;
}

function drawTitle(ctx: CanvasRenderingContext2D, plan: ScenePlan): void {
  const { width: W, height: H } = plan;
  ctx.fillStyle = CHARCOAL;
  ctx.fillRect(0, 0, W, H);
  const maxW = W * 0.76;
  let size = 88;
  let lines: string[] = [];
  for (; size >= 40; size -= 4) {
    ctx.font = TITLE_FONT.replace('{size}', String(size));
    lines = wrap(ctx, plan.title, maxW);
    if (lines.length <= 3 && lines.every((l) => ctx.measureText(l).width <= maxW)) break;
  }
  ctx.font = TITLE_FONT.replace('{size}', String(size));
  ctx.fillStyle = IVORY;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const lineH = size * 1.15;
  const blockH = lines.length * lineH;
  let y = (H - blockH) / 2 + size * 0.85 - 18;
  for (const line of lines) {
    ctx.fillText(line, W / 2, y);
    y += lineH;
  }
  ctx.fillStyle = CHAMPAGNE;
  ctx.fillRect(W / 2 - 28, y + 6, 56, 3);
  ctx.textAlign = 'start';
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  // A single very long word still has to fit: break it by characters.
  return lines.flatMap((l) => (ctx.measureText(l).width <= maxW ? [l] : breakWord(ctx, l, maxW)));
}

function breakWord(ctx: CanvasRenderingContext2D, word: string, maxW: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
