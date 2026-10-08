import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blackAlpha, buildPlan, photoScale, sceneAlpha, secondsPerPhoto, type MovieOptions } from '../src/scene.ts';

const base: MovieOptions = { title: '', music: 'gentle', pace: 'relaxed', reducedMotion: false };

test('typical films land in the 30 to 60 second range', () => {
  for (const n of [5, 6, 8, 10, 12]) {
    const d = buildPlan(n, base).duration;
    assert.ok(d >= 30 && d <= 62, `${n} photos -> ${d.toFixed(1)}s`);
  }
});

test('twenty photos stay under two minutes at either pace, even with a title', () => {
  for (const pace of ['relaxed', 'quicker'] as const) {
    const d = buildPlan(20, { ...base, pace, title: 'x' }).duration;
    assert.ok(d < 120, `${pace}: ${d.toFixed(1)}s`);
  }
});

test('one or two photos make a short film instead of stretching', () => {
  assert.ok(buildPlan(1, base).duration <= 7.01);
  assert.ok(buildPlan(2, base).duration <= 14);
});

test('quicker is quicker', () => {
  for (const n of [3, 6, 12, 20]) {
    assert.ok(secondsPerPhoto(n, 'quicker') <= secondsPerPhoto(n, 'relaxed'));
  }
});

test('photos keep their order and overlap only by the crossfade', () => {
  const plan = buildPlan(6, base);
  plan.scenes.forEach((s, i) => {
    assert.equal(s.photoIndex, i);
    if (i > 0) assert.ok(Math.abs(plan.scenes[i - 1].end - s.start - plan.crossfade) < 1e-9);
  });
});

test('a title adds one opening card and never invents text', () => {
  assert.equal(buildPlan(4, base).scenes.filter((s) => s.kind === 'title').length, 0);
  const titled = buildPlan(4, { ...base, title: '  Lake days  ' });
  assert.equal(titled.title, 'Lake days');
  assert.equal(titled.scenes[0].kind, 'title');
  assert.equal(titled.scenes.filter((s) => s.kind === 'photo').length, 4);
});

test('titles are capped', () => {
  assert.equal(buildPlan(2, { ...base, title: 'a'.repeat(200) }).title.length, 60);
});

test('photos are never scaled past their fitted size, so nothing is cropped', () => {
  const plan = buildPlan(6, base);
  for (const z of ['in', 'out'] as const) {
    for (let p = 0; p <= 1; p += 0.05) {
      const s = photoScale(plan, z, p);
      assert.ok(s <= 1 && s >= plan.minScale - 1e-9);
    }
  }
});

test('reduced motion removes zoom', () => {
  const plan = buildPlan(6, { ...base, reducedMotion: true });
  assert.ok(plan.scenes.every((s) => s.zoom === 'none'));
});

test('fades: black at start and end, clear in the middle', () => {
  const plan = buildPlan(6, base);
  assert.equal(blackAlpha(plan, 0), 1);
  assert.ok(Math.abs(blackAlpha(plan, plan.duration) - 1) < 1e-9);
  assert.equal(blackAlpha(plan, plan.duration / 2), 0);
  assert.equal(sceneAlpha(plan, 1, plan.scenes[1].start), 0);
  assert.equal(sceneAlpha(plan, 1, plan.scenes[1].start + plan.crossfade), 1);
});

test('an empty selection has an empty plan', () => {
  const plan = buildPlan(0, { ...base, title: 'x' });
  assert.equal(plan.duration, 0);
  assert.equal(plan.scenes.length, 0);
});
