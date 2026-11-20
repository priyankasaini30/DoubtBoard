// Time-decayed ranking, so an old popular question does not stay on top forever.
//
//   score = (votes + 1) / (ageHours + 2) ^ gravity
//
// The +1 lets a brand-new question with no votes still appear near the top.
// The +2 stops a question that is seconds old from getting an enormous score.
// Higher gravity means faster decay. Answered questions always sort below open ones.

export const DEFAULT_GRAVITY = 1.5;

export function rankScore(votes, createdAt, now = Date.now(), gravity = DEFAULT_GRAVITY) {
  const ageHours = Math.max(0, (now - new Date(createdAt).getTime()) / 3_600_000);
  return (votes + 1) / Math.pow(ageHours + 2, gravity);
}

// Answers: the accepted one first, then most votes, then oldest first (older answers have
// had more time to collect votes, and it keeps the order stable while people read).
export function rankAnswers(answers) {
  return [...answers].sort(
    (a, b) =>
      Number(b.accepted) - Number(a.accepted) ||
      b.votes - a.votes ||
      new Date(a.createdAt) - new Date(b.createdAt)
  );
}

export function rankQuestions(questions, now = Date.now(), gravity = DEFAULT_GRAVITY) {
  return questions
    .map((q) => ({ ...q, score: rankScore(q.votes, q.createdAt, now, gravity) }))
    .sort((a, b) => {
      const aDone = a.status === 'answered' ? 1 : 0;
      const bDone = b.status === 'answered' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.createdAt) - new Date(a.createdAt); // tie: newest first
    });
}