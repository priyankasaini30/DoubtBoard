// Integration tests against a REAL MongoDB. They prove the vote-integrity claims
// (unique index, parallel votes, merge / split) end to end.
//
// Skipped unless MONGO_TEST_URI is set. Use a throwaway database: the test drops it.
//   MONGO_TEST_URI=mongodb://127.0.0.1:27017/doubtboard_test npm test
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { Room } from '../src/models/Room.js';
import { Question } from '../src/models/Question.js';
import { Vote } from '../src/models/Vote.js';
import { Answer } from '../src/models/Answer.js';
import { AnswerVote } from '../src/models/AnswerVote.js';

const URI = process.env.MONGO_TEST_URI;
const skip = URI ? false : 'set MONGO_TEST_URI to a throwaway MongoDB whose name contains "test"';

let io;
let base;

before(async () => {
  if (!URI) return;
  const dbName = new URL(URI).pathname.slice(1);
  if (!dbName.includes('test')) throw new Error('Refusing to run: the database name must contain "test" (it gets dropped).');
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await Promise.all([Room.init(), Question.init(), Vote.init(), Answer.init(), AnswerVote.init()]); // build the unique indexes
  const app = createApp();
  io = app.io;
  await new Promise((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  if (!URI) return;
  await new Promise((resolve) => io.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function call(path, { method = 'GET', body, token, mod } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-voter-token': token } : {}),
      ...(mod ? { 'x-mod-token': mod } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const newVoter = async () => (await call('/api/voters', { method: 'POST' })).data.voterToken;

async function newRoom() {
  const { status, data } = await call('/api/rooms', { method: 'POST', body: { title: 'Integration room' } });
  assert.equal(status, 201);
  return { code: data.code, mod: data.modToken };
}

async function ask(code, token, text) {
  const { status, data } = await call(`/api/rooms/${code}/questions`, { method: 'POST', token, body: { text } });
  assert.equal(status, 201);
  return data.id;
}

const vote = (code, id, token) => call(`/api/rooms/${code}/questions/${id}/vote`, { method: 'POST', token });
const list = async (code) => (await call(`/api/rooms/${code}/questions`)).data.questions;
const votesOf = (questions, id) => questions.find((q) => q.id === id)?.votes;

test('a forged voter token cannot vote', { skip }, async () => {
  const { code } = await newRoom();
  const id = await ask(code, await newVoter(), 'What is a deadlock in OS?');
  const res = await vote(code, id, 'invented-voter.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(res.status, 401);
  assert.equal(votesOf(await list(code), id), 0);
});

test('one voter voting 20 times in parallel counts exactly once', { skip }, async () => {
  const { code } = await newRoom();
  const id = await ask(code, await newVoter(), 'What is a semaphore?');
  const voter = await newVoter();
  const results = await Promise.all(Array.from({ length: 20 }, () => vote(code, id, voter)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(votesOf(await list(code), id), 1);
  assert.equal(await Vote.countDocuments({ questionId: id }), 1);
});

test('30 distinct voters voting in parallel all count', { skip }, async () => {
  const { code } = await newRoom();
  const id = await ask(code, await newVoter(), 'What is paging in OS?');
  const voters = await Promise.all(Array.from({ length: 30 }, newVoter));
  const results = await Promise.all(voters.map((v) => vote(code, id, v)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(votesOf(await list(code), id), 30);
});

test('removing a vote is idempotent too', { skip }, async () => {
  const { code } = await newRoom();
  const id = await ask(code, await newVoter(), 'What is virtual memory?');
  const voter = await newVoter();
  await vote(code, id, voter);
  const del = () => call(`/api/rooms/${code}/questions/${id}/vote`, { method: 'DELETE', token: voter });
  await Promise.all([del(), del(), del()]);
  assert.equal(votesOf(await list(code), id), 0);
});

test('moderator actions need the moderator key', { skip }, async () => {
  const { code } = await newRoom();
  const token = await newVoter();
  const a = await ask(code, token, 'What is a primary key?');
  const b = await ask(code, token, 'Define primary key in DBMS');
  const res = await call(`/api/rooms/${code}/questions/${a}/merge`, { method: 'POST', body: { targetId: b } });
  assert.equal(res.status, 403);
  const wrong = await call(`/api/rooms/${code}/questions/${a}/merge`, { method: 'POST', body: { targetId: b }, mod: 'wrong-key' });
  assert.equal(wrong.status, 403);
});

test('merge moves votes without double counting, and split restores them', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [a, b, c] = await Promise.all([newVoter(), newVoter(), newVoter()]);
  const q1 = await ask(code, a, 'What is normalization in DBMS?');
  const q2 = await ask(code, a, 'Explain database normalization');
  // q1 voted by A and B; q2 voted by B and C. B voted on both.
  await Promise.all([vote(code, q1, a), vote(code, q1, b), vote(code, q2, b), vote(code, q2, c)]);

  const merged = await call(`/api/rooms/${code}/questions/${q1}/merge`, { method: 'POST', body: { targetId: q2 }, mod });
  assert.equal(merged.status, 200);
  let questions = await list(code);
  assert.equal(questions.length, 1, 'merged question is hidden');
  assert.equal(questions[0].id, q2);
  assert.equal(questions[0].votes, 3, 'A, B and C each count once');
  assert.equal(questions[0].merged.length, 1);

  const blocked = await vote(code, q1, await newVoter());
  assert.equal(blocked.status, 409, 'cannot vote on a merged question');

  const split = await call(`/api/rooms/${code}/questions/${q1}/unmerge`, { method: 'POST', mod });
  assert.equal(split.status, 200);
  questions = await list(code);
  assert.equal(questions.length, 2);
  assert.equal(votesOf(questions, q1), 2, 'A comes back; B never left');
  assert.equal(votesOf(questions, q2), 2, 'B and C stay');
});

test('a moderator can remove a question and its votes; others cannot', { skip }, async () => {
  const { code, mod } = await newRoom();
  const token = await newVoter();
  const id = await ask(code, token, 'Buy cheap watches at my website');
  await vote(code, id, await newVoter());
  const path = `/api/rooms/${code}/questions/${id}`;
  assert.equal((await call(path, { method: 'DELETE', token })).status, 403);
  assert.equal((await call(path, { method: 'DELETE', mod: 'wrong-key' })).status, 403);
  assert.equal((await call(path, { method: 'DELETE', mod })).status, 200);
  assert.equal((await list(code)).length, 0);
  assert.equal(await Vote.countDocuments({ questionId: id }), 0);
  assert.equal((await call(path, { method: 'DELETE', mod })).status, 404, 'already gone');
});

test('removing a question that others were merged into gives those duplicates their votes back', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [a, b] = await Promise.all([newVoter(), newVoter()]);
  const q1 = await ask(code, a, 'What is a semaphore?');
  const q2 = await ask(code, a, 'How do semaphores work?');
  await Promise.all([vote(code, q1, a), vote(code, q2, b)]);
  await call(`/api/rooms/${code}/questions/${q1}/merge`, { method: 'POST', body: { targetId: q2 }, mod });
  assert.equal(votesOf(await list(code), q2), 2);

  const res = await call(`/api/rooms/${code}/questions/${q2}`, { method: 'DELETE', mod });
  assert.equal(res.status, 200);
  const questions = await list(code);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, q1, 'the merged duplicate is an ordinary question again');
  assert.equal(questions[0].votes, 1, 'it keeps its own vote');
});

test('removing a merged duplicate takes its votes off the question it was merged into', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [a, b] = await Promise.all([newVoter(), newVoter()]);
  const keep = await ask(code, a, 'What is paging?');
  const spam = await ask(code, a, 'Explain paging in OS');
  await Promise.all([vote(code, keep, b), vote(code, spam, a)]);
  await call(`/api/rooms/${code}/questions/${spam}/merge`, { method: 'POST', body: { targetId: keep }, mod });
  assert.equal(votesOf(await list(code), keep), 2);

  assert.equal((await call(`/api/rooms/${code}/questions/${spam}`, { method: 'DELETE', mod })).status, 200);
  const questions = await list(code);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].votes, 1, 'only the original voter remains');
});

test('similar suggests the existing question and reports its votes', { skip }, async () => {
  const { code } = await newRoom();
  const id = await ask(code, await newVoter(), 'What is a deadlock in OS?');
  await vote(code, id, await newVoter());
  const { status, data } = await call(`/api/rooms/${code}/similar`, { method: 'POST', body: { text: 'Explain deadlock in operating systems' } });
  assert.equal(status, 200);
  assert.equal(data.similar.length, 1);
  assert.equal(data.similar[0].id, id);
  assert.equal(data.similar[0].votes, 1);
});

// ---------- peer answers ----------
// Rooms are shared between tests to stay under the per-IP room-creation limit (20/hour).
const answer = (code, qid, token, text = 'It is a synchronisation primitive.') =>
  call(`/api/rooms/${code}/questions/${qid}/answers`, { method: 'POST', token, body: { text } });
const answersOf = (code, qid, token) => call(`/api/rooms/${code}/questions/${qid}/answers`, { token });
const voteAnswer = (code, aid, token, method = 'POST') => call(`/api/rooms/${code}/answers/${aid}/vote`, { method, token });
const accept = (code, qid, aid, opts) =>
  call(`/api/rooms/${code}/questions/${qid}/accepted`, { method: 'POST', body: { answerId: aid }, ...opts });

test('answers: ranked by votes, author ids hidden, own answer not votable, votes count once', { skip }, async () => {
  const { code } = await newRoom();
  const [asker, a1, a2, v1, v2] = await Promise.all([newVoter(), newVoter(), newVoter(), newVoter(), newVoter()]);
  const q = await ask(code, asker, 'What is a semaphore?');

  assert.equal((await call(`/api/rooms/${code}/questions/${q}/answers`, { method: 'POST', body: { text: 'no token here' } })).status, 401);
  assert.equal((await answer(code, q, a1, 'x')).status, 400, 'too short');

  const first = (await answer(code, q, a1, 'A counter used to control access.')).data.id;
  const second = (await answer(code, q, a2, 'A signalling mechanism between threads.')).data.id;

  // two voters back the second answer, one of them in parallel 10 times
  await Promise.all([...Array.from({ length: 10 }, () => voteAnswer(code, second, v1)), voteAnswer(code, second, v2)]);
  assert.equal(await AnswerVote.countDocuments({ answerId: second }), 2);

  const own = await voteAnswer(code, first, a1);
  assert.equal(own.status, 403, 'cannot vote on your own answer');

  const { data } = await answersOf(code, q, v1);
  assert.deepEqual(data.answers.map((x) => x.id), [second, first], 'most votes first');
  assert.equal(data.answers[0].votes, 2);
  assert.equal(data.answers[0].voted, true, 'v1 sees their own vote');
  assert.equal(data.canAccept, false);
  assert.ok(data.answers.every((x) => !('authorId' in x)), 'author ids never sent');
  assert.equal((await answersOf(code, q, a1)).data.answers.find((x) => x.id === first).mine, true);

  // un-voting is idempotent
  await Promise.all([voteAnswer(code, second, v1, 'DELETE'), voteAnswer(code, second, v1, 'DELETE')]);
  assert.equal(await AnswerVote.countDocuments({ answerId: second }), 1);

  const qs = await list(code);
  assert.equal(qs.find((x) => x.id === q).answerCount, 2);
});

test('answers: only the asker or the moderator accepts; accepting marks answered and puts it first', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [asker, helper, stranger] = await Promise.all([newVoter(), newVoter(), newVoter()]);
  const q = await ask(code, asker, 'What is a mutex?');
  const a = (await answer(code, q, helper, 'A lock only one thread can hold.')).data.id;
  const b = (await answer(code, q, stranger, 'Something like a semaphore.')).data.id;
  await voteAnswer(code, b, helper); // b leads on votes

  assert.equal((await accept(code, q, a, { token: stranger })).status, 403);
  assert.equal((await accept(code, q, a, { token: helper })).status, 403, 'answer author cannot accept their own');
  assert.equal((await accept(code, q, a, { mod: 'wrong-key' })).status, 403);
  assert.equal((await accept(code, q, a, {})).status, 401);

  assert.equal((await accept(code, q, a, { token: asker })).status, 200);
  let view = (await answersOf(code, q, asker)).data;
  assert.equal(view.answers[0].id, a, 'accepted first even with fewer votes');
  assert.equal(view.answers[0].accepted, true);
  assert.equal(view.canAccept, true);
  let row = (await list(code)).find((x) => x.id === q);
  assert.equal(row.status, 'answered');
  assert.equal(row.solved, true);

  // moderator can change the accepted answer, and un-accept reopens
  assert.equal((await accept(code, q, b, { mod })).status, 200);
  assert.equal((await answersOf(code, q)).data.answers[0].id, b);
  const clear = await call(`/api/rooms/${code}/questions/${q}/accepted`, { method: 'DELETE', token: asker });
  assert.equal(clear.status, 200);
  row = (await list(code)).find((x) => x.id === q);
  assert.equal(row.status, 'open');
  assert.equal(row.solved, false);

  // an answer from another question cannot be accepted here
  const other = await ask(code, asker, 'What is a spinlock?');
  const foreign = (await answer(code, other, helper, 'A lock that busy-waits.')).data.id;
  assert.equal((await accept(code, q, foreign, { token: asker })).status, 404);
});

test('answers: delete is author or moderator; deleting the accepted answer reopens the question', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [asker, author, other] = await Promise.all([newVoter(), newVoter(), newVoter()]);
  const q = await ask(code, asker, 'What is a thread?');
  const a = (await answer(code, q, author, 'A unit of execution inside a process.')).data.id;
  await voteAnswer(code, a, other);
  await accept(code, q, a, { token: asker });
  const path = `/api/rooms/${code}/answers/${a}`;

  assert.equal((await call(path, { method: 'DELETE', token: other })).status, 403);
  assert.equal((await call(path, { method: 'DELETE', mod: 'wrong-key' })).status, 403);
  assert.equal((await call(path, { method: 'DELETE' })).status, 401);
  assert.equal((await call(path, { method: 'DELETE', token: author })).status, 200);

  assert.equal(await Answer.countDocuments({ _id: a }), 0);
  assert.equal(await AnswerVote.countDocuments({ answerId: a }), 0, 'its votes go too');
  const row = (await list(code)).find((x) => x.id === q);
  assert.equal(row.status, 'open', 'no accepted answer any more');
  assert.equal(row.solved, false);

  const b = (await answer(code, q, other, 'Lightweight process.')).data.id;
  assert.equal((await call(`/api/rooms/${code}/answers/${b}`, { method: 'DELETE', mod })).status, 200);
  assert.equal((await call(`/api/rooms/${code}/answers/${b}`, { method: 'DELETE', mod })).status, 404);
});

test('answers: merge shows duplicates answers on the main question; split gives them back', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [asker, helper, other] = await Promise.all([newVoter(), newVoter(), newVoter()]);
  const main = await ask(code, asker, 'What is normalization in DBMS?');
  const dup = await ask(code, asker, 'Explain database normalization');
  const ownAnswer = (await answer(code, main, helper, 'Organising tables to reduce redundancy.')).data.id;
  const dupAnswer = (await answer(code, dup, other, 'Splitting data so each fact is stored once.')).data.id;

  await call(`/api/rooms/${code}/questions/${dup}/merge`, { method: 'POST', body: { targetId: main }, mod });
  const view = (await answersOf(code, main, asker)).data;
  assert.equal(view.answers.length, 2);
  assert.equal(view.answers.find((x) => x.id === dupAnswer).fromMerged, true);
  assert.equal(view.answers.find((x) => x.id === ownAnswer).fromMerged, false);
  assert.equal((await list(code)).find((x) => x.id === main).answerCount, 2);

  assert.equal((await answer(code, dup, helper)).status, 409, 'cannot answer a merged question');
  assert.equal((await accept(code, main, dupAnswer, { token: asker })).status, 404, 'inherited answers cannot be accepted');
  assert.equal((await accept(code, main, ownAnswer, { token: asker })).status, 200);

  await call(`/api/rooms/${code}/questions/${dup}/unmerge`, { method: 'POST', mod });
  assert.equal((await answersOf(code, main, asker)).data.answers.length, 1);
  assert.equal((await answersOf(code, dup, asker)).data.answers[0].id, dupAnswer);
});

test('answers: removing a question deletes its answers and their votes', { skip }, async () => {
  const { code, mod } = await newRoom();
  const [asker, helper, voter] = await Promise.all([newVoter(), newVoter(), newVoter()]);
  const q = await ask(code, asker, 'Buy followers cheap here');
  const a = (await answer(code, q, helper, 'Spam reply to the spam.')).data.id;
  await voteAnswer(code, a, voter);
  assert.equal((await call(`/api/rooms/${code}/questions/${q}`, { method: 'DELETE', mod })).status, 200);
  assert.equal(await Answer.countDocuments({ questionId: q }), 0);
  assert.equal(await AnswerVote.countDocuments({ answerId: a }), 0);
  assert.equal((await answersOf(code, q)).status, 404);
});