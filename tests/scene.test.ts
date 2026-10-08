import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blackAlpha,
  buildPlan,
  defaultTrim,
  fitTrim,
  musicGain,
  photoScale,
  sceneAlpha,
  secondsPerPhoto,
  DUCK_LEVEL,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  type MovieOptions,
  type PlanItem,
  type Trim,
} from '../src/scene.ts';

const base: MovieOptions = { title: '', music: 'gentle', pace: 'relaxed', reducedMotion: false, clipSound: true };
const photos = (n: number): PlanItem[] => Array.from({ length: n }, () => ({ kind: 'photo' }));
const clip = (duration = 20, hasAudio = true, trim: Trim | null = null): PlanItem => ({
  kind: 'video',
  duration,
  hasAudio,
  trim,
});

test('typical films land in the 30 to 62 second range', () => {
  for (const n of [5, 6, 8, 10, 12]) {
    const d = buildPlan(photos(n), base).duration;
    assert.ok(d >= 30 && d <= 62, `${n} photos -> ${d.toFixed(1)}s`);
  }
});

test('twenty photos stay under two minutes at either pace, even with a title', () => {
  for (const pace of ['relaxed', 'quicker'] as const) {
    const d = buildPlan(photos(20), { ...base, pace, title: 'x' }).duration;
    assert.ok(d < 120, `${pace}: ${d.toFixed(1)}s`);
  }
});

test('one or two photos make a short film instead of stretching', () => {
  assert.ok(buildPlan(photos(1), base).duration <= 7.01);
  assert.ok(buildPlan(photos(2), base).duration <= 14);
});

test('quicker is quicker', () => {
  for (const n of [3, 6, 12, 20]) {
    assert.ok(secondsPerPhoto(n, 'quicker') <= secondsPerPhoto(n, 'relaxed'));
  }
});

test('items keep their order and overlap only by the crossfade', () => {
  const items: PlanItem[] = [...photos(2), clip(), ...photos(2), clip(9), ...photos(1)];
  const plan = buildPlan(items, base);
  plan.scenes.forEach((s, i) => {
    assert.equal(s.itemIndex, i);
    assert.equal(s.kind, items[i].kind);
    if (i > 0) assert.ok(Math.abs(plan.scenes[i - 1].end - s.start - plan.crossfade) < 1e-9);
  });
});

test('a title adds one opening card and never invents text', () => {
  assert.equal(buildPlan(photos(4), base).scenes.filter((s) => s.kind === 'title').length, 0);
  const titled = buildPlan(photos(4), { ...base, title: '  Lake days  ' });
  assert.equal(titled.title, 'Lake days');
  assert.equal(titled.scenes[0].kind, 'title');
  assert.equal(titled.scenes.filter((s) => s.kind === 'photo').length, 4);
});

test('titles are capped', () => {
  assert.equal(buildPlan(photos(2), { ...base, title: 'a'.repeat(200) }).title.length, 60);
});

test('photos are never scaled past their fitted size, so nothing is cropped', () => {
  const plan = buildPlan(photos(6), base);
  for (const z of ['in', 'out'] as const) {
    for (let p = 0; p <= 1; p += 0.05) {
      const s = photoScale(plan, z, p);
      assert.ok(s <= 1 && s >= plan.minScale - 1e-9);
    }
  }
});

test('reduced motion removes zoom', () => {
  const plan = buildPlan(photos(6), { ...base, reducedMotion: true });
  assert.ok(plan.scenes.every((s) => s.zoom === 'none'));
});

test('fades: black at start and end, clear in the middle', () => {
  const plan = buildPlan(photos(6), base);
  assert.equal(blackAlpha(plan, 0), 1);
  assert.ok(Math.abs(blackAlpha(plan, plan.duration) - 1) < 1e-9);
  assert.equal(blackAlpha(plan, plan.duration / 2), 0);
  assert.equal(sceneAlpha(plan, 1, plan.scenes[1].start), 0);
  assert.equal(sceneAlpha(plan, 1, plan.scenes[1].start + plan.crossfade), 1);
});

test('an empty selection has an empty plan', () => {
  const plan = buildPlan([], { ...base, title: 'x' });
  assert.equal(plan.duration, 0);
  assert.equal(plan.scenes.length, 0);
});

// ---- clips -------------------------------------------------------------------------------------

test('a long clip gets a short automatic excerpt from inside it', () => {
  for (const d of [8, 20, 60, 600]) {
    const t = defaultTrim(d, 'relaxed');
    assert.ok(t.length <= 6.0001 && t.length >= MIN_CLIP_SECONDS, `${d}s -> ${t.length}`);
    assert.ok(t.start >= 0 && t.start + t.length <= d + 1e-9);
  }
  assert.ok(defaultTrim(60, 'quicker').length < defaultTrim(60, 'relaxed').length);
});

test('a short clip is used whole', () => {
  assert.deepEqual(defaultTrim(5, 'relaxed'), { start: 0, length: 5 });
  assert.deepEqual(defaultTrim(7, 'relaxed'), { start: 0, length: 7 });
});

test('a trim is always legal: inside the clip, not too short, not too long', () => {
  for (const [trim, d] of [
    [{ start: -3, length: 0.1 }, 30],
    [{ start: 29, length: 10 }, 30],
    [{ start: 0, length: 500 }, 400],
    [{ start: 2, length: 3 }, 2],
  ] as const) {
    const t = fitTrim(trim, d);
    assert.ok(t.start >= 0 && t.start + t.length <= d + 1e-9, JSON.stringify({ trim, d, t }));
    assert.ok(t.length <= MAX_CLIP_SECONDS + 1e-9);
    assert.ok(t.length >= Math.min(MIN_CLIP_SECONDS, d) - 1e-9);
  }
});

test('a clip scene lasts exactly its excerpt and does not zoom', () => {
  const plan = buildPlan([...photos(1), clip(30, true, { start: 4, length: 8 }), ...photos(1)], base);
  const v = plan.scenes[1];
  assert.equal(v.kind, 'video');
  assert.equal(v.zoom, 'none');
  assert.deepEqual(v.clip, { start: 4, length: 8, audio: true });
  assert.ok(Math.abs(v.end - v.start - 8) < 1e-9);
});

test('photos before and after a clip still alternate their gentle zoom', () => {
  const plan = buildPlan([...photos(1), clip(), ...photos(2)], base);
  const zooms = plan.scenes.filter((s) => s.kind === 'photo').map((s) => s.zoom);
  assert.deepEqual(zooms, ['in', 'out', 'in']);
});

test('music dips under a clip with sound and comes back after it', () => {
  const plan = buildPlan([...photos(3), clip(20, true, { start: 0, length: 6 }), ...photos(3)], base);
  const v = plan.scenes[3];
  assert.equal(musicGain(plan, 0), 1);
  assert.equal(musicGain(plan, plan.duration), 1);
  assert.ok(Math.abs(musicGain(plan, (v.start + v.end) / 2) - DUCK_LEVEL) < 1e-9);
  assert.ok(musicGain(plan, v.end + 3) > 0.99);
  for (const p of plan.duck) assert.ok(p.g >= DUCK_LEVEL - 1e-9 && p.g <= 1 + 1e-9 && p.t >= 0 && p.t <= plan.duration);
  for (let i = 1; i < plan.duck.length; i++) assert.ok(plan.duck[i].t >= plan.duck[i - 1].t);
});

test('music is left alone when clip sound is off or the clip has no sound track', () => {
  const off = buildPlan([...photos(2), clip()], { ...base, clipSound: false });
  assert.ok(off.duck.every((p) => p.g === 1));
  assert.equal(off.scenes[2].clip?.audio, false);
  const silent = buildPlan([...photos(2), clip(20, false)], base);
  assert.ok(silent.duck.every((p) => p.g === 1));
  assert.equal(silent.scenes[2].clip?.audio, false);
});

test('clips that follow each other share one dip', () => {
  const plan = buildPlan([clip(), clip(), ...photos(2)], base);
  const lows = plan.duck.filter((p) => p.g < 0.5);
  assert.equal(lows.length, 2); // one dip: its start and its end
});

test('thirty mixed items still make a film under three minutes', () => {
  const items: PlanItem[] = [...photos(25), clip(), clip(), clip(), clip(), clip()];
  for (const pace of ['relaxed', 'quicker'] as const) {
    const d = buildPlan(items, { ...base, pace }).duration;
    assert.ok(d < 180, `${pace}: ${d.toFixed(0)}s`);
  }
});
