// Render a movie from files on disk, without the web app. Used for testing the renderer.
//   node server/cli.ts out.mp4 [--music gentle|warm|none] [--pace relaxed|quicker] [--no-clip-sound]
//                      [--title-card card.png] [--trim N:start:length] file1 file2 ...
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMovie, type RenderItem } from './render.ts';
import type { MusicId, Pace, Trim } from '../src/scene.ts';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
const argv = process.argv.slice(2);
const out = resolve(argv.shift() ?? 'movie.mp4');
let music: MusicId = 'gentle';
let pace: Pace = 'relaxed';
let clipSound = true;
let titleFile: string | null = null;
let title = '';
const trims = new Map<number, Trim>();
const files: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--music') music = argv[++i] as MusicId;
  else if (a === '--pace') pace = argv[++i] as Pace;
  else if (a === '--no-clip-sound') clipSound = false;
  else if (a === '--title') title = argv[++i];
  else if (a === '--title-card') titleFile = resolve(argv[++i]);
  else if (a === '--trim') {
    const [idx, start, length] = argv[++i].split(':').map(Number);
    trims.set(idx, { start, length });
  } else files.push(resolve(a));
}
const items: RenderItem[] = files.map((file, i) => ({
  kind: /\.(jpe?g|png)$/i.test(file) ? 'photo' : 'video',
  file,
  trim: trims.get(i) ?? null,
}));
const dir = mkdtempSync(join(tmpdir(), 'memento-cli-'));
const started = Date.now();
let last = '';
try {
  const { plan } = await renderMovie({
    dir,
    options: { title, music, pace, reducedMotion: false, clipSound },
    items,
    titleFile,
    musicFile: music === 'none' ? null : join(root, 'public', 'audio', `${music}.mp3`),
    out,
    onProgress: (f, stage) => {
      if (stage !== last) console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s  ${Math.round(f * 100).toString().padStart(3)}%  ${stage}`);
      last = stage;
    },
  });
  console.log(`wrote ${out} (${plan.duration.toFixed(1)} s film, ${((Date.now() - started) / 1000).toFixed(1)} s to render)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
