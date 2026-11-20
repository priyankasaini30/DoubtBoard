// Duplicate-question similarity for DoubtBoard. Plain JavaScript, no ML libraries.
//
// Two scorers share one interface: score(a, b) -> number in [0, 1].
//   OverlapScorer : Jaccard word overlap (baseline to compare against)
//   TfidfScorer   : TF-IDF cosine on stemmed, stopword-free tokens

const STOPWORDS = new Set(
  `a an the is are was were be been being do does did of in on at to for from by with
and or but if then so as it its this that these those i you we they he she me my
your our can could should would will shall may might what which who whom whose
how why when where explain tell define difference between about please give mean
means meant example examples
types type kinds kind used uses use`.split(/\s+/)
);
// The last line holds generic question-frame words. "What is X and its types?" and "What is Y and
// its types?" share a template, not a topic; without this, that shared word alone made unrelated
// questions look like duplicates (scores of 0.5-0.6 in small rooms).

// Light suffix stripper. Not a full Porter stemmer, but enough for short doubts.
const SUFFIXES = [
  'ization', 'ational', 'ations', 'ation', 'ingly', 'ments', 'ment', 'ness',
  'ities', 'ity', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 's', 'ly',
];

export function stem(word) {
  for (const suf of SUFFIXES) {
    if (word.endsWith(suf) && word.length - suf.length >= 3) {
      word = word.slice(0, -suf.length);
      break;
    }
  }
  // Drop a trailing silent 'e' so "semaphore" and "semaphores" both become "semaphor".
  if (word.endsWith('e') && word.length > 4) word = word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.filter((w) => !STOPWORDS.has(w)).map(stem);
}

export class OverlapScorer {
  score(a, b) {
    const sa = new Set(tokenize(a));
    const sb = new Set(tokenize(b));
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
  }
}

export class TfidfScorer {
  constructor() {
    this.idf = new Map();
    this.defaultIdf = 1;
  }

  // Fit IDF on a corpus of questions (an array of strings).
  fit(corpus) {
    const n = corpus.length;
    const df = new Map();
    for (const doc of corpus) {
      for (const t of new Set(tokenize(doc))) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.idf = new Map();
    // Smoothed IDF, always positive.
    for (const [t, c] of df) this.idf.set(t, Math.log((1 + n) / (1 + c)) + 1);
    this.defaultIdf = Math.log(1 + n) + 1; // unseen term is treated as rare
    return this;
  }

  vector(text) {
    const tf = new Map();
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map();
    for (const [t, c] of tf) vec.set(t, c * (this.idf.get(t) ?? this.defaultIdf));
    return vec;
  }

  score(a, b) {
    const va = this.vector(a);
    const vb = this.vector(b);
    let dot = 0;
    for (const [t, w] of va) dot += w * (vb.get(t) ?? 0);
    let na = 0;
    for (const w of va.values()) na += w * w;
    let nb = 0;
    for (const w of vb.values()) nb += w * w;
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}

// Return up to topK existing items scoring >= threshold, best first.
// `existing` is an array of { id, text, ... }; extra fields are passed through.
export function findSimilar(scorer, newText, existing, threshold, topK = 3) {
  return existing
    .map((q) => ({ ...q, similarity: scorer.score(newText, q.text) }))
    .filter((q) => q.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}