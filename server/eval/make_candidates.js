// Build a CSV of candidate question pairs for you to label by hand.
//
// Usage:
//   node eval/make_candidates.js questions.txt [--pairs 100] [--out eval/candidates.csv] [--seed 1]
//
// questions.txt: one real question per line (blank lines ignored, duplicates removed).
// Collect 50-60 from classmates, a study group chat, or past exam questions.
//
// The output has an empty is_duplicate column. Open it in Excel / Sheets and fill each
// row with 1 (same doubt) or 0 (different doubt), then save as CSV and run the evaluation.
//
// Why a mix: if you only labelled the pairs that look similar, the evaluation would be
// too easy. So candidates come from three places:
//   - 40% the most similar-looking pairs (likely duplicates, and the tricky near-misses)
//   - 20% moderately similar pairs
//   - 40% random pairs (almost always different, which keeps precision honest)
// Similarity here uses character trigrams, NOT the TF-IDF scorer being evaluated, so the
// scorer does not get to choose its own test questions. Row order is shuffled and the
// bucket is not shown, so it cannot influence your labels.
import { readFileSync, writeFileSync } from 'node:fs';
import { mulberry32 } from '../src/evaluation.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const input = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!input) {
  console.error('Usage: node eval/make_candidates.js questions.txt [--pairs 100] [--out eval/candidates.csv] [--seed 1]');
  process.exit(1);
}
const total = Number(flag('pairs', 100));
const out = flag('out', 'eval/candidates.csv');
const rand = mulberry32(Number(flag('seed', 1)));

const questions = [...new Set(
  readFileSync(input, 'utf8').split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean)
)];
if (questions.length < 10) {
  console.error(`Need at least 10 questions, found ${questions.length}.`);
  process.exit(1);
}

const trigrams = (s) => {
  const t = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
};
const grams = questions.map(trigrams);
const jaccard = (x, y) => {
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter || 1);
};

const all = [];
for (let i = 0; i < questions.length; i++) {
  for (let j = i + 1; j < questions.length; j++) all.push({ i, j, s: jaccard(grams[i], grams[j]) });
}
all.sort((p, q) => q.s - p.s);

const shuffle = (arr) => {
  for (let k = arr.length - 1; k > 0; k--) {
    const m = Math.floor(rand() * (k + 1));
    [arr[k], arr[m]] = [arr[m], arr[k]];
  }
  return arr;
};

const want = Math.min(total, all.length);
const nTop = Math.round(want * 0.4);
const nMid = Math.round(want * 0.2);
const nRand = want - nTop - nMid;

const top = all.slice(0, nTop);
const midPool = all.slice(nTop, Math.max(nTop + nMid, Math.floor(all.length * 0.15)));
const mid = shuffle([...midPool]).slice(0, nMid);
const taken = new Set([...top, ...mid]);
const rest = shuffle(all.filter((p) => !taken.has(p))).slice(0, nRand);

const picked = shuffle([...top, ...mid, ...rest]).map((p) => (rand() < 0.5 ? p : { ...p, i: p.j, j: p.i }));

const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = ['question_a,question_b,is_duplicate', ...picked.map((p) => `${esc(questions[p.i])},${esc(questions[p.j])},`)].join('\n') + '\n';
writeFileSync(out, csv);

console.log(`${questions.length} questions -> ${picked.length} candidate pairs written to ${out}`);
console.log('Now fill is_duplicate with 1 (same doubt) or 0 (different doubt) for every row, save as CSV, then:');
console.log(`  node eval/evaluate.js ${out}`);
console.log('Aim for roughly a third to a half of the pairs being duplicates. If you have far fewer,');
console.log('add a few paraphrases you write yourself (and note in your write-up which pairs those are).');