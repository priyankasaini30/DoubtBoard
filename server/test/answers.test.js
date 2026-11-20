import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAnswers } from '../src/ranking.js';

const a = (id, votes, minute, accepted = false) => ({ id, votes, accepted, createdAt: new Date(2026, 0, 1, 10, minute) });

test('rankAnswers: most votes first', () => {
  assert.deepEqual(rankAnswers([a('x', 1, 0), a('y', 5, 1), a('z', 3, 2)]).map((r) => r.id), ['y', 'z', 'x']);
});

test('rankAnswers: accepted answer first even with fewer votes', () => {
  assert.deepEqual(rankAnswers([a('x', 9, 0), a('y', 0, 1, true)]).map((r) => r.id), ['y', 'x']);
});

test('rankAnswers: ties go to the older answer', () => {
  assert.deepEqual(rankAnswers([a('late', 2, 30), a('early', 2, 5)]).map((r) => r.id), ['early', 'late']);
});

test('rankAnswers does not mutate its input', () => {
  const input = [a('x', 1, 0), a('y', 2, 1)];
  rankAnswers(input);
  assert.deepEqual(input.map((r) => r.id), ['x', 'y']);
});