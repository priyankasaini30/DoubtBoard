import test from 'node:test';
import assert from 'node:assert/strict';
import { issueVoter, verifyVoterToken } from '../src/identity.js';

test('a freshly issued token verifies and returns the voter id', () => {
  const { voterId, voterToken } = issueVoter();
  assert.equal(verifyVoterToken(voterToken), voterId);
});

test('two issued identities are different', () => {
  assert.notEqual(issueVoter().voterId, issueVoter().voterId);
});

test('a token with a tampered voter id is rejected', () => {
  const { voterToken } = issueVoter();
  const sig = voterToken.slice(voterToken.lastIndexOf('.'));
  assert.equal(verifyVoterToken(`someone-else${sig}`), null);
});

test('a token with a tampered signature is rejected', () => {
  const { voterToken } = issueVoter();
  const flipped = voterToken.slice(0, -1) + (voterToken.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyVoterToken(flipped), null);
});

test('malformed tokens are rejected, not thrown on', () => {
  for (const bad of [undefined, null, '', '.', 'abc', 'abc.', '.sig', 123, {}, 'x'.repeat(500)]) {
    assert.equal(verifyVoterToken(bad), null);
  }
});
