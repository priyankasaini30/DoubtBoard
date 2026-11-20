import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPairs } from '../src/evaluation.js';

const H = 'question_a,question_b,is_duplicate\n';

test('loadPairs accepts 0 and 1 labels', () => {
  const pairs = loadPairs(`${H}What is a deadlock?,Explain deadlock,1\nWhat is a stack?,What is a queue?,0\n`);
  assert.deepEqual(pairs.map((p) => p.label), [1, 0]);
});

test('loadPairs accepts a file that starts with a byte-order mark (Excel / PowerShell)', () => {
  const pairs = loadPairs(`﻿${H}What is a deadlock?,Explain deadlock,1\n`);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, 'What is a deadlock?');
});

test('loadPairs accepts semicolon-separated files and mixed-case, padded headers', () => {
  const pairs = loadPairs('Question_A ; question_b;IS_DUPLICATE\nWhat is a stack?;What is a queue?;0\n');
  assert.deepEqual(pairs.map((p) => p.label), [0]);
});

test('the header error shows what was found', () => {
  assert.throws(() => loadPairs('a,b,c\n1,2,3\n'), /found: \["a","b","c"\]/);
});

test('loadPairs rejects an unlabelled row instead of treating it as a non-duplicate', () => {
  assert.throws(() => loadPairs(`${H}What is a deadlock?,Explain deadlock,\n`), /Row 2.*must be 0 or 1/);
});

test('loadPairs rejects a mistyped label and names the row', () => {
  assert.throws(() => loadPairs(`${H}a b c d e,f g h i j,1\nWhat is a stack?,What is a queue?,yes\n`), /Row 3/);
});

test('loadPairs rejects a row with a missing question', () => {
  assert.throws(() => loadPairs(`${H},Explain deadlock,1\n`), /both questions are required/);
});