// Builds the ranked question list for a room and pushes it to everyone in that room.
import { Question } from './models/Question.js';
import { rankQuestions } from './ranking.js';
import { voteCounts } from './voting.js';
import { answerCounts } from './answers.js';
import { config } from './config.js';

export async function listQuestions(roomCode) {
  const [docs, counts, answerTally] = await Promise.all([
    Question.find({ roomCode }).sort({ createdAt: -1 }).limit(config.maxQuestionsPerRoom).lean(),
    voteCounts(roomCode),
    answerCounts(roomCode),
  ]);

  // Group merged questions under the question they were merged into.
  const mergedByParent = new Map();
  for (const d of docs) {
    if (!d.mergedInto) continue;
    const key = String(d.mergedInto);
    if (!mergedByParent.has(key)) mergedByParent.set(key, []);
    mergedByParent.get(key).push({ id: String(d._id), text: d.text });
  }

  const visible = docs
    .filter((d) => !d.mergedInto)
    .map((d) => {
      const id = String(d._id);
      const merged = mergedByParent.get(id) ?? [];
      return {
        id,
        text: d.text,
        votes: counts.get(id) ?? 0,
        status: d.status,
        createdAt: d.createdAt,
        merged,
        // Answers shown under a question include those of duplicates merged into it.
        answerCount: (answerTally.get(id) ?? 0) + merged.reduce((n, m) => n + (answerTally.get(m.id) ?? 0), 0),
        solved: Boolean(d.acceptedAnswerId),
      };
    });

  return rankQuestions(visible, Date.now(), config.rankGravity);
}

// Many votes arriving together would otherwise trigger one database read and one
// emit each. This coalesces them: at most one broadcast per room per `delayMs`,
// and it always runs after the last change (trailing edge), so clients never miss state.
export function createBroadcaster(io, delayMs = 100) {
  const timers = new Map();

  async function flush(roomCode) {
    timers.delete(roomCode);
    try {
      io.to(roomCode).emit('questions', await listQuestions(roomCode));
    } catch (err) {
      console.error('broadcast failed', roomCode, err.message);
    }
  }

  function broadcast(roomCode) {
    if (timers.has(roomCode)) return; // a flush is already scheduled and will read fresh state
    timers.set(roomCode, setTimeout(() => flush(roomCode), delayMs));
  }

  // Tells clients that have a question's answers open to re-fetch them. No database read here.
  broadcast.answersChanged = (roomCode, questionIds) => {
    io.to(roomCode).emit('answers:changed', { questionIds: questionIds.map(String) });
  };

  return broadcast;
}