import { loadFiles, loadSamples, releasePhoto, type Photo } from './photos.ts';
import { MusicEngine, TRACKS } from './music.ts';
import { Player, type PlayerState } from './player.ts';
import { MAX_PHOTOS, MAX_TITLE, formatTime, type MovieOptions, type MusicId, type Pace } from './scene.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

type Screen = 'home' | 'photos' | 'watch';
type Options = Omit<MovieOptions, 'reducedMotion'>;

const state = {
  screen: 'home' as Screen,
  photos: [] as Photo[],
  samples: [] as Photo[],
  options: { title: '', music: 'gentle', pace: 'relaxed' } as Options,
  fresh: new Set<string>(),
};

const music = new MusicEngine();
const movieOptions = (): MovieOptions => ({ ...state.options, reducedMotion: reduced.matches });

const ICON_PLAY = '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 001.5.86l11-6.8a1 1 0 000-1.72l-11-6.8A1 1 0 008 5.2z"/></svg>';
const ICON_PAUSE = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.4" height="14" rx="1.2"/><rect x="13.6" y="5" width="4.4" height="14" rx="1.2"/></svg>';
const ICON_X = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
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

// ---------------------------------------------------------------- screens

let hero: Player | null = null;

function show(screen: Screen): void {
  if (state.screen === 'watch' && screen !== 'watch') film.pause();
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
  syncHero();
  if (screen === 'home') {
    const cont = $<HTMLButtonElement>('continue');
    const mine = state.photos.filter((p) => p.origin === 'user');
    cont.hidden = mine.length === 0;
    cont.textContent = `Continue with your ${mine.length} photo${mine.length === 1 ? '' : 's'}`;
  }
  if (screen === 'photos') $('photos-title').focus({ preventScroll: true });
}

function syncHero(): void {
  if (!hero) return;
  const wantPlaying = state.screen === 'home' && !reduced.matches && !document.hidden;
  if (wantPlaying && hero.state !== 'playing') hero.play();
  else if (!wantPlaying && hero.state === 'playing') hero.pause();
}

// ---------------------------------------------------------------- photos

function photoCountText(n: number): string {
  return `${n} photo${n === 1 ? '' : 's'}`;
}

function renderGrid(): void {
  const grid = $('grid');
  const n = state.photos.length;
  $('count').textContent = photoCountText(n);
  $<HTMLButtonElement>('make').disabled = n === 0;
  $<HTMLButtonElement>('arrange').disabled = n < 2;
  $<HTMLButtonElement>('add').disabled = n >= MAX_PHOTOS;
  grid.style.setProperty('--scale', String(n === 1 ? 2.6 : n <= 4 ? 1.3 : 1));
  grid.replaceChildren();
  if (!n) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No photos yet. Add a few to begin.';
    grid.append(p);
    return;
  }
  state.photos.forEach((p, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--ar', p.ar.toFixed(4));
    if (state.fresh.has(p.id)) {
      li.className = 'fresh';
      li.style.setProperty('--i', String(Math.min(i, 12)));
    }
    const img = document.createElement('img');
    img.src = p.thumbUrl;
    img.alt = `Photo ${i + 1} of ${n}`;
    img.decoding = 'async';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.dataset.id = p.id;
    rm.setAttribute('aria-label', `Remove photo ${i + 1}`);
    rm.innerHTML = `<span>${ICON_X}</span>`;
    li.append(img, rm);
    grid.append(li);
  });
  state.fresh.clear();
}

async function handleFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  const here = state.screen;
  const target = here === 'home' ? 'home-notice' : 'photos-notice';
  if (state.photos.length && state.photos.every((p) => p.origin === 'sample')) state.photos = [];
  const room = MAX_PHOTOS - state.photos.length;
  if (room <= 0) {
    notice(target, [`Memento uses up to ${MAX_PHOTOS} photos. Remove one to add another.`]);
    return;
  }
  setBusy(true);
  $<HTMLButtonElement>('choose').textContent = 'Opening photos…';
  try {
    const { photos, failures, skipped } = await loadFiles(files, room);
    state.photos.push(...photos);
    photos.forEach((p) => state.fresh.add(p.id));
    const problems = failures.map((f) => `${f.name}: ${f.reason}`);
    if (skipped > 0) problems.push(`Memento uses up to ${MAX_PHOTOS} photos, so ${skipped} weren’t added.`);
    if (state.photos.length) {
      renderGrid();
      if (here !== 'photos') show('photos');
      notice('photos-notice', problems, 'error', problems.length ? 'Some files weren’t added. The rest are ready.' : undefined);
      announce(`${photoCountText(photos.length)} added`);
    } else {
      notice(target, problems, 'error', 'None of those could be opened.');
    }
  } catch {
    notice(target, ['Something went wrong opening those photos. Nothing was lost; try again.']);
  } finally {
    setBusy(false);
    $<HTMLButtonElement>('choose').textContent = 'Choose photos';
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
  const n = state.photos.length;
  state.photos.forEach((p, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = p.thumbUrl;
    img.alt = '';
    const lab = document.createElement('span');
    lab.className = 'lab';
    lab.textContent = `Photo ${i + 1}`;
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'iconbtn';
    up.dataset.id = p.id;
    up.dataset.dir = '-1';
    up.disabled = i === 0;
    up.setAttribute('aria-label', `Move photo ${i + 1} up`);
    up.innerHTML = ICON_UP;
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'iconbtn';
    down.dataset.id = p.id;
    down.dataset.dir = '1';
    down.disabled = i === n - 1;
    down.setAttribute('aria-label', `Move photo ${i + 1} down`);
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
}

async function startMovie(autoplay: boolean): Promise<void> {
  const opts = movieOptions();
  film.setMovie(state.photos, opts);
  $('movie-title').textContent = film.planInfo?.title ?? '';
  $('movie-title').hidden = !film.planInfo?.title;
  $('time').textContent = `0:00 / ${formatTime(film.duration)}`;
  $<HTMLInputElement>('seek').value = '0';
  $('seek').style.setProperty('--p', '0%');
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
  if (!state.photos.length) return;
  music.unlock(); // inside the tap, so the browser allows sound
  show('watch');
  try {
    await startMovie(true);
  } catch {
    show('photos');
    notice('photos-notice', ['Something went wrong making the movie. Your photos are still here.']);
  }
}

async function watchSample(): Promise<void> {
  if (!state.samples.length) return;
  music.unlock();
  state.photos = [...state.samples];
  renderGrid();
  show('watch');
  try {
    await startMovie(true);
  } catch {
    show('home');
    notice('home-notice', ['The sample couldn’t be played. Try again.']);
  }
}

function openEdit(): void {
  film.pause();
  const dlg = $<HTMLDialogElement>('edit-dialog');
  $<HTMLInputElement>('title-input').value = state.options.title;
  for (const input of dlg.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
    input.checked = input.value === (input.name === 'music' ? state.options.music : state.options.pace);
  }
  dlg.showModal();
}

function applyEdit(): void {
  const dlg = $<HTMLDialogElement>('edit-dialog');
  const next: Options = {
    title: $<HTMLInputElement>('title-input').value.trim().slice(0, MAX_TITLE),
    music: (dlg.querySelector<HTMLInputElement>('input[name=music]:checked')?.value ?? 'gentle') as MusicId,
    pace: (dlg.querySelector<HTMLInputElement>('input[name=pace]:checked')?.value ?? 'relaxed') as Pace,
  };
  const changed = next.title !== state.options.title || next.music !== state.options.music || next.pace !== state.options.pace;
  state.options = next;
  dlg.close();
  if (changed) void startMovie(true);
}

// ---------------------------------------------------------------- wiring

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
  $('sample').addEventListener('click', () => void watchSample());
  $('hero-play').addEventListener('click', () => void watchSample());
  $('make').addEventListener('click', () => void make());
  $('back').addEventListener('click', () => show(state.photos.length ? 'photos' : 'home'));

  $('grid').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.rm');
    if (!btn) return;
    const i = state.photos.findIndex((p) => p.id === btn.dataset.id);
    if (i < 0) return;
    const [gone] = state.photos.splice(i, 1);
    releasePhoto(gone);
    renderGrid();
    announce(`Photo removed. ${photoCountText(state.photos.length)} left.`);
    const next = $('grid').querySelectorAll<HTMLButtonElement>('.rm')[Math.min(i, state.photos.length - 1)];
    (next ?? $('add')).focus();
  });

  $('arrange').addEventListener('click', openArrange);
  $('arrange-done').addEventListener('click', () => $<HTMLDialogElement>('arrange-dialog').close());
  $<HTMLDialogElement>('arrange-dialog').addEventListener('close', renderGrid);
  $('arrange-list').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]');
    if (!btn || btn.disabled) return;
    const i = state.photos.findIndex((p) => p.id === btn.dataset.id);
    const j = i + Number(btn.dataset.dir);
    if (i < 0 || j < 0 || j >= state.photos.length) return;
    [state.photos[i], state.photos[j]] = [state.photos[j], state.photos[i]];
    renderArrange(`${btn.dataset.id}:${btn.dataset.dir}`);
  });

  // Playback
  const toggle = () => {
    music.unlock();
    film.toggle();
  };
  $('film-hit').addEventListener('click', toggle);
  $('pp').addEventListener('click', toggle);
  $('replay').addEventListener('click', () => {
    music.unlock();
    film.seek(0);
    film.play();
  });
  $('edit').addEventListener('click', openEdit);
  $('download').addEventListener('click', () => $<HTMLDialogElement>('download-dialog').showModal());
  $('download-ok').addEventListener('click', () => $<HTMLDialogElement>('download-dialog').close());

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

  const root = document as Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  const filmEl = $('film') as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  const fsOk = Boolean(root.fullscreenEnabled || root.webkitFullscreenEnabled);
  $('fs').hidden = !fsOk;
  $('fs').addEventListener('click', async () => {
    try {
      if (root.fullscreenElement || root.webkitFullscreenElement) {
        if (root.exitFullscreen) await root.exitFullscreen();
        else root.webkitExitFullscreen?.();
      } else if (filmEl.requestFullscreen) await filmEl.requestFullscreen();
      else await filmEl.webkitRequestFullscreen?.();
    } catch {
      announce('Full screen isn’t available here.');
    }
  });

  // Edit sheet
  $('edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    applyEdit();
  });
  $('edit-cancel').addEventListener('click', () => $<HTMLDialogElement>('edit-dialog').close());

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && film.state === 'playing') film.pause();
    syncHero();
  });
  reduced.addEventListener('change', () => {
    if (hero && state.samples.length) hero.setMovie(state.samples, { ...state.options, music: 'none', reducedMotion: reduced.matches }, reduced.matches ? 2.5 : 0);
    syncHero();
  });
}

async function boot(): Promise<void> {
  wire();
  syncWatchUi('idle');
  hero = new Player($<HTMLCanvasElement>('hero-canvas'), { scale: 0.5, loop: true, music: null });
  try {
    state.samples = await loadSamples();
    hero.setMovie(state.samples, { title: '', music: 'none', pace: 'relaxed', reducedMotion: reduced.matches }, reduced.matches ? 2.5 : 0);
    $<HTMLButtonElement>('sample').disabled = false;
    $<HTMLButtonElement>('hero-play').disabled = false;
    syncHero();
  } catch {
    $('hero-play').hidden = true;
    $('sample').hidden = true;
    notice('home-notice', ['The sample photos couldn’t be loaded. You can still choose your own.'], 'info');
  }
  show('home');
}

void boot();
void TRACKS;
