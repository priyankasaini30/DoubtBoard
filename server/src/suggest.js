// Duplicate suggestion, kept free of any database code so it can be unit tested.
import { TfidfScorer, findSimilar } from './similarity.js';

// existing: [{ id, text, ... }]. background: extra questions used only to fit IDF.
//
// Why a background corpus: IDF fitted on a room with 2-3 questions is nearly flat, so
// common words are not down-weighted and real duplicates score low (the first questions
// of a session would almost never get a suggestion). Seeding IDF with the labelled
// evaluation questions also makes production scoring match what `npm run eval` measures.
export function suggestSimilar(text, existing, { background = [], threshold, topK = 3 }) {
  const scorer = new TfidfScorer().fit([...background, ...existing.map((q) => q.text), text]);
  return findSimilar(scorer, text, existing, threshold, topK);
}
