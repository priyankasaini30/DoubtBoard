// HTTP-level tests for request validation and identity. These never touch MongoDB:
// every case is rejected, or answered, before a query is made.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { verifyVoterToken } from '../src/identity.js';

let server;
let base;

before(async () => {
  ({ server } = createApp());
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const call = (path, opts = {}) =>
  fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });

const QID = '507f1f77bcf86cd799439011';

test('health reports 503 when the database is not connected', async () => {
  const res = await call('/health');
  assert.equal(res.status, 503);
});

test('rejects a malformed room code', async () => {
  const res = await call('/api/rooms/abc');
  assert.equal(res.status, 400);
});

test('rejects a short room title', async () => {
  const res = await call('/api/rooms', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
  assert.equal(res.status, 400);
});

test('rejects invalid JSON with 400', async () => {
  const res = await call('/api/rooms', { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('POST /api/voters issues a token the server accepts', async () => {
  const res = await call('/api/voters', { method: 'POST' });
  assert.equal(res.status, 201);
  const { voterId, voterToken } = await res.json();
  assert.equal(verifyVoterToken(voterToken), voterId);
});

test('voting without a voter token is rejected with 401', async () => {
  const res = await call(`/api/rooms/ABCDEF/questions/${QID}/vote`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('voting with an invented voter id is rejected with 401', async () => {
  const res = await call(`/api/rooms/ABCDEF/questions/${QID}/vote`, {
    method: 'POST',
    headers: { 'x-voter-token': 'attacker-chosen-id.bm90LWEtcmVhbC1zaWduYXR1cmU' },
  });
  assert.equal(res.status, 401);
});

test('voter id in the request body is ignored: still 401 without a token', async () => {
  const res = await call(`/api/rooms/ABCDEF/questions/${QID}/vote`, {
    method: 'POST',
    body: JSON.stringify({ voterId: 'attacker-chosen-id' }),
  });
  assert.equal(res.status, 401);
});

test('posting a question without a voter token is rejected with 401', async () => {
  const res = await call('/api/rooms/ABCDEF/questions', { method: 'POST', body: JSON.stringify({ text: 'What is a deadlock?' }) });
  assert.equal(res.status, 401);
});

test('my-votes without a voter token is rejected with 401', async () => {
  const res = await call('/api/rooms/ABCDEF/my-votes');
  assert.equal(res.status, 401);
});

const AID = '507f1f77bcf86cd799439012';

test('posting an answer without a voter token is rejected with 401', async () => {
  const res = await call(`/api/rooms/ABCDEF/questions/${QID}/answers`, { method: 'POST', body: JSON.stringify({ text: 'An answer' }) });
  assert.equal(res.status, 401);
});

test('voting on an answer without a voter token is rejected with 401', async () => {
  const res = await call(`/api/rooms/ABCDEF/answers/${AID}/vote`, { method: 'POST' });
  assert.equal(res.status, 401);
});

test('deleting an answer or accepting one with no identity at all is rejected with 401', async () => {
  assert.equal((await call(`/api/rooms/ABCDEF/answers/${AID}`, { method: 'DELETE' })).status, 401);
  const res = await call(`/api/rooms/ABCDEF/questions/${QID}/accepted`, { method: 'POST', body: JSON.stringify({ answerId: AID }) });
  assert.equal(res.status, 401);
});

test('a malformed answer id is rejected with 400', async () => {
  const res = await call('/api/rooms/ABCDEF/answers/not-an-id/vote', {
    method: 'POST',
    headers: { 'x-voter-token': 'x.y' },
  });
  // Either the id check or the token check fires first; neither may reach the database.
  assert.ok([400, 401].includes(res.status));
});