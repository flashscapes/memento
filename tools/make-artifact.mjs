// Turns the Vite build into a single page plus audio files, for publishing as a
// claude.ai Artifact (which wraps the page in its own document skeleton).
// Usage: npm run build && npm run artifact   ->  artifact/index.html, artifact/audio
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';

const dist = 'dist';
const out = 'artifact';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const html = readFileSync(`${dist}/index.html`, 'utf8');
const cssFile = html.match(/href="\.\/assets\/([^"]+\.css)"/)?.[1];
const jsFile = html.match(/src="\.\/assets\/([^"]+\.js)"/)?.[1];
if (!cssFile || !jsFile) throw new Error('Run `npm run build` first.');

const css = readFileSync(`${dist}/assets/${cssFile}`, 'utf8');
const js = readFileSync(`${dist}/assets/${jsFile}`, 'utf8').replace(/<\/script/gi, '<\\/script');
const body = html
  .split('<body>')[1]
  .split('</body>')[0]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

writeFileSync(
  `${out}/index.html`,
  `<title>Memento</title>\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${js}\n</script>\n`,
);
cpSync(`${dist}/audio`, `${out}/audio`, { recursive: true });
cpSync(`${dist}/CREDITS.md`, `${out}/CREDITS.md`);
console.log('artifact/ ready');
