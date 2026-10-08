// Talks to the Memento renderer (server/) to turn the movie into a real MP4. The preview is drawn
// in the browser; the MP4 is made by FFmpeg from the same scene plan, so photos and clips are sent
// to the renderer. Progress shown here is real: bytes sent, then FFmpeg's own output time.

import { canvasToJpeg, type Media } from './media.ts';
import { renderTitleCard } from './render.ts';
import type { MovieOptions, ScenePlan } from './scene.ts';

export type Availability = { ok: true; busy: boolean } | { ok: false; reason: 'offline' | 'no-ffmpeg' };

export async function rendererAvailable(): Promise<Availability> {
  try {
    const res = await fetch('api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, reason: 'offline' };
    const j = (await res.json()) as { ok?: boolean; app?: string; busy?: boolean };
    if (j.app !== 'memento') return { ok: false, reason: 'offline' };
    return j.ok ? { ok: true, busy: Boolean(j.busy) } : { ok: false, reason: 'no-ffmpeg' };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

export interface ExportProgress {
  phase: 'sending' | 'rendering';
  text: string;
  /** 0..1 within the phase. */
  fraction: number;
}

export interface ExportResult {
  href: string;
  size: number;
  id: string;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1);

function put(id: string, name: string, body: Blob, onBytes: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `api/jobs/${id}/files/${name}`);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error(serverMessage(xhr.responseText) ?? 'The renderer refused a file.')));
    xhr.onerror = () => reject(new Error('The connection to the renderer was lost.'));
    xhr.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

function serverMessage(text: string): string | undefined {
  try {
    const m = (JSON.parse(text) as { error?: string }).error;
    return typeof m === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}

export async function exportMovie(args: {
  items: Media[];
  options: MovieOptions;
  plan: ScenePlan;
  onProgress: (p: ExportProgress) => void;
  signal: AbortSignal;
  onJob?: (id: string) => void;
}): Promise<ExportResult> {
  const { items, options, plan, onProgress, signal } = args;
  const json = { 'Content-Type': 'application/json' };

  const created = await fetch('api/jobs', { method: 'POST', signal });
  if (!created.ok) throw new Error(serverMessage(await created.text()) ?? 'The renderer is busy. Try again in a minute.');
  const { id } = (await created.json()) as { id: string };
  args.onJob?.(id);

  // Prepare every upload first so the total is exact. Photos go as the same 1280 px copies the preview uses.
  const uploads: { name: string; body: Blob; label: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (m.kind === 'video') uploads.push({ name: `${i}.bin`, body: m.file, label: `clip ${i + 1}` });
    else uploads.push({ name: `${i}.jpg`, body: await canvasToJpeg(m.source as HTMLCanvasElement), label: `photo ${i + 1}` });
  }
  if (plan.title) {
    const card = renderTitleCard(plan);
    const png = await new Promise<Blob>((res, rej) => card.toBlob((b) => (b ? res(b) : rej(new Error('title'))), 'image/png'));
    uploads.push({ name: 'title.png', body: png, label: 'title' });
  }
  const total = uploads.reduce((s, u) => s + u.body.size, 0);
  let sent = 0;
  for (let i = 0; i < uploads.length; i++) {
    const u = uploads[i];
    const report = (loaded: number) =>
      onProgress({
        phase: 'sending',
        text: `Sending ${u.label} · ${mb(sent + loaded)} of ${mb(total)} MB`,
        fraction: total ? (sent + loaded) / total : 1,
      });
    report(0);
    await put(id, u.name, u.body, report, signal);
    sent += u.body.size;
  }

  const body = {
    options: { title: options.title, music: options.music, pace: options.pace, clipSound: options.clipSound, reducedMotion: options.reducedMotion },
    items: items.map((m, i) => ({
      kind: m.kind,
      file: m.kind === 'video' ? `${i}.bin` : `${i}.jpg`,
      trim: m.kind === 'video' ? m.trim : null,
    })),
  };
  const started = await fetch(`api/jobs/${id}/render`, { method: 'POST', headers: json, body: JSON.stringify(body), signal });
  if (!started.ok) throw new Error(serverMessage(await started.text()) ?? 'The renderer could not start.');

  for (;;) {
    await new Promise((r) => setTimeout(r, 600));
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const res = await fetch(`api/jobs/${id}`, { cache: 'no-store', signal });
    if (!res.ok) throw new Error('The renderer stopped responding.');
    const s = (await res.json()) as { state: string; progress: number; stage: string; error?: string; size?: number };
    if (s.state === 'error') throw new Error(s.error ?? 'Something went wrong while making the MP4.');
    if (s.state === 'done') return { href: `api/jobs/${id}/movie.mp4`, size: s.size ?? 0, id };
    onProgress({ phase: 'rendering', text: s.stage, fraction: s.progress });
  }
}

export function discardJob(id: string): void {
  void fetch(`api/jobs/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}
