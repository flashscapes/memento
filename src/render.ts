import { blackAlpha, photoScale, sceneAlpha, type ScenePlan } from './scene.ts';

export interface Drawable {
  source: CanvasImageSource;
  w: number;
  h: number;
  /** Small pre-blurred copy used to fill the margins. */
  backdrop: CanvasImageSource;
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
  photos: Drawable[],
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
      const photo = photos[scene.photoIndex];
      if (!photo) return;
      const p = (t - scene.start) / (scene.end - scene.start);
      drawPhoto(ctx, plan, photo, photoScale(plan, scene.zoom, p));
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

function drawPhoto(ctx: CanvasRenderingContext2D, plan: ScenePlan, photo: Drawable, k: number): void {
  const { width: W, height: H } = plan;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.backdrop, 0, 0, W, H);
  const prev = ctx.globalAlpha;
  ctx.fillStyle = 'rgba(23,22,20,0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = prev;

  const fit = Math.min((W * FIT) / photo.w, (H * FIT) / photo.h) * k;
  const dw = photo.w * fit;
  const dh = photo.h * fit;
  ctx.drawImage(photo.source, (W - dw) / 2, (H - dh) / 2, dw, dh);
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
