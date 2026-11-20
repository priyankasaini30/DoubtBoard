import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggestSimilar } from '../src/suggest.js';
import { loadPairs } from '../src/evaluation.js';

const background = [...new Set(loadPairs(readFileSync(new URL('../eval/pairs.csv', import.meta.url), 'utf8')).flatMap((p) => [p.a, p.b]))];
const room = (...texts) => texts.map((text, i) => ({ id: String(i), text, votes: 0 }));
const THRESHOLD = 0.3; // the production default

test('suggests a near-duplicate in an almost empty room', () => {
  const existing = room('What is a deadlock in OS?');
  const hits = suggestSimilar('Can someone explain what deadlock is in OS?', existing, { background, threshold: THRESHOLD });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, '0');
});

test('background corpus rescues a duplicate that a tiny room alone would miss', () => {
  const existing = room('What is a deadlock in OS?');
  const text = 'Explain deadlock in operating systems';
  assert.deepEqual(suggestSimilar(text, existing, { threshold: THRESHOLD }), []); // room-only IDF: score ~0.26
  assert.equal(suggestSimilar(text, existing, { background, threshold: THRESHOLD }).length, 1); // ~0.38
});

test('does not match on shared question-template words alone', () => {
  const existing = room('What is deadlock and its types?', 'What is a queue and what are its types?');
  const hits = suggestSimilar('What is a semaphore and what are its types?', existing, { background, threshold: THRESHOLD });
  assert.deepEqual(hits, []);
});

test('does not suggest an unrelated question', () => {
  const existing = room('What is a deadlock in OS?', 'What is a primary key?');
  const hits = suggestSimilar('How does quicksort pick a pivot?', existing, { background, threshold: THRESHOLD });
  assert.deepEqual(hits, []);
});

test('returns best matches first and at most topK', () => {
  const existing = room('What is deadlock in OS?', 'Explain deadlock', 'Why does deadlock happen in an OS?', 'Deadlock prevention methods?');
  const hits = suggestSimilar('What is deadlock in operating systems?', existing, { background, threshold: 0.1, topK: 2 });
  assert.equal(hits.length, 2);
  assert.ok(hits[0].similarity >= hits[1].similarity);
});

test('passes extra fields (votes) through to the caller', () => {
  const existing = [{ id: 'a', text: 'What is normalization in DBMS?', votes: 7 }];
  const [hit] = suggestSimilar('Explain database normalization', existing, { background, threshold: 0.2 });
  assert.equal(hit.votes, 7);
});

test('works with no background corpus and an empty room', () => {
  assert.deepEqual(suggestSimilar('anything at all', [], { threshold: THRESHOLD }), []);
});