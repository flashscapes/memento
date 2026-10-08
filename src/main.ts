import {
  MAX_CLIPS,
  loadFiles,
  refreshClipFrame,
  releaseMedia,
  toPlanItems,
  type Clip,
  type Media,
  type Photo,
} from './media.ts';
import { discardJob, exportMovie, rendererAvailable } from './exporter.ts';
import { MusicEngine, TRACKS } from './music.ts';
import { Player, type PlayerState } from './player.ts';
import {
  MAX_CLIP_SECONDS,
  MAX_ITEMS,
  MAX_TITLE,
  MIN_CLIP_SECONDS,
  buildPlan,
  fitTrim,
  formatTime,
  resolveTrim,
  type MovieOptions,
  type MusicId,
  type Pace,
} from './scene.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

type Screen = 'home' | 'photos' | 'watch';
type Options = Omit<MovieOptions, 'reducedMotion'>;

const state = {
  screen: 'home' as Screen,
  items: [] as Media[],
  options: { title: '', music: 'gentle', pace: 'relaxed', clipSound: false } as Options,
  fresh: new Set<string>(),
  muted: false,
};

const music = new MusicEngine();

const ICON_PLAY = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 001.5.86l11-6.8a1 1 0 000-1.72l-11-6.8A1 1 0 008 5.2z"/></svg>';
const ICON_PAUSE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.4" height="14" rx="1.2"/><rect x="13.6" y="5" width="4.4" height="14" rx="1.2"/></svg>';
const ICON_X = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const ICON_SOUND = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 010 6M18 6.5a8 8 0 010 11"/></svg>';
const ICON_MUTED = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>';
const ICON_PLAY_SM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 001.5.86l11-6.8a1 1 0 000-1.72l-11-6.8A1 1 0 008 5.2z"/></svg>';
const ICON_PAUSE_SM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.4" height="14" rx="1.2"/><rect x="13.6" y="5" width="4.4" height="14" rx="1.2"/></svg>';
const ICON_UP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 15l7-7 7 7"/></svg>';
const ICON_DOWN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>';

// ---------------------------------------------------------------- helpers

function announce(msg: string): void {
  const el = $('sr-status');
  el.textContent = '';
  requestAnimationFrame(() => (el.textContent = msg));
}

function notice(id: 'home-notice' | 'photos-notice', lines: string[], kind: 'info' | 'error' = 'error', title?: string): void {
  const el = $(id);
  el.replaceChildren();
  if (!lines.length && !title) return void (el.hidden = true);
  el.className = `notice ${kind}`;
  const p = document.createElement('p');
  p.textContent = title ?? lines[0];
  el.append(p);
  const rest = title ? lines : lines.slice(1);
  if (rest.length) {
    const ul = document.createElement('ul');
    for (const l of rest) {
      const li = document.createElement('li');
      li.textContent = l;
      ul.append(li);
    }
    el.append(ul);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => (el.hidden = true));
  el.append(dismiss);
  el.hidden = false;
}

function setBusy(busy: boolean): void {
  for (const id of ['choose', 'add', 'arrange', 'make']) {
    const b = $<HTMLButtonElement>(id);
    if (busy) b.setAttribute('aria-busy', 'true');
    else b.removeAttribute('aria-busy');
  }
}

/** Real progress while files are opened: the bar only moves when a file (or a step of a clip) is done. */
function setLoading(where: 'home' | 'photos', text: string | null, fraction = 0): void {
  for (const w of ['home', 'photos'] as const) {
    const el = $(`${w}-loading`);
    el.hidden = !(text && w === where);
    if (text && w === where) {
      el.querySelector('p')!.textContent = text;
      el.querySelector('progress')!.value = fraction;
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function counts(items: Media[]): { photos: number; clips: number } {
  const clips = items.filter((m) => m.kind === 'video').length;
  return { photos: items.length - clips, clips };
}

/** "5 photos", "2 clips", "5 photos and 2 clips". */
function describe(items: Media[], joiner = ' and '): string {
  const { photos, clips } = counts(items);
  const parts = [];
  if (photos) parts.push(plural(photos, 'photo'));
  if (clips) parts.push(plural(clips, 'clip'));
  return parts.join(joiner);
}

const movieOptions = (): MovieOptions => ({ ...state.options, reducedMotion: reduced.matches });
const hasClips = () => state.items.some((m) => m.kind === 'video');
const usedLength = (c: Clip) => resolveTrim(c.duration, c.trim, state.options.pace).length;

// ---------------------------------------------------------------- screens

function show(screen: Screen): void {
  if (state.screen === 'watch' && screen !== 'watch') {
    film.pause();
    if (theater) void leaveFullscreen();
  }
  state.screen = screen;
  for (const s of ['home', 'photos', 'watch'] as Screen[]) {
    const el = $(`screen-${s}`);
    const on = s === screen;
    if (on && el.hidden) {
      el.hidden = false;
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    } else el.hidden = !on;
  }
  window.scrollTo(0, 0);
  if (screen === 'home') {
    const cont = $<HTMLButtonElement>('continue');
    const mine = state.items.filter((m) => m.origin === 'user');
    cont.hidden = mine.length === 0;
    cont.textContent = `Continue with your ${describe(mine)}`;
  }
  if (screen === 'photos') $('photos-title').focus({ preventScroll: true });
}

// ---------------------------------------------------------------- photos and clips

function renderGrid(): void {
  const grid = $('grid');
  const n = state.items.length;
  const length = n ? ` · about ${formatTime(buildPlan(toPlanItems(state.items), movieOptions()).duration)}` : '';
  $('count').textContent = n ? `${describe(state.items, ' · ')}${length}` : 'Nothing yet';
  $<HTMLButtonElement>('make').disabled = n === 0;
  $<HTMLButtonElement>('arrange').disabled = n < 2;
  $<HTMLButtonElement>('add').disabled = n >= MAX_ITEMS;
  grid.style.setProperty('--scale', String(n === 1 ? 2.6 : n <= 4 ? 1.3 : 1));
  grid.replaceChildren();
  if (!n) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No photos or videos yet. Add a few to begin.';
    grid.append(p);
    return;
  }
  state.items.forEach((m, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--ar', m.ar.toFixed(4));
    if (m.kind === 'video') li.classList.add('clip');
    if (state.fresh.has(m.id)) {
      li.classList.add('fresh');
      li.style.setProperty('--i', String(Math.min(i, 12)));
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'open';
    open.dataset.id = m.id;
    const img = document.createElement('img');
    img.src = m.thumbUrl;
    img.alt = '';
    img.decoding = 'async';
    open.append(img);
    if (m.kind === 'video') {
      const secs = usedLength(m);
      open.setAttribute('aria-label', `Preview clip ${i + 1} of ${n}, ${Math.round(secs)} seconds used`);
      const play = document.createElement('span');
      play.className = 'play';
      play.innerHTML = ICON_PLAY_SM;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = formatTime(secs);
      open.append(play, badge);
    } else {
      open.setAttribute('aria-label', `Preview photo ${i + 1} of ${n}`);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.dataset.id = m.id;
    rm.setAttribute('aria-label', `Remove ${m.kind === 'video' ? 'clip' : 'photo'} ${i + 1}`);
    rm.innerHTML = `<span>${ICON_X}</span>`;
    li.append(open, rm);
    grid.append(li);
  });
  state.fresh.clear();
}

function removeItem(id: string): number {
  const i = state.items.findIndex((m) => m.id === id);
  if (i < 0) return -1;
  const [gone] = state.items.splice(i, 1);
  releaseMedia(gone);
  return i;
}

let loading = false;

async function handleFiles(files: File[]): Promise<void> {
  if (!files.length || loading) return;
  const here = state.screen;
  const target = here === 'home' ? 'home-notice' : 'photos-notice';
  const where = here === 'home' ? 'home' : 'photos';
  const room = MAX_ITEMS - state.items.length;
  if (room <= 0) {
    notice(target, [`Memento uses up to ${MAX_ITEMS} photos and clips. Remove one to add another.`]);
    return;
  }
  const clipRoom = MAX_CLIPS - counts(state.items).clips;
  const choose = $<HTMLButtonElement>('choose');
  loading = true;
  setBusy(true);
  notice(target, []);
  setLoading(where, 'Opening your files…', 0);
  choose.textContent = 'Opening…';
  try {
    const { items, failures, skipped, skippedClips } = await loadFiles(files, { room, clipRoom }, (p) => {
      const what = p.kind === 'video' ? 'clip' : 'photo';
      setLoading(where, `Opening ${what} ${p.index + 1} of ${p.total}${p.kind === 'video' ? ' · clips take a moment' : ''}`, p.fraction);
    });
    state.items.push(...items);
    items.forEach((m) => state.fresh.add(m.id));
    // Files that fail for the same reason are listed together, so a roll of HEVC clips is one line.
    const byReason = new Map<string, string[]>();
    for (const f of failures) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.name]);
    const problems = [...byReason].map(([reason, names]) => `${names.join(', ')}: ${reason}`);
    if (skipped > 0) problems.push(`Memento uses up to ${MAX_ITEMS} photos and clips, so ${skipped} weren’t added.`);
    if (skippedClips > 0) problems.push(`Memento uses up to ${MAX_CLIPS} clips to keep playback smooth, so ${skippedClips} weren’t added.`);
    if (state.items.length) {
      renderGrid();
      if (here !== 'photos') show('photos');
      notice('photos-notice', problems, 'error', problems.length ? 'Some files weren’t added. The rest are ready.' : undefined);
      announce(`${describe(items)} added`);
    } else {
      notice(target, problems, 'error', 'None of those could be opened.');
    }
  } catch {
    notice(target, ['Something went wrong opening those files. Nothing was lost; try again.']);
  } finally {
    setLoading(where, null);
    loading = false;
    setBusy(false);
    choose.textContent = 'Choose photos & videos';
  }
}

function openArrange(): void {
  const dlg = $<HTMLDialogElement>('arrange-dialog');
  renderArrange();
  dlg.showModal();
}

function renderArrange(focus?: string): void {
  const list = $('arrange-list');
  list.replaceChildren();
  const n = state.items.length;
  state.items.forEach((m, i) => {
    const what = m.kind === 'video' ? 'clip' : 'photo';
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = m.thumbUrl;
    img.alt = '';
    const lab = document.createElement('span');
    lab.className = 'lab';
    lab.textContent = `${what === 'clip' ? 'Clip' : 'Photo'} ${i + 1}`;
    if (m.kind === 'video') {
      const small = document.createElement('small');
      small.textContent = `${formatTime(usedLength(m))} used`;
      lab.append(small);
    }
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'iconbtn';
    up.dataset.id = m.id;
    up.dataset.dir = '-1';
    up.disabled = i === 0;
    up.setAttribute('aria-label', `Move ${what} ${i + 1} earlier`);
    up.innerHTML = ICON_UP;
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'iconbtn';
    down.dataset.id = m.id;
    down.dataset.dir = '1';
    down.disabled = i === n - 1;
    down.setAttribute('aria-label', `Move ${what} ${i + 1} later`);
    down.innerHTML = ICON_DOWN;
    li.append(img, lab, up, down);
    list.append(li);
  });
  if (focus) {
    const [id, dir] = focus.split(':');
    const target = list.querySelector<HTMLButtonElement>(`button[data-id="${id}"][data-dir="${dir}"]:not([disabled])`)
      ?? list.querySelector<HTMLButtonElement>(`button[data-id="${id}"]:not([disabled])`);
    target?.focus();
  }
}

// ---------------------------------------------------------------- one item: preview, trim, remove

const peek = {
  item: null as Media | null,
  video: null as HTMLVideoElement | null,
  trimmed: false,
};

function fmtSeconds(s: number): string {
  return Number.isInteger(s) ? `${s} s` : `${s.toFixed(1)} s`;
}

function syncTrimUi(clip: Clip): void {
  const t = resolveTrim(clip.duration, clip.trim, state.options.pace);
  const start = $<HTMLInputElement>('trim-start');
  const length = $<HTMLInputElement>('trim-length');
  length.min = String(Math.min(MIN_CLIP_SECONDS, clip.duration));
  length.max = String(Math.min(MAX_CLIP_SECONDS, clip.duration));
  length.value = String(t.length);
  start.max = String(Math.max(0, clip.duration - t.length));
  start.value = String(t.start);
  start.disabled = clip.duration - t.length < 0.1;
  length.disabled = Number(length.max) - Number(length.min) < 0.1;
  for (const r of [start, length]) {
    const span = Number(r.max) - Number(r.min);
    r.style.setProperty('--p', `${span > 0 ? ((Number(r.value) - Number(r.min)) / span) * 100 : 0}%`);
  }
  $('trim-start-out').textContent = formatTime(t.start);
  $('trim-length-out').textContent = fmtSeconds(Math.round(t.length * 10) / 10);
  $('excerpt-text').textContent = `Using ${fmtSeconds(Math.round(t.length * 10) / 10)} of this ${formatTime(clip.duration)} clip`;
  const bar = $('excerpt-bar');
  bar.style.left = `${(t.start / clip.duration) * 100}%`;
  bar.style.width = `${Math.max(1.5, (t.length / clip.duration) * 100)}%`;
  $('trim-auto').hidden = clip.trim === null;
  const pv = peek.video;
  if (pv) pv.dataset.start = String(t.start), (pv.dataset.end = String(t.start + t.length));
}

function openItem(id: string): void {
  const i = state.items.findIndex((m) => m.id === id);
  const m = state.items[i];
  if (!m) return;
  peek.item = m;
  peek.trimmed = false;
  const dlg = $<HTMLDialogElement>('item-dialog');
  $('item-title').textContent = `${m.kind === 'video' ? 'Clip' : 'Photo'} ${i + 1} of ${state.items.length}`;
  $('item-remove').setAttribute('aria-label', `Remove this ${m.kind === 'video' ? 'clip' : 'photo'}`);
  const stage = $('peek');
  stage.replaceChildren();
  stage.style.aspectRatio = m.ar.toFixed(4);
  const tools = $('clip-tools');
  tools.hidden = m.kind !== 'video';
  if (m.kind === 'photo') {
    const img = document.createElement('img');
    img.src = m.thumbUrl;
    img.alt = `Photo ${i + 1}`;
    stage.append(img);
    peek.video = null;
  } else {
    const pv = document.createElement('video');
    pv.src = m.url;
    pv.playsInline = true;
    pv.setAttribute('playsinline', '');
    pv.preload = 'auto';
    pv.muted = !m.hasAudio;
    pv.setAttribute('aria-label', `Clip ${i + 1}`);
    const fab = document.createElement('span');
    fab.className = 'fab';
    fab.innerHTML = ICON_PLAY;
    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'peek-hit';
    hit.setAttribute('aria-label', 'Play or pause this clip');
    const sync = () => fab.classList.toggle('off', !pv.paused);
    pv.addEventListener('play', sync);
    pv.addEventListener('pause', sync);
    pv.addEventListener('timeupdate', () => {
      const end = Number(pv.dataset.end ?? Infinity);
      if (!pv.paused && pv.currentTime >= end - 0.05) pv.currentTime = Number(pv.dataset.start ?? 0);
    });
    hit.addEventListener('click', () => {
      const start = Number(pv.dataset.start ?? 0);
      const end = Number(pv.dataset.end ?? Infinity);
      if (pv.paused) {
        if (pv.currentTime < start - 0.1 || pv.currentTime >= end - 0.1) pv.currentTime = start;
        void pv.play().catch(() => {});
      } else pv.pause();
    });
    stage.append(pv, fab, hit);
    peek.video = pv;
    const t = resolveTrim(m.duration, m.trim, state.options.pace);
    pv.addEventListener('loadeddata', () => (pv.currentTime = t.start), { once: true });
    $('clip-audio-note').textContent = !m.hasAudio
      ? 'This clip has no sound.'
      : state.options.clipSound
        ? 'Its own sound is kept, and the music lowers underneath.'
        : 'It plays silently over the music. You can turn its own sound on in Edit.';
    syncTrimUi(m);
  }
  dlg.showModal();
}

function onTrimInput(which: 'start' | 'length'): void {
  const m = peek.item;
  if (!m || m.kind !== 'video') return;
  const cur = resolveTrim(m.duration, m.trim, state.options.pace);
  const v = Number($<HTMLInputElement>(which === 'start' ? 'trim-start' : 'trim-length').value);
  m.trim = fitTrim(which === 'start' ? { start: v, length: cur.length } : { start: cur.start, length: v }, m.duration);
  peek.trimmed = true;
  syncTrimUi(m);
  const pv = peek.video;
  if (pv) {
    pv.pause();
    pv.currentTime = which === 'start' ? m.trim.start : Math.max(m.trim.start, m.trim.start + m.trim.length - 0.2);
  }
}

async function closeItem(): Promise<void> {
  const m = peek.item;
  peek.video?.pause();
  peek.video?.removeAttribute('src');
  peek.video?.load();
  peek.video = null;
  peek.item = null;
  if (m && m.kind === 'video' && peek.trimmed && state.items.includes(m)) {
    const t = resolveTrim(m.duration, m.trim, state.options.pace);
    await refreshClipFrame(m, t.start + Math.min(0.3, t.length / 2));
  }
  peek.trimmed = false;
  renderGrid();
}

// ---------------------------------------------------------------- watch

const filmCanvas = $<HTMLCanvasElement>('film-canvas');
let scrubbing = false;
let wasPlaying = false;

const film = new Player(filmCanvas, {
  scale: 1,
  loop: false,
  music,
  onState: (s) => syncWatchUi(s),
  onTime: (t, d) => {
    $('time').textContent = `${formatTime(t)} / ${formatTime(d)}`;
    if (!scrubbing) {
      const seek = $<HTMLInputElement>('seek');
      const v = d ? (t / d) * 1000 : 0;
      seek.value = String(v);
      seek.style.setProperty('--p', `${v / 10}%`);
    }
  },
  onClipSoundBlocked: () => {
    const note = $('sound-note');
    note.textContent = 'This browser kept clip sound off. Tap the picture to pause, then play again.';
    note.hidden = false;
    announce('Clip sound was blocked by the browser.');
  },
});

function syncWatchUi(s: PlayerState): void {
  const playing = s === 'playing';
  const pp = $('pp');
  pp.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  pp.setAttribute('aria-label', playing ? 'Pause' : s === 'ended' ? 'Replay' : 'Play');
  const st = $('film-state');
  st.classList.toggle('playing', playing);
  $('film-fab').innerHTML = ICON_PLAY;
  $('actions').classList.toggle('away', playing);
  if (s === 'ended') announce('The movie has finished.');
  if (theater) showControls();
}

function syncMuteUi(): void {
  const b = $('mute');
  b.innerHTML = state.muted ? ICON_MUTED : ICON_SOUND;
  b.setAttribute('aria-label', state.muted ? 'Turn sound on' : 'Mute');
  b.setAttribute('aria-pressed', String(state.muted));
}

async function startMovie(autoplay: boolean): Promise<void> {
  const opts = movieOptions();
  film.setMovie(state.items, opts);
  film.setMuted(state.muted);
  if (autoplay) film.prime(); // still inside the tap: lets phones play clip sound later
  $('movie-title').textContent = film.planInfo?.title ?? '';
  $('movie-title').hidden = !film.planInfo?.title;
  $('time').textContent = `0:00 / ${formatTime(film.duration)}`;
  $<HTMLInputElement>('seek').value = '0';
  $('seek').style.setProperty('--p', '0%');
  $('sound-note').hidden = true;
  const anySound = opts.music !== 'none' || Boolean(film.planInfo?.scenes.some((s) => s.clip?.audio));
  $('mute').hidden = !anySound;
  syncMuteUi();
  $('film-fab').hidden = true;
  $('film-msg').hidden = false;
  $('actions').classList.add('away');
  try {
    await Promise.all([
      opts.music !== 'none'
        ? music.load(opts.music).catch((e: Error) => {
            film.musicId = 'none';
            notice('photos-notice', [`${e.message} The movie will play without music.`], 'info');
            announce('Music could not be loaded. Playing without it.');
          })
        : Promise.resolve(),
      opts.title ? document.fonts.load('700 48px Manrope').catch(() => []) : Promise.resolve([]),
    ]);
  } finally {
    $('film-msg').hidden = true;
    $('film-fab').hidden = false;
  }
  film.seek(0); // redraw the first frame now that fonts are ready
  syncWatchUi('idle');
  if (autoplay) {
    film.play();
    if (film.musicId !== 'none' && (!music.available || !music.running)) {
      // The browser refused sound. Wait for a tap instead of playing silently.
      window.setTimeout(() => {
        if (film.state === 'playing' && !music.running) {
          film.pause();
          announce('Tap play to start the sound.');
        }
      }, 400);
    }
  }
}

async function make(): Promise<void> {
  if (!state.items.length || loading) return;
  music.unlock(); // inside the tap, so the browser allows sound
  show('watch');
  try {
    await startMovie(true);
  } catch {
    show('photos');
    notice('photos-notice', ['Something went wrong making the movie. Your photos and clips are still here.']);
  }
}

// A few seconds of a track so you can choose by ear. Stops on its own, on the next tap, or when Edit closes.
let previewId: MusicId | null = null;
let previewTimer = 0;
const PREVIEW_AT = 12;
const PREVIEW_SECONDS = 7;

function stopPreview(): void {
  window.clearTimeout(previewTimer);
  if (previewId) music.stop();
  previewId = null;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.hear')) {
    b.innerHTML = ICON_PLAY_SM;
    b.setAttribute('aria-label', `Hear ${b.dataset.label}`);
  }
}

async function togglePreview(id: Exclude<MusicId, 'none'>, button: HTMLButtonElement): Promise<void> {
  if (previewId === id) return stopPreview();
  stopPreview();
  music.unlock(); // inside the tap
  music.setMuted(false); // a muted movie should still let you hear a choice
  previewId = id;
  button.innerHTML = ICON_PAUSE_SM;
  button.setAttribute('aria-label', `Stop ${TRACKS[id].label}`);
  try {
    await music.load(id);
    if (previewId !== id) return; // switched or closed while loading
    music.start(id, PREVIEW_AT, PREVIEW_AT + PREVIEW_SECONDS);
    previewTimer = window.setTimeout(stopPreview, PREVIEW_SECONDS * 1000 + 200);
  } catch {
    stopPreview();
    announce('That track could not be played.');
  }
}

function buildMusicList(): void {
  const list = $('music-list');
  const row = (id: MusicId, label: string, mood: string) => {
    const wrap = document.createElement('div');
    wrap.className = 'track';
    const lab = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'music';
    input.value = id;
    const text = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = label;
    const sub = document.createElement('small');
    sub.textContent = mood;
    text.append(name, sub);
    lab.append(input, text);
    wrap.append(lab);
    if (id !== 'none') {
      const hear = document.createElement('button');
      hear.type = 'button';
      hear.className = 'iconbtn hear';
      hear.dataset.label = label;
      hear.innerHTML = ICON_PLAY_SM;
      hear.setAttribute('aria-label', `Hear ${label}`);
      hear.addEventListener('click', () => void togglePreview(id, hear));
      wrap.append(hear);
    }
    list.append(wrap);
  };
  for (const [id, t] of Object.entries(TRACKS)) row(id as MusicId, t.label, t.mood);
  row('none', 'No music', 'Just the photos and clips');
}

/** The music menu on the home screen. It and Edit's list always agree because both read state.options.music. */
function buildHomeMusic(): void {
  const sel = $<HTMLSelectElement>('home-music');
  const hear = $<HTMLButtonElement>('home-hear');
  for (const [id, t] of Object.entries(TRACKS)) sel.add(new Option(t.label, id));
  sel.add(new Option('No music', 'none'));
  const sync = () => {
    sel.value = state.options.music;
    const none = state.options.music === 'none';
    hear.hidden = none;
    hear.dataset.label = none ? '' : TRACKS[state.options.music as Exclude<MusicId, 'none'>].label;
    hear.innerHTML = ICON_PLAY_SM;
    hear.setAttribute('aria-label', `Hear ${hear.dataset.label}`);
  };
  sel.addEventListener('change', () => {
    stopPreview();
    state.options = { ...state.options, music: sel.value as MusicId };
    sync();
  });
  hear.addEventListener('click', () => {
    if (state.options.music !== 'none') void togglePreview(state.options.music, hear);
  });
  syncHomeMusic = sync;
  sync();
}
let syncHomeMusic: () => void = () => {};

function openEdit(): void {
  film.pause();
  const dlg = $<HTMLDialogElement>('edit-dialog');
  $<HTMLInputElement>('title-input').value = state.options.title;
  const value = (name: string) =>
    name === 'music' ? state.options.music : name === 'pace' ? state.options.pace : state.options.clipSound ? 'on' : 'off';
  for (const input of dlg.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
    input.checked = input.value === value(input.name);
  }
  $('clipsound-group').hidden = !state.items.some((m) => m.kind === 'video' && m.hasAudio);
  dlg.showModal();
}

function applyEdit(): void {
  const dlg = $<HTMLDialogElement>('edit-dialog');
  const next: Options = {
    title: $<HTMLInputElement>('title-input').value.trim().slice(0, MAX_TITLE),
    music: (dlg.querySelector<HTMLInputElement>('input[name=music]:checked')?.value ?? 'gentle') as MusicId,
    pace: (dlg.querySelector<HTMLInputElement>('input[name=pace]:checked')?.value ?? 'relaxed') as Pace,
    clipSound: $('clipsound-group').hidden
      ? state.options.clipSound
      : (dlg.querySelector<HTMLInputElement>('input[name=clipsound]:checked')?.value ?? 'off') === 'on',
  };
  const changed = (Object.keys(next) as (keyof Options)[]).some((k) => next[k] !== state.options[k]);
  state.options = next;
  syncHomeMusic();
  dlg.close();
  if (changed) void startMovie(true);
}

// ---------------------------------------------------------------- download

const dl = { abort: null as AbortController | null, job: null as string | null };

interface DlAction {
  label: string;
  kind: 'primary' | 'quiet';
  onClick?: () => void;
  href?: string;
}

/** Fill the download sheet. `progress` null hides the bar. */
function setDl(title: string, paragraphs: string[], actions: DlAction[], opts: { progress?: { text: string; value: number }; code?: string } = {}): void {
  $('download-title').textContent = title;
  const body = $('download-body');
  body.replaceChildren(
    ...paragraphs.map((t) => {
      const p = document.createElement('p');
      p.textContent = t;
      return p;
    }),
  );
  if (opts.code) {
    const c = document.createElement('code');
    c.textContent = opts.code;
    body.append(c);
  }
  const bar = $('download-loading');
  bar.hidden = !opts.progress;
  if (opts.progress) {
    $('download-stage').textContent = opts.progress.text;
    $<HTMLProgressElement>('download-progress').value = opts.progress.value;
  }
  const row = $('download-actions');
  row.replaceChildren(
    ...actions.map((a) => {
      const el = a.href ? document.createElement('a') : document.createElement('button');
      el.className = `btn ${a.kind}`;
      el.textContent = a.label;
      if (a.href) {
        (el as HTMLAnchorElement).href = a.href;
        (el as HTMLAnchorElement).download = 'Memento.mp4';
      } else {
        (el as HTMLButtonElement).type = 'button';
      }
      if (a.onClick) el.addEventListener('click', a.onClick);
      return el;
    }),
  );
}

function closeDownload(): void {
  dl.abort?.abort();
  dl.abort = null;
  if (dl.job) discardJob(dl.job);
  dl.job = null;
  $<HTMLDialogElement>('download-dialog').close();
}

async function openDownload(): Promise<void> {
  film.pause();
  const dlg = $<HTMLDialogElement>('download-dialog');
  setDl('Download MP4', ['Checking for the Memento renderer…'], [{ label: 'Close', kind: 'quiet', onClick: closeDownload }]);
  dlg.showModal();
  const here = await rendererAvailable();
  if (!dlg.open) return;
  if (!here.ok) {
    setDl(
      'MP4 needs the renderer',
      [
        'What you’re watching is a live preview drawn in your browser, so there is no video file yet.',
        here.reason === 'no-ffmpeg'
          ? 'The renderer is running, but FFmpeg isn’t installed on that computer.'
          : 'MP4 files are made by FFmpeg on a computer, and the renderer isn’t running behind this page. To start it, run this in the Memento folder, then open the address it prints:',
      ],
      [{ label: 'Got it', kind: 'primary', onClick: closeDownload }],
      here.reason === 'offline' ? { code: 'npm run build && npm start' } : {},
    );
    return;
  }
  const plan = film.planInfo;
  const length = plan ? formatTime(plan.duration) : '';
  setDl(
    'Download MP4',
    [
      `Memento will make a 1280 × 720 MP4, about ${length} long, from your ${describe(state.items)}, with the clips’ real footage and sound.`,
      `They’re sent to the renderer at ${location.host} and deleted once you’ve saved the file.`,
    ],
    [
      { label: 'Cancel', kind: 'quiet', onClick: closeDownload },
      { label: 'Make MP4', kind: 'primary', onClick: () => void runExport() },
    ],
  );
}

async function runExport(): Promise<void> {
  const plan = film.planInfo;
  if (!plan) return;
  const abort = new AbortController();
  dl.abort = abort;
  const stop: DlAction = { label: 'Cancel', kind: 'quiet', onClick: closeDownload };
  setDl('Making your MP4', ['Keep this page open until it’s ready.'], [stop], { progress: { text: 'Starting…', value: 0 } });
  try {
    const result = await exportMovie({
      items: state.items,
      options: movieOptions(),
      plan,
      signal: abort.signal,
      onJob: (id) => (dl.job = id),
      onProgress: (p) => {
        $('download-stage').textContent = `${p.phase === 'sending' ? 'Step 1 of 2' : 'Step 2 of 2'} · ${p.text}`;
        $<HTMLProgressElement>('download-progress').value = p.fraction;
      },
    });
    dl.abort = null;
    const size = result.size ? ` (${(result.size / 1024 / 1024).toFixed(result.size > 10 * 1024 * 1024 ? 0 : 1)} MB)` : '';
    setDl(
      'Your MP4 is ready',
      [`It’s a real 1280 × 720 H.264 video${size}. Tap Save to keep it.`],
      [
        { label: 'Done', kind: 'quiet', onClick: closeDownload },
        { label: 'Save MP4', kind: 'primary', href: result.href },
      ],
    );
    announce('Your MP4 is ready.');
  } catch (e) {
    dl.abort = null;
    if (abort.signal.aborted) return;
    setDl(
      'The MP4 couldn’t be made',
      [e instanceof Error ? e.message : 'Something went wrong.', 'Your photos, clips and choices are still here.'],
      [
        { label: 'Close', kind: 'quiet', onClick: closeDownload },
        { label: 'Try again', kind: 'primary', onClick: () => void runExport() },
      ],
    );
  }
}

// ---------------------------------------------------------------- wiring

// ---------------------------------------------------------------- full screen

const ICON_FS = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_FS_EXIT = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

let theater = false;
let hideTimer = 0;

const fullscreenElement = (): Element | null => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

function setTheater(on: boolean): void {
  if (theater === on) return;
  theater = on;
  document.body.classList.toggle('theater', on);
  const fs = $('fs');
  fs.innerHTML = on ? ICON_FS_EXIT : ICON_FS;
  fs.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  fs.setAttribute('aria-pressed', String(on));
  window.clearTimeout(hideTimer);
  $('stage').classList.remove('hide-ui');
  if (on) showControls();
  announce(on ? 'Full screen' : 'Full screen off');
}

/** Controls fade away three seconds after the last touch while the movie plays, and come back on any touch. */
function showControls(): void {
  const stage = $('stage');
  stage.classList.remove('hide-ui');
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (theater && film.state === 'playing') stage.classList.add('hide-ui');
  }, 3000);
}

async function enterFullscreen(): Promise<void> {
  setTheater(true);
  const el = $('stage') as FsEl;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    /* no real full screen here (iPhone, or the page is embedded); filling the page is the fallback */
  }
}

async function leaveFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else (document as FsDoc).webkitExitFullscreen?.();
  } catch {
    /* already out */
  }
  setTheater(false);
}

function wire(): void {
  $('wordmark').addEventListener('click', () => show('home'));
  $('choose').addEventListener('click', () => $<HTMLInputElement>('file').click());
  $('add').addEventListener('click', () => $<HTMLInputElement>('file').click());
  $('file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    void handleFiles(files);
  });
  $('continue').addEventListener('click', () => show('photos'));
  $('make').addEventListener('click', () => void make());
  $('back').addEventListener('click', () => show(state.items.length ? 'photos' : 'home'));

  $('grid').addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const open = target.closest<HTMLButtonElement>('.open');
    if (open) return openItem(open.dataset.id!);
    const btn = target.closest<HTMLButtonElement>('.rm');
    if (!btn) return;
    const kind = state.items.find((m) => m.id === btn.dataset.id)?.kind === 'video' ? 'Clip' : 'Photo';
    const i = removeItem(btn.dataset.id!);
    if (i < 0) return;
    renderGrid();
    announce(`${kind} removed. ${describe(state.items) || 'Nothing'} left.`);
    const next = $('grid').querySelectorAll<HTMLButtonElement>('.rm')[Math.min(i, state.items.length - 1)];
    (next ?? $('add')).focus();
  });

  // One item: preview, trim, remove
  const itemDlg = $<HTMLDialogElement>('item-dialog');
  $('item-done').addEventListener('click', () => itemDlg.close());
  itemDlg.addEventListener('close', () => void closeItem());
  $('item-remove').addEventListener('click', () => {
    const m = peek.item;
    if (!m) return;
    peek.trimmed = false;
    const kind = m.kind === 'video' ? 'Clip' : 'Photo';
    itemDlg.close();
    removeItem(m.id);
    renderGrid();
    announce(`${kind} removed.`);
  });
  $('trim-start').addEventListener('input', () => onTrimInput('start'));
  $('trim-length').addEventListener('input', () => onTrimInput('length'));
  $('trim-auto').addEventListener('click', () => {
    const m = peek.item;
    if (!m || m.kind !== 'video') return;
    m.trim = null;
    peek.trimmed = true;
    syncTrimUi(m);
    const t = resolveTrim(m.duration, null, state.options.pace);
    if (peek.video) {
      peek.video.pause();
      peek.video.currentTime = t.start;
    }
  });

  $('arrange').addEventListener('click', openArrange);
  $('arrange-done').addEventListener('click', () => $<HTMLDialogElement>('arrange-dialog').close());
  $<HTMLDialogElement>('arrange-dialog').addEventListener('close', renderGrid);
  $('arrange-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
    if (!btn || btn.disabled) return;
    const i = state.items.findIndex((m) => m.id === btn.dataset.id);
    const j = i + Number(btn.dataset.dir);
    if (i < 0 || j < 0 || j >= state.items.length) return;
    [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
    renderArrange(`${btn.dataset.id}:${btn.dataset.dir}`);
  });

  // Playback
  const toggle = () => {
    music.unlock();
    if (film.state !== 'playing') film.prime();
    film.toggle();
  };
  $('film-hit').addEventListener('click', toggle);
  $('pp').addEventListener('click', toggle);
  $('replay').addEventListener('click', () => {
    music.unlock();
    film.seek(0);
    film.prime();
    film.play();
  });
  $('mute').addEventListener('click', () => {
    state.muted = !state.muted;
    film.setMuted(state.muted);
    syncMuteUi();
    announce(state.muted ? 'Sound off' : 'Sound on');
  });
  $('edit').addEventListener('click', openEdit);
  $('download').addEventListener('click', () => void openDownload());
  $<HTMLDialogElement>('download-dialog').addEventListener('cancel', (e) => {
    e.preventDefault(); // Escape goes through the same clean-up as the buttons
    closeDownload();
  });

  const seek = $<HTMLInputElement>('seek');
  seek.addEventListener('input', () => {
    if (!scrubbing) {
      scrubbing = true;
      wasPlaying = film.state === 'playing';
      film.pause();
    }
    const v = Number(seek.value);
    seek.style.setProperty('--p', `${v / 10}%`);
    film.seek((v / 1000) * film.duration);
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    if (wasPlaying) film.play();
    wasPlaying = false;
  });

  // Full screen. iPhone Safari only allows the Fullscreen API on <video>, and the movie is a canvas, so
  // the stage fills the whole page instead ("theater"). Where the real API exists it is used as well.
  $('fs').innerHTML = ICON_FS;
  $('fs').addEventListener('click', () => void (theater ? leaveFullscreen() : enterFullscreen()));
  const poke = () => {
    if (theater) showControls();
  };
  $('stage').addEventListener('pointerdown', poke);
  $('stage').addEventListener('pointermove', poke);
  document.addEventListener('fullscreenchange', () => {
    if (theater && !fullscreenElement()) setTheater(false);
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (theater && !fullscreenElement()) setTheater(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && theater && !document.querySelector('dialog[open]')) void leaveFullscreen();
  });

  // Edit sheet
  buildMusicList();
  buildHomeMusic();
  $<HTMLDialogElement>('edit-dialog').addEventListener('close', () => {
    stopPreview();
    music.setMuted(state.muted);
  });
  $('edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    applyEdit();
  });
  $('edit-cancel').addEventListener('click', () => $<HTMLDialogElement>('edit-dialog').close());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && film.state === 'playing') film.pause();
  });
}

async function boot(): Promise<void> {
  wire();
  syncWatchUi('idle');
  show('home');
}

// Test hook: open the page with ?debug to reach the player from a script.
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __memento: { film, state, music } });

void boot();
void TRACKS;
