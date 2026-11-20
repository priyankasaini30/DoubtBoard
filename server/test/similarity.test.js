import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, stem, OverlapScorer, TfidfScorer, findSimilar } from '../src/similarity.js';
import { rankScore, rankQuestions } from '../src/ranking.js';
import { parseCsv, loadPairs, precisionRecall, bestThreshold, stratifiedSplit } from '../src/evaluation.js';

test('stemmer unifies singular and plural', () => {
  assert.equal(stem('semaphores'), stem('semaphore'));
  assert.equal(stem('deadlocks'), stem('deadlock'));
});

test('tokenize drops stopwords and punctuation', () => {
  assert.deepEqual(tokenize('What is a Deadlock?'), ['deadlock']);
  assert.deepEqual(tokenize(''), []);
});

test('identical questions score 1 and unrelated score 0', () => {
  const s = new TfidfScorer().fit(['What is deadlock?', 'What is paging?']);
  assert.ok(Math.abs(s.score('What is deadlock?', 'What is deadlock?') - 1) < 1e-9);
  assert.equal(s.score('What is deadlock?', 'What is paging?'), 0);
});

test('paraphrase scores above unrelated question', () => {
  const corpus = ['What is deadlock in OS?', 'Explain deadlock in operating systems', 'What is normalization in DBMS?'];
  const s = new TfidfScorer().fit(corpus);
  assert.ok(s.score(corpus[0], corpus[1]) > s.score(corpus[0], corpus[2]));
});

test('empty text scores 0 for both scorers', () => {
  assert.equal(new OverlapScorer().score('', 'deadlock'), 0);
  assert.equal(new TfidfScorer().fit(['x']).score('the', 'a'), 0);
});

test('findSimilar filters by threshold, sorts, and limits', () => {
  const existing = [
    { id: '1', text: 'What is paging in OS?' },
    { id: '2', text: 'Explain deadlock in operating systems' },
    { id: '3', text: 'Deadlock handling in OS' },
  ];
  const scorer = new TfidfScorer().fit([...existing.map((e) => e.text), 'What is deadlock?']);
  const hits = findSimilar(scorer, 'What is deadlock?', existing, 0.2, 2);
  assert.ok(hits.length >= 1 && hits.length <= 2);
  assert.ok(hits.every((h) => h.id !== '1'));
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].similarity >= hits[i].similarity);
});

test('ranking: time decay lets a newer question beat a stale popular one', () => {
  const now = Date.now();
  const hoursAgo = (h) => new Date(now - h * 3_600_000);
  assert.ok(rankScore(20, hoursAgo(48), now) < rankScore(5, hoursAgo(1), now));
  assert.ok(rankScore(5, hoursAgo(1), now) > rankScore(0, hoursAgo(1), now));
});

test('ranking: answered sink to the bottom, ties go to the newest', () => {
  const now = Date.now();
  const mk = (id, votes, hAgo, status = 'open') => ({ id, votes, status, createdAt: new Date(now - hAgo * 3_600_000) });
  const ranked = rankQuestions([mk('done', 50, 0.1, 'answered'), mk('a', 0, 2), mk('b', 0, 1)], now);
  assert.deepEqual(ranked.map((q) => q.id), ['b', 'a', 'done']);
});

test('csv parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('loadPairs rejects a bad header', () => {
  assert.throws(() => loadPairs('x,y,z\n1,2,3'));
});

test('precision / recall maths', () => {
  const scored = [
    { score: 0.9, label: 1 }, { score: 0.8, label: 1 }, { score: 0.6, label: 0 },
    { score: 0.3, label: 1 }, { score: 0.1, label: 0 },
  ];
  const r = precisionRecall(scored, 0.5);
  assert.equal(r.tp, 2); assert.equal(r.fp, 1); assert.equal(r.fn, 1);
  assert.ok(Math.abs(r.precision - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.recall - 2 / 3) < 1e-9);
});

test('bestThreshold separates a clean split', () => {
  const scored = [
    { score: 0.9, label: 1 }, { score: 0.7, label: 1 },
    { score: 0.2, label: 0 }, { score: 0.1, label: 0 },
  ];
  const t = bestThreshold(scored);
  const r = precisionRecall(scored, t);
  assert.equal(r.precision, 1); assert.equal(r.recall, 1);
});

test('stratified split is reproducible and keeps both classes in both sets', () => {
  const pairs = Array.from({ length: 20 }, (_, i) => ({ a: `a${i}`, b: `b${i}`, label: i % 2 }));
  const s1 = stratifiedSplit(pairs, 0.7, 7);
  const s2 = stratifiedSplit(pairs, 0.7, 7);
  assert.deepEqual(s1.test.map((p) => p.a), s2.test.map((p) => p.a));
  assert.equal(s1.train.length + s1.test.length, 20);
  for (const set of [s1.train, s1.test]) {
    assert.ok(set.some((p) => p.label === 1) && set.some((p) => p.label === 0));
  }
});
