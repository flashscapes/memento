import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openAsBlob, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeContainer } from '../src/media.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'memento-probe-'));

function make(name: string, args: string[]): string {
  const out = join(dir, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, out]);
  assert.equal(r.status, 0, r.stderr.toString());
  return out;
}
const video = ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=2'];
const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];

test('reads the codec and audio track of MOV and MP4 files', { skip: !hasFfmpeg }, async () => {
  const h264 = make('a.mov', [...video, ...audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mov']);
  assert.deepEqual(await probeContainer(await openAsBlob(h264)), { container: 'isobmff', codec: 'h264', hasAudio: true });

  const hevc = make('b.mov', [...video, ...audio, '-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest', '-f', 'mov']);
  assert.deepEqual(await probeContainer(await openAsBlob(hevc)), { container: 'isobmff', codec: 'hevc', hasAudio: true });

  const silent = make('c.mp4', [...video, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an']);
  assert.deepEqual(await probeContainer(await openAsBlob(silent)), { container: 'isobmff', codec: 'h264', hasAudio: false });
});

test('reads WebM and says no to files that are not video', { skip: !hasFfmpeg }, async () => {
  const webm = make('d.webm', [...video, ...audio, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest']);
  assert.deepEqual(await probeContainer(await openAsBlob(webm)), { container: 'matroska', codec: 'vp9', hasAudio: true });

  const junk = join(dir, 'junk.mov');
  writeFileSync(junk, Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 251)));
  assert.equal((await probeContainer(await openAsBlob(junk))).container, 'unknown');
  assert.equal((await probeContainer(new Blob([]))).container, 'unknown');
});
