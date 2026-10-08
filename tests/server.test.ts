import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const PORT = 18700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | null = null;
const dir = mkdtempSync(join(tmpdir(), 'memento-srv-test-'));

function ff(args: string[], out: string): string {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, join(dir, out)]);
  assert.equal(r.status, 0, r.stderr.toString());
  return join(dir, out);
}

before(async () => {
  if (!hasFfmpeg) return;
  server = spawn('node', ['server/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server?.kill());

async function put(id: string, name: string, bytes: Uint8Array | Buffer): Promise<Response> {
  return fetch(`${base}/api/jobs/${id}/files/${name}`, { method: 'PUT', body: bytes as BodyInit });
}

test('refuses requests from another site', { skip: !hasFfmpeg }, async () => {
  const r = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(r.status, 403);
});

test('uploads a photo and a clip, renders, and serves an MP4 that matches the plan', { skip: !hasFfmpeg, timeout: 120_000 }, async () => {
  const photo = ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1', '-frames:v', '1'], 'p.jpg');
  const clip = ff(
    ['-f', 'lavfi', '-i', 'testsrc=size=480x270:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4',
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mov'],
    'c.mov',
  );
  const { id } = (await (await fetch(`${base}/api/jobs`, { method: 'POST' })).json()) as { id: string };
  assert.match(id, /^[0-9a-f]{32}$/);

  assert.equal((await put(id, '0.jpg', readFileSync(photo))).status, 200);
  assert.equal((await put(id, '1.bin', readFileSync(clip))).status, 200);
  assert.ok([400, 404].includes((await put(id, '..%2Fevil.jpg', Buffer.from('x'))).status)); // only known names are accepted
  assert.equal((await put(id, '5.exe', Buffer.from('x'))).status, 400);

  const body = {
    options: { title: '', music: 'none', pace: 'relaxed', clipSound: true, reducedMotion: false },
    items: [
      { kind: 'photo', file: '0.jpg', trim: null },
      { kind: 'video', file: '1.bin', trim: null },
    ],
  };
  // an item that was never uploaded is rejected before any work starts
  const missing = await fetch(`${base}/api/jobs/${id}/render`, { method: 'POST', body: JSON.stringify({ ...body, items: [...body.items, { kind: 'photo', file: '2.jpg', trim: null }] }) });
  assert.equal(missing.status, 400);

  assert.equal((await fetch(`${base}/api/jobs/${id}/render`, { method: 'POST', body: JSON.stringify(body) })).status, 202);
  let status: { state: string; progress: number; size?: number; error?: string } = { state: 'rendering', progress: 0 };
  let last = -1;
  for (let i = 0; i < 600 && status.state === 'rendering'; i++) {
    await new Promise((r) => setTimeout(r, 200));
    status = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as typeof status;
    assert.ok(status.progress >= last - 1e-9, 'progress never goes backwards');
    last = status.progress;
  }
  assert.equal(status.state, 'done', String(status.error));

  const mp4 = await fetch(`${base}/api/jobs/${id}/movie.mp4`);
  assert.equal(mp4.headers.get('content-type'), 'video/mp4');
  const file = join(dir, 'out.mp4');
  writeFileSync(file, Buffer.from(await mp4.arrayBuffer()));
  const probe = JSON.parse(
    spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' }).stdout || '{}',
  ) as { streams: { codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
  const v = probe.streams.find((s) => s.codec_name === 'h264')!;
  assert.equal(`${v.width}x${v.height}`, '1280x720');
  assert.ok(probe.streams.some((s) => s.codec_name === 'aac'));
  // 1 photo (4.55 s) + a 4 s clip crossfaded by 1.2 s = 7.35 s
  assert.ok(Math.abs(Number(probe.format.duration) - 7.35) < 0.1, `duration ${probe.format.duration}`);

  assert.equal((await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${id}`)).status, 404);
});
