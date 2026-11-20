import { Router } from 'express';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { Question } from '../models/Question.js';
import { Vote } from '../models/Vote.js';
import { Answer } from '../models/Answer.js';
import { AnswerVote } from '../models/AnswerVote.js';
import { answersView } from '../answers.js';
import { suggestSimilar } from '../suggest.js';
import { loadBackground } from '../background.js';
import { verifyVoterToken } from '../identity.js';
import { castVote, removeVote, mergeVotes, unmergeVotes, voteCounts, removeQuestion } from '../voting.js';
import { listQuestions } from '../broadcast.js';
import { SlidingWindowLimiter, roomCreateLimiter } from '../middleware/limiters.js';
import { config } from '../config.js';

// No 0/O/1/I so codes are easy to read out loud in a classroom.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{6}$/;

const newCode = () =>
  Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Wrap async handlers so a rejected promise becomes a 500 instead of an unhandled rejection.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createRoomsRouter({ broadcast }) {
  const router = Router();
  const postLimiter = new SlidingWindowLimiter(config.questionsPerMinute, 60_000);
  const background = loadBackground(config.backgroundCsv);

  // ---------- helpers ----------
  const bad = (res, msg, status = 400) => res.status(status).json({ error: msg });

  function loadRoom(select) {
    return wrap(async (req, res, next) => {
      const code = String(req.params.code ?? '').toUpperCase();
      if (!CODE_RE.test(code)) return bad(res, 'Invalid room code.');
      const query = Room.findOne({ code });
      if (select) query.select(select);
      const room = await query;
      if (!room) return bad(res, 'Room not found.', 404);
      req.room = room;
      next();
    });
  }

  // The voter id comes from a server-signed token, never from the request body, so it
  // cannot be invented. Runs before any database lookup, so bad requests cost nothing.
  const requireVoter = (req, res, next) => {
    const voterId = verifyVoterToken(req.get('x-voter-token'));
    if (!voterId) return bad(res, 'Missing or invalid voter token.', 401);
    req.voterId = voterId;
    next();
  };

  const requireMod = wrap(async (req, res, next) => {
    const token = req.get('x-mod-token');
    if (!token || !safeEqual(token, req.room.modToken)) return bad(res, 'Moderator key required.', 403);
    next();
  });

  function loadQuestion(req, res, next, id) {
    if (!mongoose.isValidObjectId(id)) return bad(res, 'Invalid question id.');
    req.questionId = id;
    next();
  }
  router.param('qid', loadQuestion);

  const findQuestionInRoom = (req) => Question.findOne({ _id: req.questionId, roomCode: req.room.code });

  // ---------- rooms ----------
  router.post('/', roomCreateLimiter, wrap(async (req, res) => {
    const title = String(req.body?.title ?? '').trim();
    if (title.length < 3 || title.length > 80) return bad(res, 'Title must be 3-80 characters.');
    const modToken = crypto.randomBytes(18).toString('base64url');
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const room = await Room.create({ code: newCode(), title, modToken });
        return res.status(201).json({ code: room.code, title: room.title, modToken });
      } catch (err) {
        if (err?.code !== 11000) throw err; // code collision: try another
      }
    }
    return bad(res, 'Could not allocate a room code, try again.', 503);
  }));

  router.get('/:code', loadRoom(), (req, res) => {
    res.json({ code: req.room.code, title: req.room.title });
  });

  // ---------- reading ----------
  router.get('/:code/questions', loadRoom(), wrap(async (req, res) => {
    res.json({ questions: await listQuestions(req.room.code) });
  }));

  // Which questions this voter has voted on. Kept separate from the broadcast
  // because the broadcast goes to everyone and cannot be personalised.
  router.get('/:code/my-votes', requireVoter, loadRoom(), wrap(async (req, res) => {
    const votes = await Vote.find({ roomCode: req.room.code, voterId: req.voterId }).select('questionId').lean();
    res.json({ questionIds: votes.map((v) => String(v.questionId)) });
  }));

  // ---------- duplicate suggestions ----------
  // Called while the user types. Suggests, never merges: a wrong automatic merge
  // would hide someone's real doubt.
  router.post('/:code/similar', loadRoom(), wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (text.length < 5) return res.json({ similar: [] });
    const [open, counts] = await Promise.all([
      Question.find({ roomCode: req.room.code, mergedInto: null, status: 'open' })
        .select('text')
        .limit(config.maxQuestionsPerRoom)
        .lean(),
      voteCounts(req.room.code),
    ]);
    const existing = open.map((q) => ({ id: String(q._id), text: q.text, votes: counts.get(String(q._id)) ?? 0 }));
    const similar = suggestSimilar(text, existing, { background, threshold: config.similarityThreshold }).map((q) => ({
      ...q,
      similarity: Math.round(q.similarity * 100) / 100,
    }));
    res.json({ similar, threshold: config.similarityThreshold });
  }));

  // ---------- writing ----------
  router.post('/:code/questions', requireVoter, loadRoom(), wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim().replace(/\s+/g, ' ');
    if (text.length < 5 || text.length > 300) return bad(res, 'Question must be 5-300 characters.');
    if (!postLimiter.take(`${req.room.code}:${req.voterId}`)) {
      return bad(res, `Slow down: at most ${config.questionsPerMinute} questions per minute.`, 429);
    }
    const count = await Question.countDocuments({ roomCode: req.room.code });
    if (count >= config.maxQuestionsPerRoom) return bad(res, 'This room is full.', 409);

    const q = await Question.create({ roomCode: req.room.code, text, authorId: req.voterId });
    broadcast(req.room.code);
    res.status(201).json({ id: String(q._id) });
  }));

  router.post('/:code/questions/:qid/vote', requireVoter, loadRoom(), wrap(async (req, res) => {
    const q = await findQuestionInRoom(req).select('mergedInto');
    if (!q) return bad(res, 'Question not found.', 404);
    if (q.mergedInto) return bad(res, 'This question was merged; vote on the main one.', 409);
    const result = await castVote({ roomCode: req.room.code, questionId: q._id, voterId: req.voterId });
    if (result.changed) broadcast(req.room.code);
    res.json({ voted: true, ...result });
  }));

  router.delete('/:code/questions/:qid/vote', requireVoter, loadRoom(), wrap(async (req, res) => {
    const q = await findQuestionInRoom(req).select('_id');
    if (!q) return bad(res, 'Question not found.', 404);
    const result = await removeVote({ roomCode: req.room.code, questionId: q._id, voterId: req.voterId });
    if (result.changed) broadcast(req.room.code);
    res.json({ voted: false, ...result });
  }));

  // ---------- moderator ----------
  const modRoom = loadRoom('+modToken');

  router.post('/:code/questions/:qid/merge', modRoom, requireMod, wrap(async (req, res) => {
    const targetId = req.body?.targetId;
    if (!mongoose.isValidObjectId(targetId)) return bad(res, 'Invalid targetId.');
    if (String(targetId) === String(req.questionId)) return bad(res, 'Cannot merge a question into itself.');
    const [source, target] = await Promise.all([
      findQuestionInRoom(req),
      Question.findOne({ _id: targetId, roomCode: req.room.code }),
    ]);
    if (!source || !target) return bad(res, 'Question not found.', 404);
    if (target.mergedInto) return bad(res, 'Target is itself merged into another question.', 409);
    // A question that already has merged children cannot become a child: keep the tree one level deep.
    const hasChildren = await Question.exists({ mergedInto: source._id });
    if (hasChildren) return bad(res, 'Un-merge its duplicates first.', 409);
    if (source.mergedInto) return bad(res, 'Already merged.', 409);

    source.mergedInto = target._id;
    await source.save();
    await mergeVotes({ sourceId: source._id, targetId: target._id });
    broadcast(req.room.code);
    res.json({ ok: true });
  }));

  // "Split": take a merged question back out as its own question.
  router.post('/:code/questions/:qid/unmerge', modRoom, requireMod, wrap(async (req, res) => {
    const q = await findQuestionInRoom(req);
    if (!q) return bad(res, 'Question not found.', 404);
    if (!q.mergedInto) return bad(res, 'Not merged.', 409);
    const targetId = q.mergedInto;
    q.mergedInto = null;
    await q.save();
    await unmergeVotes({ sourceId: q._id, targetId });
    broadcast(req.room.code);
    res.json({ ok: true });
  }));

  // Remove a question outright (spam, off-topic, abusive). Votes are cleaned up in removeQuestion.
  router.delete('/:code/questions/:qid', modRoom, requireMod, wrap(async (req, res) => {
    const q = await findQuestionInRoom(req);
    if (!q) return bad(res, 'Question not found.', 404);
    await removeQuestion({ question: q });
    broadcast(req.room.code);
    res.json({ ok: true });
  }));

  router.post('/:code/questions/:qid/answered', modRoom, requireMod, wrap(async (req, res) => {
    const answered = Boolean(req.body?.answered);
    const q = await Question.findOneAndUpdate(
      { _id: req.questionId, roomCode: req.room.code },
      { $set: { status: answered ? 'answered' : 'open' } },
      { new: true }
    );
    if (!q) return bad(res, 'Question not found.', 404);
    broadcast(req.room.code);
    res.json({ ok: true, status: q.status });
  }));

  // ---------- peer answers ----------
  // Anyone in the room can answer. Others vote on answers. The asker (or the moderator)
  // accepts one, which marks the question answered. Author ids never leave the server.
  const answerLimiter = new SlidingWindowLimiter(config.answersPerMinute, 60_000);

  router.param('aid', (req, res, next, id) => {
    if (!mongoose.isValidObjectId(id)) return bad(res, 'Invalid answer id.');
    req.answerId = id;
    next();
  });

  const findAnswerInRoom = (req) => Answer.findOne({ _id: req.answerId, roomCode: req.room.code });

  // Reading is open to anyone with the room code; a token only adds the personal flags.
  const optionalVoter = (req, res, next) => {
    req.voterId = verifyVoterToken(req.get('x-voter-token')) || null;
    next();
  };

  // For actions open to a voter OR the moderator: a valid voter token, or at least a
  // moderator header (its value is checked against the room afterwards by isModRequest).
  const needsIdentity = (req, res, next) => {
    req.voterId = verifyVoterToken(req.get('x-voter-token')) || null;
    if (!req.voterId && !req.get('x-mod-token')) return bad(res, 'Missing or invalid voter token.', 401);
    next();
  };

  const isModRequest = (req) => {
    const token = req.get('x-mod-token');
    return Boolean(token) && safeEqual(token, req.room.modToken);
  };

  // Tell clients with this question's answers open to re-fetch (also its parent, if merged).
  function answersChanged(roomCode, question) {
    const ids = [question._id];
    if (question.mergedInto) ids.push(question.mergedInto);
    broadcast.answersChanged(roomCode, ids);
  }

  router.get('/:code/questions/:qid/answers', optionalVoter, loadRoom(), wrap(async (req, res) => {
    const q = await findQuestionInRoom(req);
    if (!q) return bad(res, 'Question not found.', 404);
    const answers = await answersView(q, req.voterId);
    res.json({
      answers,
      canAccept: Boolean(req.voterId) && q.authorId === req.voterId,
      merged: Boolean(q.mergedInto),
    });
  }));

  router.post('/:code/questions/:qid/answers', requireVoter, loadRoom(), wrap(async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (text.length < 3 || text.length > 1000) return bad(res, 'Answer must be 3-1000 characters.');
    const q = await findQuestionInRoom(req);
    if (!q) return bad(res, 'Question not found.', 404);
    if (q.mergedInto) return bad(res, 'This question was merged; answer the main one.', 409);
    if (!answerLimiter.take(`${req.room.code}:${req.voterId}`)) {
      return bad(res, `Slow down: at most ${config.answersPerMinute} answers per minute.`, 429);
    }
    const count = await Answer.countDocuments({ questionId: q._id });
    if (count >= config.maxAnswersPerQuestion) return bad(res, 'This question has enough answers.', 409);

    const a = await Answer.create({ roomCode: req.room.code, questionId: q._id, authorId: req.voterId, text });
    answersChanged(req.room.code, q);
    broadcast(req.room.code); // answer counts changed
    res.status(201).json({ id: String(a._id) });
  }));

  async function setAnswerVote(req, res, on) {
    const a = await findAnswerInRoom(req);
    if (!a) return bad(res, 'Answer not found.', 404);
    if (a.authorId === req.voterId) return bad(res, 'You cannot vote on your own answer.', 403);
    let changed = true;
    if (on) {
      try {
        await AnswerVote.create({ roomCode: req.room.code, answerId: a._id, voterId: req.voterId });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        changed = false; // already voted: idempotent
      }
    } else {
      const r = await AnswerVote.deleteOne({ roomCode: req.room.code, answerId: a._id, voterId: req.voterId });
      changed = r.deletedCount > 0;
    }
    const votes = await AnswerVote.countDocuments({ answerId: a._id });
    if (changed) {
      const q = await Question.findById(a.questionId).select('mergedInto');
      answersChanged(req.room.code, q ?? { _id: a.questionId });
    }
    res.json({ voted: on, changed, votes });
  }

  router.post('/:code/answers/:aid/vote', requireVoter, loadRoom(), wrap((req, res) => setAnswerVote(req, res, true)));
  router.delete('/:code/answers/:aid/vote', requireVoter, loadRoom(), wrap((req, res) => setAnswerVote(req, res, false)));

  // Delete an answer: its author or the moderator.
  router.delete('/:code/answers/:aid', needsIdentity, modRoom, wrap(async (req, res) => {
    const a = await findAnswerInRoom(req);
    if (!a) return bad(res, 'Answer not found.', 404);
    const mine = Boolean(req.voterId) && a.authorId === req.voterId;
    if (!mine && !isModRequest(req)) return bad(res, 'Only the author or the moderator can delete this answer.', 403);

    await AnswerVote.deleteMany({ answerId: a._id });
    await Answer.deleteOne({ _id: a._id });
    // If it was the accepted answer, the question goes back to open.
    await Question.updateOne(
      { _id: a.questionId, acceptedAnswerId: a._id },
      { $set: { acceptedAnswerId: null, status: 'open' } }
    );
    const q = await Question.findById(a.questionId).select('mergedInto');
    answersChanged(req.room.code, q ?? { _id: a.questionId });
    broadcast(req.room.code);
    res.json({ ok: true });
  }));

  // Accept / un-accept: the asker or the moderator.
  // Returns the question, or null after it has already sent an error response.
  async function loadForAccept(req, res) {
    const q = await findQuestionInRoom(req);
    if (!q) { bad(res, 'Question not found.', 404); return null; }
    const asker = Boolean(req.voterId) && q.authorId === req.voterId;
    if (!asker && !isModRequest(req)) {
      bad(res, 'Only the person who asked, or the moderator, can accept an answer.', 403);
      return null;
    }
    if (q.mergedInto) { bad(res, 'This question was merged; accept on the main one.', 409); return null; }
    return q;
  }

  router.post('/:code/questions/:qid/accepted', needsIdentity, modRoom, wrap(async (req, res) => {
    const q = await loadForAccept(req, res);
    if (!q) return;
    const answerId = req.body?.answerId;
    if (!mongoose.isValidObjectId(answerId)) return bad(res, 'Invalid answerId.');
    // Only answers given directly to this question can be accepted, not those inherited from merged duplicates.
    const a = await Answer.findOne({ _id: answerId, roomCode: req.room.code, questionId: q._id });
    if (!a) return bad(res, 'Answer not found on this question.', 404);
    q.acceptedAnswerId = a._id;
    q.status = 'answered';
    await q.save();
    answersChanged(req.room.code, q);
    broadcast(req.room.code);
    res.json({ ok: true, acceptedAnswerId: String(a._id) });
  }));

  router.delete('/:code/questions/:qid/accepted', needsIdentity, modRoom, wrap(async (req, res) => {
    const q = await loadForAccept(req, res);
    if (!q) return;
    q.acceptedAnswerId = null;
    q.status = 'open';
    await q.save();
    answersChanged(req.room.code, q);
    broadcast(req.room.code);
    res.json({ ok: true });
  }));

  return router;
}