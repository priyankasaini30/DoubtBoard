// Reading answers. Writes live in the routes; counts are always derived from the vote
// collection (like question votes), never cached.
import { Answer } from './models/Answer.js';
import { AnswerVote } from './models/AnswerVote.js';
import { Question } from './models/Question.js';
import { rankAnswers } from './ranking.js';

// Number of answers per question in a room, as Map<questionId string, number>.
export async function answerCounts(roomCode) {
  const rows = await Answer.aggregate([
    { $match: { roomCode } },
    { $group: { _id: '$questionId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

// Answers to show under `question`: its own plus those of duplicates merged into it
// (flagged fromMerged). `voterId` (optional) only adds the personal flags voted / mine.
export async function answersView(question, voterId) {
  const children = await Question.find({ mergedInto: question._id }).select('_id').lean();
  const questionIds = [question._id, ...children.map((c) => c._id)];
  const answers = await Answer.find({ questionId: { $in: questionIds } }).lean();
  const answerIds = answers.map((a) => a._id);

  const [tally, votedIds] = await Promise.all([
    AnswerVote.aggregate([
      { $match: { roomCode: question.roomCode, answerId: { $in: answerIds } } },
      { $group: { _id: '$answerId', n: { $sum: 1 } } },
    ]),
    voterId
      ? AnswerVote.distinct('answerId', { roomCode: question.roomCode, voterId, answerId: { $in: answerIds } })
      : [],
  ]);
  const votes = new Map(tally.map((t) => [String(t._id), t.n]));
  const voted = new Set(votedIds.map(String));
  const accepted = question.acceptedAnswerId ? String(question.acceptedAnswerId) : null;

  return rankAnswers(
    answers.map((a) => ({
      id: String(a._id),
      text: a.text,
      createdAt: a.createdAt,
      votes: votes.get(String(a._id)) ?? 0,
      voted: voted.has(String(a._id)),
      mine: Boolean(voterId) && a.authorId === voterId,
      accepted: String(a._id) === accepted,
      fromMerged: String(a.questionId) !== String(question._id),
    }))
  );
}