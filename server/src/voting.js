// Vote logic. All integrity rules live here so routes stay thin.
//
// The Vote collection is the single source of truth. Counts are never cached on the
// Question: a cached counter written with last-write-wins can end up stale when many
// votes arrive together, whereas counting Vote documents is always correct.
import { Vote } from './models/Vote.js';
import { Question } from './models/Question.js';
import { Answer } from './models/Answer.js';
import { AnswerVote } from './models/AnswerVote.js';

const DUPLICATE_KEY = 11000;

// Idempotent: voting twice is a no-op, not an error and not a second vote.
// The unique index (roomCode, questionId, voterId) makes this safe under retries,
// double clicks and parallel requests. `changed` tells the caller whether anything happened.
export async function castVote({ roomCode, questionId, voterId }) {
  let changed = true;
  try {
    await Vote.create({ roomCode, questionId, voterId });
  } catch (err) {
    if (err?.code !== DUPLICATE_KEY) throw err;
    changed = false;
  }
  return { changed, votes: await Vote.countDocuments({ questionId }) };
}

export async function removeVote({ roomCode, questionId, voterId }) {
  const res = await Vote.deleteOne({ roomCode, questionId, voterId });
  return { changed: res.deletedCount > 0, votes: await Vote.countDocuments({ questionId }) };
}

// Vote counts for every question in a room, as Map<questionId string, number>.
// One indexed aggregation, used when building the ranked list.
export async function voteCounts(roomCode) {
  const rows = await Vote.aggregate([
    { $match: { roomCode } },
    { $group: { _id: '$questionId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

// Moderator merge: move votes from `sourceId` onto `targetId`.
// A voter who already voted on the target keeps their source vote where it is
// (it just stops counting), so nobody gets two votes on the merged question.
export async function mergeVotes({ sourceId, targetId }) {
  const votes = await Vote.find({ questionId: sourceId }).lean();
  for (const v of votes) {
    try {
      await Vote.updateOne({ _id: v._id }, { $set: { questionId: targetId, originQuestionId: sourceId } });
    } catch (err) {
      if (err?.code !== DUPLICATE_KEY) throw err;
    }
  }
}

// Moderator removal (spam, off-topic, abusive). Votes are cleaned up consistently:
//  - duplicates that were merged INTO this question get their votes back and become
//    ordinary open questions again;
//  - if this question was itself merged into another, the votes it had moved there leave with it.
export async function removeQuestion({ question }) {
  const id = question._id;
  if (question.mergedInto) await unmergeVotes({ sourceId: id, targetId: question.mergedInto });
  const children = await Question.find({ mergedInto: id }).select('_id').lean();
  for (const child of children) {
    await Question.updateOne({ _id: child._id }, { $set: { mergedInto: null } });
    await unmergeVotes({ sourceId: child._id, targetId: id });
  }
  // Its own answers (and their votes) go with it; answers of duplicates that were merged in
  // stay with those duplicates, which were just turned back into ordinary questions.
  const answerIds = await Answer.distinct('_id', { questionId: id });
  await AnswerVote.deleteMany({ answerId: { $in: answerIds } });
  await Answer.deleteMany({ questionId: id });
  await Vote.deleteMany({ questionId: id });
  await Question.deleteOne({ _id: id });
}

// Undo a merge: give back the votes that came from `sourceId`.
export async function unmergeVotes({ sourceId, targetId }) {
  await Vote.updateMany(
    { questionId: targetId, originQuestionId: sourceId },
    { $set: { questionId: sourceId, originQuestionId: null } }
  );
}