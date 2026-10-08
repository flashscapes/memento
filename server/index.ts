// Memento's renderer: a small HTTP server that turns uploaded photos and clips into an MP4.
// It also serves the built app from dist/, so `npm run build && npm start` is the whole thing.
//
// Privacy: files live in the system temp folder for the length of one job and are deleted after the
// download (or after 30 minutes). Nothing is logged except start-up and error codes. The server
// listens on 127.0.0.1 unless HOST is set, and refuses requests whose Origin is another site.

import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { MAX_CLIPS, MAX_ITEMS, MAX_TITLE, MUSIC_IDS, type MovieOptions, type MusicId, type Pace, type Trim } from '../src/scene.ts';
import { renderMovie, RenderError, type RenderItem } from './render.ts';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const dist = join(root, 'dist');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

const MAX_FILE_BYTES = 1024 ** 3; // 1 GiB per file
const MAX_JOB_BYTES = 4 * 1024 ** 3;
const JOB_TTL_MS = 30 * 60_000;
const AFTER_DOWNLOAD_MS = 5 * 60_000;
const PREFIX = 'memento-job-';

interface Job {
  id: string;
  dir: string;
  touched: number;
  state: 'open' | 'rendering' | 'done' | 'error';
  progress: number;
  stage: string;
  error?: string;
  bytes: number;
  files: Set<string>;
  out?: string;
  size?: number;
  downloadedAt?: number;
  abort?: AbortController;
}

const jobs = new Map<string, Job>();
let rendering: string | null = null;

const ffmpegVersion = (() => {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? (/ffmpeg version (\S+)/.exec(r.stdout)?.[1] ?? 'unknown') : null;
})();

// ---------------------------------------------------------------- helpers

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function dropJob(job: Job): void {
  job.abort?.abort();
  jobs.delete(job.id);
  if (rendering === job.id) rendering = null;
  rmSync(job.dir, { recursive: true, force: true });
}

function sweep(): void {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    if (job.state === 'rendering') continue;
    const idle = now - job.touched > JOB_TTL_MS;
    const served = job.downloadedAt !== undefined && now - job.downloadedAt > AFTER_DOWNLOAD_MS;
    if (idle || served) dropJob(job);
  }
}

/** Remove folders left behind by a crashed earlier run. */
function clearLeftovers(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const p = join(tmpdir(), name);
    try {
      if (Date.now() - statSync(p).mtimeMs > 3600_000) rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

const FILE_NAME = /^(\d{1,2}\.(jpg|bin)|title\.png)$/;

function validate(body: any, job: Job): { options: MovieOptions; items: RenderItem[]; title: boolean } {
  const bad = (m: string): never => {
    throw new RenderError(m);
  };
  if (!body || typeof body !== 'object') bad('Missing request.');
  const o = body.options ?? {};
  const music = o.music as MusicId;
  const pace = o.pace as Pace;
  if (music !== 'none' && !(MUSIC_IDS as readonly string[]).includes(music)) bad('Unknown music.');
  if (!['relaxed', 'quicker'].includes(pace)) bad('Unknown pace.');
  const title = typeof o.title === 'string' ? o.title.trim().slice(0, MAX_TITLE) : '';
  const options: MovieOptions = { title, music, pace, reducedMotion: Boolean(o.reducedMotion), clipSound: o.clipSound === true };
  const list = body.items;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) bad(`Between 1 and ${MAX_ITEMS} items are needed.`);
  let clips = 0;
  const items: RenderItem[] = list.map((it: any, i: number) => {
    const kind = it?.kind;
    if (kind !== 'photo' && kind !== 'video') bad('Unknown item.');
    const want = kind === 'photo' ? `${i}.jpg` : `${i}.bin`;
    if (it.file !== want || !job.files.has(want)) bad(`Item ${i + 1} wasn't uploaded.`);
    if (kind === 'video') clips++;
    let trim: Trim | null = null;
    if (it.trim) {
      const { start, length } = it.trim;
      if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || length <= 0) bad('Bad trim.');
      trim = { start, length };
    }
    return { kind, file: join(job.dir, want), trim } as RenderItem;
  });
  if (clips > MAX_CLIPS) bad(`Up to ${MAX_CLIPS} clips.`);
  if (title && !job.files.has('title.png')) bad("The title card wasn't uploaded.");
  return { options, items, title: Boolean(title) };
}

async function startRender(job: Job, req: { options: MovieOptions; items: RenderItem[]; title: boolean }): Promise<void> {
  job.state = 'rendering';
  job.progress = 0;
  job.stage = 'Starting';
  job.abort = new AbortController();
  rendering = job.id;
  const out = join(job.dir, 'movie.mp4');
  try {
    await renderMovie({
      dir: job.dir,
      options: req.options,
      items: req.items,
      titleFile: req.title ? join(job.dir, 'title.png') : null,
      musicFile: req.options.music === 'none' ? null : join(root, 'public', 'audio', `${req.options.music}.mp3`),
      out,
      onProgress: (f, stage) => {
        job.progress = f;
        job.stage = stage;
        job.touched = Date.now();
      },
      signal: job.abort.signal,
    });
    job.out = out;
    job.size = statSync(out).size;
    job.state = 'done';
    job.progress = 1;
    job.stage = 'Done';
    // The uploaded originals are no longer needed.
    for (const f of readdirSync(job.dir)) if (f !== 'movie.mp4') rmSync(join(job.dir, f), { recursive: true, force: true });
  } catch (e) {
    if (job.abort?.signal.aborted) return;
    job.state = 'error';
    job.error = e instanceof RenderError ? e.message.split('\n')[0] : 'Something went wrong while making the MP4.';
    console.error(`render failed (${e instanceof RenderError ? 'input' : 'internal'}): ${e instanceof Error ? e.message.split('\n').slice(0, 6).join(' | ') : 'unknown'}`);
  } finally {
    if (rendering === job.id) rendering = null;
    job.touched = Date.now();
  }
}

// ---------------------------------------------------------------- static files

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.mp3': 'audio/mpeg', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return void res.end('Not found');
  }
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const headers: Record<string, string | number> = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return void res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return void createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- routes

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? '/').split('?')[0];
  if (!url.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
    return serveStatic(req, res);
  }

  // Only this app may talk to the API: a page on another site is turned away.
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host;
    } catch {
      /* malformed */
    }
    if (!ok) return send(res, 403, { error: 'origin' });
  }

  if (url === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: ffmpegVersion !== null, app: 'memento', ffmpeg: ffmpegVersion, maxItems: MAX_ITEMS, maxFileBytes: MAX_FILE_BYTES, busy: rendering !== null });
  }
  if (ffmpegVersion === null) return send(res, 503, { error: 'ffmpeg is not installed on this machine.' });

  if (url === '/api/jobs' && req.method === 'POST') {
    sweep();
    if (jobs.size >= 4) return send(res, 429, { error: 'The renderer is busy. Try again in a minute.' });
    const id = randomBytes(16).toString('hex');
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    jobs.set(id, { id, dir, touched: Date.now(), state: 'open', progress: 0, stage: 'Waiting for files', bytes: 0, files: new Set() });
    return send(res, 201, { id });
  }

  const m = /^\/api\/jobs\/([0-9a-f]{32})(?:\/(.*))?$/.exec(url);
  const job = m ? jobs.get(m[1]) : undefined;
  if (!m || !job) return send(res, 404, { error: 'No such job.' });
  const rest = m[2] ?? '';
  job.touched = Date.now();

  if (rest === '' && req.method === 'GET') {
    return send(res, 200, { state: job.state, progress: job.progress, stage: job.stage, error: job.error, size: job.size });
  }
  if (rest === '' && req.method === 'DELETE') {
    dropJob(job);
    return send(res, 200, { ok: true });
  }

  const file = /^files\/(.+)$/.exec(rest);
  if (file && req.method === 'PUT') {
    const name = file[1];
    if (job.state !== 'open' || !FILE_NAME.test(name)) return send(res, 400, { error: 'Bad file.' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_FILE_BYTES || job.bytes + declared > MAX_JOB_BYTES) return send(res, 413, { error: 'That file is too large.' });
    const target = join(job.dir, name);
    const part = `${target}.part`;
    const out = createWriteStream(part);
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (!failed && (size > MAX_FILE_BYTES || job.bytes + size > MAX_JOB_BYTES)) {
        failed = true;
        out.destroy();
        send(res, 413, { error: 'That file is too large.' });
        req.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      renameSync(part, target);
      job.bytes += size;
      job.files.add(name);
      send(res, 200, { ok: true, size });
    });
    const abandon = () => rmSync(part, { force: true });
    req.on('aborted', abandon);
    out.on('error', () => {
      abandon();
      if (!res.headersSent) send(res, 500, { error: 'Could not store the file.' });
    });
    return;
  }

  if (rest === 'render' && req.method === 'POST') {
    if (job.state !== 'open') return send(res, 409, { error: 'Already started.' });
    if (rendering) return send(res, 429, { error: 'Another movie is being made. Try again in a minute.' });
    let parsed;
    try {
      parsed = validate(await readJson(req), job);
    } catch (e) {
      return send(res, 400, { error: e instanceof RenderError ? e.message : 'Bad request.' });
    }
    void startRender(job, parsed);
    return send(res, 202, { ok: true });
  }

  if (rest === 'movie.mp4' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (job.state !== 'done' || !job.out) return send(res, 409, { error: 'Not ready.' });
    const size = job.size!;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    const headers = { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="Memento.mp4"', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return void res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      return void createReadStream(job.out, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (req.method === 'HEAD') return void res.end();
    job.downloadedAt = Date.now();
    return void createReadStream(job.out).pipe(res);
  }

  return send(res, 404, { error: 'No such route.' });
}

clearLeftovers();
mkdirSync(tmpdir(), { recursive: true });
const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    else res.destroy();
  });
});
server.requestTimeout = 0; // big uploads on slow phones take a while
server.headersTimeout = 30_000;
setInterval(sweep, 60_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`Memento is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (ffmpegVersion === null) console.log('ffmpeg was not found. Install it to make MP4 files.');
  else console.log(`MP4 renderer ready (ffmpeg ${ffmpegVersion}).${existsSync(dist) ? '' : ' Run "npm run build" to serve the app too.'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const j of [...jobs.values()]) dropJob(j);
    process.exit(0);
  });
}
