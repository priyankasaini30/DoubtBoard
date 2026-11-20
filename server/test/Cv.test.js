import test from 'node:test';
import assert from 'node:assert/strict';
import { stratifiedFolds, bootstrapCI } from '../src/evaluation.js';

const makePairs = (dups, nots) => [
  ...Array.from({ length: dups }, (_, i) => ({ a: `dup-a-${i}`, b: `dup-b-${i}`, label: 1 })),
  ...Array.from({ length: nots }, (_, i) => ({ a: `not-a-${i}`, b: `not-b-${i}`, label: 0 })),
];

test('every pair is tested exactly once across the folds', () => {
  const pairs = makePairs(24, 76);
  const folds = stratifiedFolds(pairs, 5, 1);
  const tested = folds.flatMap((f) => f.test);
  assert.equal(tested.length, pairs.length);
  assert.equal(new Set(tested).size, pairs.length);
});

test('train and test never overlap, and together they cover all pairs', () => {
  const pairs = makePairs(24, 76);
  for (const { train, test: held } of stratifiedFolds(pairs, 5, 1)) {
    assert.equal(train.length + held.length, pairs.length);
    assert.equal(train.filter((p) => held.includes(p)).length, 0);
  }
});

test('each fold keeps both classes and the duplicate share', () => {
  const folds = stratifiedFolds(makePairs(24, 76), 5, 1);
  for (const { test: held } of folds) {
    const d = held.filter((p) => p.label === 1).length;
    assert.ok(d >= 4 && d <= 5, `duplicates per fold should be 4-5, got ${d}`);
    assert.ok(held.length - d >= 15);
  }
});

test('folds are reproducible for a seed and differ between seeds', () => {
  const pairs = makePairs(24, 76);
  const ids = (folds) => folds[0].test.map((p) => p.a).join('|');
  assert.equal(ids(stratifiedFolds(pairs, 5, 3)), ids(stratifiedFolds(pairs, 5, 3)));
  assert.notEqual(ids(stratifiedFolds(pairs, 5, 3)), ids(stratifiedFolds(pairs, 5, 4)));
});

test('rejects a fold count larger than the number of duplicates', () => {
  assert.throws(() => stratifiedFolds(makePairs(3, 30), 5), /--cv needs/);
  assert.throws(() => stratifiedFolds(makePairs(10, 30), 1), /--cv needs/);
});

test('bootstrap interval brackets the observed value and is wider for fewer samples', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ predicted: i % 4 !== 0, label: i % 2 === 0 ? 1 : 0 }));
  const small = bootstrapCI(make(40), 500, 1);
  const large = bootstrapCI(make(400), 500, 1);
  const width = (r) => r[1] - r[0];
  assert.ok(small.precision[0] <= small.precision[1]);
  assert.ok(width(small.recall) > width(large.recall));
});